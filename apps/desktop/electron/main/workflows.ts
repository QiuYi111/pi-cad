import YAML from "yaml";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { userInfo } from "node:os";
import type { AppSettings, WorkflowAdoptionPolicy, WorkflowCurrent, WorkflowDocument, WorkflowPhase } from "../../src/shared/contracts.js";
import type { RuntimeBridge } from "./runtime-bridge.js";

function quote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }

export class WorkflowStore {
  constructor(private readonly bridge: RuntimeBridge, private readonly identity = userInfo().username) {}

  async adoptionPolicy(settings: AppSettings): Promise<WorkflowAdoptionPolicy> {
    const { projectPath } = await this.bridge.resolveRuntimePaths(settings);
    if (!projectPath) return { schema: 1, globalSafetyPolicyVersion: "builtin-current", adopted: {}, history: [] };
    const path = `${projectPath}/.pi-cad/admin/workflow-adoptions.json`;
    try { return JSON.parse((await this.bridge.exec(["cat", "--", path])).stdout) as WorkflowAdoptionPolicy; }
    catch (error) {
      try { await this.bridge.exec(["test", "!", "-e", path]); }
      catch { throw error; }
      return { schema: 1, globalSafetyPolicyVersion: "builtin-current", adopted: {}, history: [] };
    }
  }

  async list(settings: AppSettings): Promise<WorkflowDocument[]> {
    const { piCadRepo, projectPath } = await this.bridge.resolveRuntimePaths(settings);
    const roots = [`${piCadRepo}/workflow-packages`, ...(projectPath ? [`${projectPath}/workflows`] : [])];
    const { stdout } = await this.bridge.exec(["bash", "-lc", `find ${roots.map(quote).join(" ")} -type f -name '*.yaml' -print0 2>/dev/null | sort -z | xargs -0 -r -n1 printf '%s\\n'`]);
    const paths = stdout.split("\n").map((item) => item.trim()).filter(Boolean);
    const [documents, policy] = await Promise.all([Promise.all(paths.map(async (path) => this.read(path))), this.adoptionPolicy(settings)]);
    const counts = new Map<string, number>(); for (const item of documents) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
    return documents.map((item) => ({ ...item, adopted: policy.adopted[item.id]?.version === item.version || (!policy.adopted[item.id] && counts.get(item.id) === 1) }));
  }

  async adopt(settings: AppSettings, id: string, version: string): Promise<WorkflowAdoptionPolicy> {
    const installed = await this.list(settings);
    if (!installed.some((item) => item.id === id && item.version === version)) throw new Error(`Workflow package is not installed: ${id}@${version}`);
    const { projectPath } = await this.bridge.resolveRuntimePaths(settings); if (!projectPath) throw new Error("Choose a project before adopting a workflow version.");
    const current = await this.adoptionPolicy(settings); const adoptedAt = new Date().toISOString(); const from = current.adopted[id]?.version;
    const next: WorkflowAdoptionPolicy = { ...current, adopted: { ...current.adopted, [id]: { version, adoptedBy: this.identity, adoptedAt } }, history: [...current.history, { id, ...(from ? { from } : {}), to: version, adoptedBy: this.identity, adoptedAt }] };
    const directory = `${projectPath}/.pi-cad/admin`; const target = `${directory}/workflow-adoptions.json`; const temporary = `${target}.${process.pid}.tmp`;
    await this.bridge.exec(["mkdir", "-p", directory]); await this.bridge.exec(["tee", temporary], { input: `${JSON.stringify(next, null, 2)}\n` }); await this.bridge.exec(["chmod", "600", temporary]); await this.bridge.exec(["mv", "--", temporary, target]);
    return next;
  }

