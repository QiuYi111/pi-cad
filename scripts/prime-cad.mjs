import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const repository = realpathSync(resolve(import.meta.dirname, ".."));
const projectCwd = resolve(process.env.PI_CAD_PROJECT_CWD ?? process.cwd());
const primeAgentDir = resolve(process.env.PRIME_AGENT_CODING_AGENT_DIR ?? resolve(homedir(), ".prime/agent"));
const primeSessionDir = resolve(process.env.PRIME_AGENT_SESSION_DIR ?? resolve(primeAgentDir, "sessions"));
const primeKernelVenv = resolve(process.env.PRIME_AGENT_KERNEL_VENV ?? resolve(primeAgentDir, "kernel-venv"));
const primeCandidate = resolve(process.env.PRIME_AGENT_REPO ?? resolve(repository, "../prime-agent"));
let primeRoot;
try {
  primeRoot = realpathSync(primeCandidate);
} catch {
  throw new Error(`Prime Agent repository does not exist: ${primeCandidate}. Set PRIME_AGENT_REPO to its checkout path.`);
}
if (!existsSync(resolve(primeRoot, "prime-agent.sh"))) {
  throw new Error(`Prime Agent repository is missing prime-agent.sh: ${primeRoot}`);
}

mkdirSync(primeAgentDir, { recursive: true });
mkdirSync(primeSessionDir, { recursive: true });
writeFileSync(resolve(primeAgentDir, "prime-cad.json"), `${JSON.stringify({ primeAgentRepo: primeRoot }, null, 2)}\n`, { mode: 0o600 });

const args = [
  "--cwd", projectCwd,
  "--no-extensions",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--tools", "ipython,codex_generate_image",
  "--extension", resolve(repository, "src/integrations/prime/extension.ts"),
  "--extension", resolve(repository, "packages/prime-codex-image-gen/index.ts"),
  "--skill", resolve(repository, "skills/cad/SKILL.md"),
  "--skill", resolve(repository, "packages/prime-codex-image-gen/skills/imagegen/SKILL.md"),
  ...process.argv.slice(2),
];

const child = spawn(resolve(primeRoot, "prime-agent.sh"), args, {
  cwd: repository,
  stdio: "inherit",
  env: {
    ...process.env,
    PI_CAD_REPO: repository,
    PI_CAD_PROJECT_CWD: projectCwd,
    PRIME_AGENT_REPO: primeRoot,
    PRIME_AGENT_CODING_AGENT_DIR: primeAgentDir,
    PRIME_AGENT_SESSION_DIR: primeSessionDir,
    PRIME_AGENT_KERNEL_VENV: primeKernelVenv,
    PI_OFFLINE: process.env.PI_OFFLINE ?? "1",
    PYTHONDONTWRITEBYTECODE: process.env.PYTHONDONTWRITEBYTECODE ?? "1",
  },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
