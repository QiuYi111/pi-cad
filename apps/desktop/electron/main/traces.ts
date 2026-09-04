import type { AppSettings, DistillationStatus, RatingStatus, TraceSummary } from "../../src/shared/contracts.js";
import type { RuntimeBridge } from "./runtime-bridge.js";

export function desktopDistillationEnvironment(
  settings: Pick<AppSettings, "provider" | "model" | "thinking">,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    `PI_CAD_DISTILL_PROVIDER=${environment.PI_CAD_DISTILL_PROVIDER || settings.provider}`,
    `PI_CAD_DISTILL_MODEL=${environment.PI_CAD_DISTILL_MODEL || settings.model}`,
    `PI_CAD_DISTILL_THINKING=${environment.PI_CAD_DISTILL_THINKING || settings.thinking}`,
  ];
}

export function desktopDistillationPath(node: string): string {
  const separator = node.lastIndexOf("/");
  const nodeDirectory = separator > 0 ? node.slice(0, separator) : "/usr/bin";
  return `PATH=${nodeDirectory}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
}

export class TraceStore {
  constructor(private readonly bridge: RuntimeBridge) {}

  async list(settings: AppSettings): Promise<TraceSummary[]> {
    const { projectPath } = await this.bridge.resolveRuntimePaths(settings);
    if (!projectPath) return [];
    const sessionRoot = `${projectPath}/.prime-sessions`;
    const script = `const fs=require('fs'),p=require('path'),root=process.argv[1];function walk(d,r=[]){if(!fs.existsSync(d))return r;for(const e of fs.readdirSync(d,{withFileTypes:true})){const q=p.join(d,e.name);if(e.isDirectory())walk(q,r);else if(e.name.endsWith('.jsonl'))r.push(q)}return r}for(const q of walk(root)){const raw=fs.readFileSync(q,'utf8').trim().split(/\\r?\\n/).filter(Boolean);let model='',tools=0,tokens=0,title=p.basename(q,'.jsonl');for(const l of raw){try{const x=JSON.parse(l),m=x.message;if((x.type==='session_info'||x.type==='session')&&x.name)title=x.name;if(m?.role==='toolResult')tools++;if(m?.role==='assistant'){model||=m.provider&&m.model?m.provider+'/'+m.model:'';tokens+=(m.usage?.input||0)+(m.usage?.output||0)}}catch{}}const s=fs.statSync(q);console.log(JSON.stringify({id:p.basename(q,'.jsonl'),path:q,title,updatedAt:s.mtimeMs,model,turns:raw.length,toolCalls:tools,tokens}))}`;
    const { stdout } = await this.bridge.exec([await this.bridge.commandPath("node"), "-e", script, sessionRoot], { timeout: 60_000 });
    const traces = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as TraceSummary);
    const home = await this.bridge.homeDirectory();
    const experienceRoot = process.env.PI_CAD_EXPERIENCE_ROOT || `${home}/.cad/transcripts`;
    let evaluations: Array<{ session_path: string; quality: number | null; difficulty: number | null; feedback?: string | null }> = [];
    try {
      const { stdout: raw } = await this.bridge.exec(["cat", `${experienceRoot}/index.jsonl`], { timeout: 10_000 });
      evaluations = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {}
    const bySession = new Map(evaluations.filter((item) => item.quality !== null && item.difficulty !== null).map((item) => [item.session_path, item]));
    return traces.map((trace) => {
      const rating = bySession.get(trace.path);
      return rating ? { ...trace, evaluation: { quality: rating.quality!, difficulty: rating.difficulty!, feedback: rating.feedback } } : trace;
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async sessionPath(settings: AppSettings, path: string): Promise<string> {
    const { projectPath } = await this.bridge.resolveRuntimePaths(settings);
    const root = `${projectPath}/.prime-sessions/`;
    if (!projectPath || !path.startsWith(root) || !path.endsWith(".jsonl") || path.includes("/../")) throw new Error("Trajectory path escapes the active project.");
    const [{ stdout: canonicalRoot }, { stdout: canonicalPath }] = await Promise.all([
      this.bridge.exec(["realpath", "-e", root]),
      this.bridge.exec(["realpath", "-e", "--", path]),
    ]);
    const confinedRoot = `${canonicalRoot.trim()}/`;
    const confinedPath = canonicalPath.trim();
    if (!confinedPath.startsWith(confinedRoot) || !confinedPath.endsWith(".jsonl")) throw new Error("Trajectory path escapes the active project.");
    return confinedPath;
  }

  async read(settings: AppSettings, path: string): Promise<unknown[]> {
    path = await this.sessionPath(settings, path);
    const { stdout } = await this.bridge.exec(["cat", path], { timeout: 60_000 });
    return stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  async rate(settings: AppSettings, paths: string[], evaluation: { quality: number; difficulty: number; feedback?: string }): Promise<RatingStatus> {
    if (!paths.length) throw new Error("Select at least one trajectory.");
    paths = await Promise.all(paths.map((path) => this.sessionPath(settings, path)));
    const { piCadRepo, primeAgentRepo, projectPath } = await this.bridge.resolveRuntimePaths(settings);
    const node = await this.bridge.commandPath("node");
    const { stdout } = await this.bridge.exec([
      "env", desktopDistillationPath(node), ...desktopDistillationEnvironment(settings),
      node, `${piCadRepo}/scripts/desktop-rate-experience.mjs`,
      projectPath, primeAgentRepo, String(evaluation.quality), String(evaluation.difficulty), evaluation.feedback || "", ...paths,
    ], { timeout: 15 * 60_000 });
    return JSON.parse(stdout.trim().split("\n").at(-1) || "{}");
  }

  async distill(settings: AppSettings, paths: string[], evaluation: { quality: number; difficulty: number }, onStatus: (value: DistillationStatus) => void): Promise<DistillationStatus> {
    if (!paths.length) throw new Error("Select at least one trajectory.");
    paths = await Promise.all(paths.map((path) => this.sessionPath(settings, path)));
    const { piCadRepo, primeAgentRepo } = await this.bridge.resolveRuntimePaths(settings);
    const state: DistillationStatus = { state: "running", processed: 0, total: paths.length, message: "Preparing selected trajectories…" };
    onStatus(state);
    const { projectPath } = await this.bridge.resolveRuntimePaths(settings);
    const node = await this.bridge.commandPath("node");
    const child = this.bridge.spawn([
      "env", desktopDistillationPath(node), ...desktopDistillationEnvironment(settings),
      node, `${piCadRepo}/scripts/desktop-experience.mjs`, projectPath, primeAgentRepo,
      String(evaluation.quality), String(evaluation.difficulty), ...paths,
    ]);
    let buffer = "";
    let last = state;
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        try { last = JSON.parse(line) as DistillationStatus; onStatus(last); } catch {}
      }
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    await new Promise<void>((accept, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? accept() : reject(new Error(stderr.trim() || `Distillation exited with code ${code}`)));
    });
    return last;
  }
}
