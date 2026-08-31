import YAML from "yaml";
import type { AppSettings, WorkflowCurrent, WorkflowDocument, WorkflowPhase } from "../../src/shared/contracts.js";
import { WslBridge } from "./wsl.js";

function quote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }

export class WorkflowStore {
  constructor(private readonly bridge: WslBridge) {}

  async list(settings: AppSettings): Promise<WorkflowDocument[]> {
    const { piCadRepo } = await this.bridge.resolveRuntimePaths(settings);
    const root = `${piCadRepo}/workflow-packages`;
    const { stdout } = await this.bridge.exec(["bash", "-lc", `find ${quote(root)} -type f -name '*.yaml' -print0 | sort -z | xargs -0 -r -n1 printf '%s\\n'`]);
    const paths = stdout.split("\n").map((item) => item.trim()).filter(Boolean);
    return Promise.all(paths.map(async (path) => this.read(path)));
  }

  async current(settings: AppSettings): Promise<WorkflowCurrent> {
    const { projectPath } = await this.bridge.resolveRuntimePaths(settings);
    if (!projectPath) return { authoritative: false };
    const script = "const fs=require('fs'),p=process.argv[1];try{const x=JSON.parse(fs.readFileSync(p,'utf8')),r=x.run||{};process.stdout.write(JSON.stringify({workflowId:r.workflowId,runId:r.id,phase:r.phase,status:r.status,updatedAt:r.updatedAt,authoritative:false}))}catch{process.stdout.write(JSON.stringify({authoritative:false}))}";
    const { stdout } = await this.bridge.exec([await this.bridge.commandPath("node"), "-e", script, `${projectPath}/.pi-cad/status.json`]);
    return JSON.parse(stdout || "{\"authoritative\":false}") as WorkflowCurrent;
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
    if (!document.sourcePath || !document.raw) throw new Error("Workflow source path and YAML are required.");
    const parsed = YAML.parse(document.raw) as any;
    if (!parsed?.workflow?.phases || !parsed.id || !parsed.version) throw new Error("Workflow YAML must define id, version, and workflow.phases.");
    const { piCadRepo } = await this.bridge.resolveRuntimePaths(settings);
    if (!document.sourcePath.startsWith(`${piCadRepo}/workflow-packages/`)) throw new Error("Workflow path escapes the package directory.");
    await this.bridge.pipe(["tee", document.sourcePath], document.raw);
    return this.read(document.sourcePath);
  }
}