  async current(settings: AppSettings): Promise<WorkflowCurrent> {
    const projectPath = settings.projectPath;
    if (!projectPath) return { authoritative: false, phaseHistory: [], phases: [] };
    try {
      const nativePath = await this.bridge.revealPath(projectPath);
      const state = JSON.parse(await readFile(join(nativePath, ".pi-cad", "status.json"), "utf8")) as any;
      const run = state.run || {};
      return {
        workflowId: run.workflowId, workflowVersion: run.workflowVersion, workflowHash: run.workflowHash, runId: run.id,
        phase: run.phase, status: run.status, updatedAt: run.updatedAt,
        phaseHistory: Array.isArray(run.phaseHistory) ? run.phaseHistory : [],
        phases: Array.isArray(run.phases) ? run.phases : [], authoritative: false,
      };
    } catch { return { authoritative: false, phaseHistory: [], phases: [] }; }
  }

  private async read(path: string): Promise<WorkflowDocument> {
    const { stdout } = await this.bridge.exec(["cat", path]);
    const value = YAML.parse(stdout) as any;
    const sourcePhases = value.workflow?.phases || {};
    const initial = value.workflow?.initialPhase;
    const phases: WorkflowPhase[] = Object.entries(sourcePhases).map(([id, phaseValue], index) => {
      const phase = phaseValue as any;
      return {
        id,
        title: id.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
        purpose: phase.purpose || "",
        status: id === initial ? "active" : index < Object.keys(sourcePhases).indexOf(initial) ? "complete" : "pending",
        transitions: Object.entries(phase.transitions || {}).map(([event, transition]) => ({ event, target: (transition as any).target })),
        capabilities: [...(phase.actions || [])],
        obligations: [...(phase.recordObligations || []), ...(phase.evidenceObligations || [])].map((item: any) => item.ref),
      };
    });
    return {
      id: value.id || value.workflow?.id,
      version: String(value.version || value.workflow?.version || "1.0.0"),
      description: value.description || "",
      sourcePath: path,
      phases,
      raw: stdout,
    };
  }

  async save(settings: AppSettings, document: WorkflowDocument): Promise<WorkflowDocument> {
    if (!document.raw) throw new Error("Workflow YAML is required.");
    const parsed = YAML.parse(document.raw) as any;
    if (!parsed?.workflow?.phases || !parsed.id || !parsed.version) throw new Error("Workflow YAML must define id, version, and workflow.phases.");
    const { piCadRepo, projectPath } = await this.bridge.resolveRuntimePaths(settings);
    if (!projectPath && !document.sourcePath) throw new Error("Choose a project before creating a workflow.");
    const node = await this.bridge.commandPath("node");
    await this.bridge.pipe([node, `${piCadRepo}/scripts/desktop-validate-workflow.mjs`], document.raw, 60_000);
    const allowedRoots = [`${piCadRepo}/workflow-packages`, ...(projectPath ? [`${projectPath}/workflows`] : [])];
    let path: string;
    if (document.sourcePath) {
      const canonicalRoots = await Promise.all(allowedRoots.map(async (root) => {
        try { return (await this.bridge.exec(["realpath", "-e", root])).stdout.trim(); } catch { return ""; }
      }));
      const canonicalPath = (await this.bridge.exec(["realpath", "-e", "--", document.sourcePath])).stdout.trim();
      if (!canonicalRoots.some((root) => root && canonicalPath.startsWith(`${root}/`))) throw new Error("Workflow path escapes the package directory.");
      path = canonicalPath;
    } else {
      if (!/^[a-z][a-z0-9_]*(?:[.:/-][a-z0-9_]+)*$/.test(parsed.id)) throw new Error("Workflow id is invalid.");
      const root = `${projectPath}/workflows`;
      await this.bridge.exec(["mkdir", "-p", root]);
      const canonicalRoot = (await this.bridge.exec(["realpath", "-e", root])).stdout.trim();
      path = `${canonicalRoot}/${String(parsed.id).replace(/[/:]/g, "-")}.yaml`;
      try { await this.bridge.exec(["test", "!", "-e", path]); }
      catch { throw new Error(`Workflow already exists: ${parsed.id}`); }
    }
    const atomicWrite = "const fs=require('fs'),p=process.argv[1],t=p+'.'+process.pid+'.tmp';let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.writeFileSync(t,s,{mode:0o644});fs.renameSync(t,p)})";
    await this.bridge.pipe([node, "-e", atomicWrite, path], document.raw);
    return this.read(path);
  }
}
