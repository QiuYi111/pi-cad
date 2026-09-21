#!/usr/bin/env node

import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [primeArg, agentDirArg, providerArg = "openai-codex"] = process.argv.slice(2);
if (!primeArg || !agentDirArg) throw new Error("usage: desktop-openai-oauth.mjs <prime-repo> <agent-dir> [provider]");

const prime = resolve(primeArg);
const agentDir = resolve(agentDirArg);
process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;

const { AuthStorage } = await import(pathToFileURL(join(prime, "packages/coding-agent/dist/index.js")));
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
  const auth = AuthStorage.create(join(agentDir, "auth.json"));
  if (!auth.getOAuthProviders().some((provider) => provider.id === providerArg)) throw new Error(`Provider does not support OAuth: ${providerArg}`);
  await auth.login(providerArg, {
    onAuth: ({ url, instructions }) => emit({ type: "auth_url", url, instructions }),
    onDeviceCode: ({ userCode, verificationUri }) => emit({ type: "auth_device_code", userCode, verificationUri }),
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
  emit({ type: "auth_complete", provider: providerArg });
} catch (error) {
  emit({ type: "auth_error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  input.close();
}
