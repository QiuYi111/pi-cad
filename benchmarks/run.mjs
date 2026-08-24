import { spawn, execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BENCH_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO = process.env.PI_CAD_REPO ?? resolve(BENCH_DIR, "..");
const MODEL = process.env.PI_CAD_MODEL ?? "gpt-5.6-luna";
const PROVIDER = process.env.PI_CAD_PROVIDER ?? "openai-codex";
const THINKING = process.env.PI_CAD_THINKING ?? "medium";
const TIMEOUT_MS = Number(process.env.PI_CAD_TIMEOUT_MS ?? 600_000);
const RETRIES = Number(process.env.PI_CAD_RETRIES ?? 1);
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(REPO, ".pi-agent");

if (process.platform !== "linux") throw new Error("Pi-CAD benchmarks must run inside Linux or WSL");

function cadctl(args, workdir) {
  execFileSync(process.env.PI_CAD_UV ?? "uv", ["run", "--project", join(REPO, "python"), "python", "-m", "cadctl", ...args], { cwd: workdir, stdio: "pipe" });
}

const args = process.argv.slice(2);
function argValue(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}
const tasks = (argValue("tasks") ?? "quick-plate").split(",").map((s) => s.trim()).filter(Boolean);
const configs = (argValue("configs") ?? "bare,cad-skill,pi-cad").split(",").map((s) => s.trim()).filter(Boolean);

const corpus = JSON.parse(readFileSync(join(BENCH_DIR, "corpus.json"), "utf-8"));
const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const resultsDir = join(BENCH_DIR, "results", runId);
mkdirSync(resultsDir, { recursive: true });

function ensurePlateStep(workdir) {
  const step = join(workdir, "plate.step");
  if (!existsSync(step)) {
    cadctl(["build", "--source", join(REPO, "tests", "fixtures", "plate.py"), "--output", step], workdir);
  }
  return step;
}

function prepareWorkdir(taskName, config, attempt = 0) {
  const dir = join(resultsDir, taskName, config, `attempt-${attempt}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const task = corpus[taskName];
  for (const fixture of task.fixtures ?? []) {
    if (fixture === "plate.step") {
      const step = ensurePlateStep(join(resultsDir, "_fixtures"));
      copyFileSync(step, join(dir, "plate.step"));
    } else if (fixture === "old_plate.step") {
      const step = ensurePlateStep(join(resultsDir, "_fixtures"));
      copyFileSync(step, join(dir, "old_plate.step"));
    } else if (existsSync(join(BENCH_DIR, "fixtures", fixture))) {
      copyFileSync(join(BENCH_DIR, "fixtures", fixture), join(dir, fixture));
    }
  }
  if (config === "cad-skill") {
    const source = join(REPO, "ref", "cad-skill");
    const dest = join(dir, "skill", "cad");
    if (!existsSync(dest)) cpSync(source, dest, { recursive: true, force: true });
  }
  return dir;
}

function configArgs(config, workdir, prompt) {
  const common = [
    "-p",
    "--provider", PROVIDER,
    "--model", MODEL,
    "--thinking", THINKING,
    "--no-skills",
    "--no-themes",
    "--session-id", `${config}-${basename(workdir)}`,
  ];
  if (config === "bare") {
    return [...common, "--no-extensions", prompt];
  }
  if (config === "cad-skill") {
    return [...common, "--skill", join(workdir, "skill", "cad"), prompt];
  }
  if (config === "pi-cad") {
    const ext = (name) => join(REPO, "src", "extensions", name, "index.ts");
    return [
      ...common,
      "-e", ext("core"),
      "-e", ext("geometry"),
      "-e", ext("visual"),
      "-e", ext("ui"),
      prompt,
    ];
  }
  throw new Error(`unknown config ${config}`);
}

function envFor(config, workdir) {
  const pythonPaths = [];
  if (config === "bare" || config === "cad-skill") {
    pythonPaths.push(join(REPO, ".python", "site-packages"));
  }
  if (config === "cad-skill") {
    pythonPaths.push(join(workdir, "skill", "cad", "scripts", "packages", "cadpy", "src"));
  }
  const old = process.env.PYTHONPATH;
  return {
    ...process.env,
    PI_CODING_AGENT_DIR: AGENT_DIR,
    PI_CODING_AGENT_SESSION_DIR: join(workdir, ".sessions"),
    ...(pythonPaths.length ? { PYTHONPATH: [...pythonPaths, old ?? ""].filter(Boolean).join(":") } : {}),
  };
}

function runPi(config, workdir, prompt) {
  return new Promise((resolveRun) => {
    const child = spawn("pi", configArgs(config, workdir, prompt), {
      cwd: workdir,
      env: envFor(config, workdir),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

function sessionMetrics(workdir, sessionIdPrefix) {
  const dir = join(workdir, ".sessions");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && f.includes(sessionIdPrefix));
  if (files.length === 0) return null;
  const path = join(dir, files[files.length - 1]);
  let tokens = 0;
  let toolCalls = 0;
  let userTurns = 0;
  let assistantTurns = 0;
  let errors = 0;
  let candidateCommits = 0;
  let buildToolCalls = 0;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== "message") continue;
    const msg = entry.message ?? {};
    if (msg.role === "user") userTurns += 1;
    if (msg.role === "assistant") {
      assistantTurns += 1;
      tokens += msg.usage?.totalTokens ?? 0;
      if (msg.stopReason === "error" || msg.errorMessage) errors += 1;
      for (const part of msg.content ?? []) {
        const type = part.type ?? "";
        if (type === "toolCall" || type === "tool_call" || type.endsWith("ToolCall")) {
          toolCalls += 1;
          if (part.name === "cad_commit_candidate") candidateCommits += 1;
          if (part.name === "cad_build_step") buildToolCalls += 1;
        }
        if (type === "toolResult" || type === "tool_result" || type.endsWith("ToolResult")) {
          if (part.isError || part.state === "output-error") errors += 1;
        }
      }
    }
  }
  return { tokens, toolCalls, userTurns, assistantTurns, errors, candidateCommits, buildToolCalls, session: path };
}

function expectedFound(task, workdir) {
  const missing = (task.expected ?? []).filter((p) => !existsSync(join(workdir, p)));
  return missing.length === 0 ? [] : missing;
}

function piCadDone(workdir) {
  const projectPath = join(workdir, ".pi-cad", "project.json");
  if (!existsSync(projectPath)) return false;
  try {
    const project = JSON.parse(readFileSync(projectPath, "utf-8"));
    if (project.currentRunId) return false;
    const runsDir = join(workdir, ".pi-cad", "runs");
    const names = readdirSync(runsDir);
    return names.some((name) => {
      const statePath = join(runsDir, name, "state.json");
      if (!existsSync(statePath)) return false;
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      return state.phase === "done" && state.status === "done";
    });
  } catch {
    return false;
  }
}

function shouldRetry(run, metrics) {
  if (RETRIES <= 1) return false;
  if (run.code !== 0) return true;
  const text = `${run.stdout}\n${run.stderr}`;
  if (/fetch failed|WebSocket error|provider_transport_failure/i.test(text)) return true;
  if (metrics && metrics.assistantTurns > 0 && metrics.errors === metrics.assistantTurns) return true;
  return false;
}

const summary = [];
for (const taskName of tasks) {
  const task = corpus[taskName];
  if (!task) throw new Error(`unknown task ${taskName}`);
  for (const config of configs) {
    let attempt = 0;
    let result = null;
    let metrics = null;
    for (; attempt < RETRIES; attempt += 1) {
      const workdir = prepareWorkdir(taskName, config, attempt);
      const started = Date.now();
      result = await runPi(config, workdir, task.prompt);
      const wallMs = Date.now() - started;
      metrics = sessionMetrics(workdir, `${config}-attempt-${attempt}`);
      writeFileSync(
        join(workdir, "run.json"),
        JSON.stringify({ task: taskName, config, attempt, started: new Date(started).toISOString(), wallMs, ...result, metrics }, null, 2),
      );
      if (!shouldRetry(result, metrics)) break;
    }
    const workdir = join(resultsDir, taskName, config, `attempt-${Math.max(attempt - 1, 0)}`);
    const missing = expectedFound(task, workdir);
    const success = result?.code === 0 && missing.length === 0 && (config !== "pi-cad" || piCadDone(workdir));
    summary.push({
      task: taskName,
      config,
      success,
      exitCode: result?.code,
      wallMs: JSON.parse(readFileSync(join(workdir, "run.json"), "utf-8")).wallMs,
      metrics,
      missing,
      piCadPhase: config === "pi-cad"
        ? (() => {
            try {
              const project = JSON.parse(readFileSync(join(workdir, ".pi-cad", "project.json"), "utf-8"));
              const runId = project.currentRunId;
              if (!runId) return "idle";
              return JSON.parse(readFileSync(join(workdir, ".pi-cad", "runs", runId, "state.json"), "utf-8")).phase;
            } catch {
              return null;
            }
          })()
        : null,
    });
  }
}

writeFileSync(join(resultsDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ runId, resultsDir, summary }, null, 2));
