import type { AppSettings, DistillationStatus, TraceSummary } from "../../src/shared/contracts.js";
import { WslBridge } from "./wsl.js";

export class TraceStore {
  constructor(private readonly bridge: WslBridge) {}

  async list(settings: AppSettings): Promise<TraceSummary[]> {
    const { projectPath } = await this.bridge.resolveRuntimePaths(settings);
    if (!projectPath) return [];
    const sessionRoot = `${projectPath}/.prime-sessions`;
    const script = `const fs=require('fs'),p=require('path'),root=process.argv[1];function walk(d,r=[]){if(!fs.existsSync(d))return r;for(const e of fs.readdirSync(d,{withFileTypes:true})){const q=p.join(d,e.name);if(e.isDirectory())walk(q,r);else if(e.name.endsWith('.jsonl'))r.push(q)}return r}for(const q of walk(root)){const raw=fs.readFileSync(q,'utf8').trim().split(/\\r?\\n/).filter(Boolean);let model='',tools=0,tokens=0,title=p.basename(q,'.jsonl');for(const l of raw){try{const x=JSON.parse(l),m=x.message;if(x.type==='session'&&x.name)title=x.name;if(m?.role==='toolResult')tools++;if(m?.role==='assistant'){model||=m.provider&&m.model?m.provider+'/'+m.model:'';tokens+=(m.usage?.input||0)+(m.usage?.output||0)}}catch{}}const s=fs.statSync(q);console.log(JSON.stringify({id:p.basename(q,'.jsonl'),path:q,title,updatedAt:s.mtimeMs,model,turns:raw.length,toolCalls:tools,tokens}))}`;
    const { stdout } = await this.bridge.exec([await this.bridge.commandPath("node"), "-e", script, sessionRoot], { timeout: 60_000 });
    return stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as TraceSummary).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async read(path: string): Promise<unknown[]> {
    const { stdout } = await this.bridge.exec(["cat", path], { timeout: 60_000 });
    return stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  async distill(settings: AppSettings, paths: string[], evaluation: { quality: number; difficulty: number }, onStatus: (value: DistillationStatus) => void): Promise<DistillationStatus> {
    if (!paths.length) throw new Error("Select at least one trajectory.");
    const { piCadRepo, primeAgentRepo } = await this.bridge.resolveRuntimePaths(settings);
    const state: DistillationStatus = { state: "running", processed: 0, total: paths.length, message: "Preparing selected trajectories…" };
    onStatus(state);
    const { projectPath } = await this.bridge.resolveRuntimePaths(settings);
    const child = this.bridge.spawn([await this.bridge.commandPath("node"), `${piCadRepo}/scripts/desktop-experience.mjs`, projectPath, primeAgentRepo, String(evaluation.quality), String(evaluation.difficulty), ...paths]);
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
