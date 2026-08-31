#!/usr/bin/env node

import { createInterface } from "node:readline";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [primeArg, agentDirArg] = process.argv.slice(2);
if (!primeArg || !agentDirArg) throw new Error("usage: desktop-openai-oauth.mjs <prime-repo> <agent-dir>");

const prime = resolve(primeArg);
const agentDir = resolve(agentDirArg);
process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;

const { loginOpenAICodex } = await import(pathToFileURL(join(prime, "packages/ai/dist/oauth.js")));
const input = createInterface({ input: process.stdin, terminal: false });
const manualValues = [];
const manualWaiters = [];

function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
input.on("line", (line) => {
  let value = line;
  try { value = JSON.parse(line).value ?? ""; } catch {}
  const waiter = manualWaiters.shift();
  if (waiter) waiter(String(value)); else manualValues.push(String(value));
});
function manualCode() {
  const value = manualValues.shift();
  if (value !== undefined) return Promise.resolve(value);
  return new Promise((resolveValue) => manualWaiters.push(resolveValue));
}

try {
  const credentials = await loginOpenAICodex({
    onAuth: ({ url, instructions }) => emit({ type: "auth_url", url, instructions }),
    onPrompt: async ({ message, placeholder }) => {
      emit({ type: "auth_input", message, placeholder });
      return manualCode();
    },
    onProgress: (message) => emit({ type: "auth_progress", message }),
    onManualCodeInput: manualCode,
    onSelect: async ({ message, options }) => {
      emit({ type: "auth_select", message, options });
      const selected = await manualCode();
      return options.some((option) => option.id === selected) ? selected : undefined;
    },
  });
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const authPath = join(agentDir, "auth.json");
  let current = {};
  try { current = JSON.parse(await readFile(authPath, "utf8")); } catch {}
  const temporary = `${authPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...current, "openai-codex": { type: "oauth", ...credentials } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, authPath);
  await chmod(authPath, 0o600);
  emit({ type: "auth_complete" });
} catch (error) {
  emit({ type: "auth_error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  input.close();
}
