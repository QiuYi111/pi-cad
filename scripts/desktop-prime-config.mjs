#!/usr/bin/env node

import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [primeArg, agentDirArg, cwdArg, command] = process.argv.slice(2);
if (!primeArg || !agentDirArg || !command) throw new Error("usage: desktop-prime-config.mjs <prime-repo> <agent-dir> <cwd> <command>");

const prime = resolve(primeArg);
const agentDir = resolve(agentDirArg);
const cwd = resolve(cwdArg || process.cwd());
process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;

const input = await new Promise((done, fail) => {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    try { done(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
    catch (error) { fail(error); }
  });
});

const coding = await import(pathToFileURL(join(prime, "packages/coding-agent/dist/index.js")));
const modelsApi = await import(pathToFileURL(join(prime, "packages/ai/dist/models.js")));
const displayApi = await import(pathToFileURL(join(prime, "packages/coding-agent/dist/core/provider-display-names.js")));
const authPath = join(agentDir, "auth.json");
const modelsPath = join(agentDir, "models.json");
const auth = coding.AuthStorage.create(authPath);
const registry = coding.ModelRegistry.create(auth, modelsPath);
const authView = (provider) => {
  const status = auth.getAuthStatus(provider);
  return {
    provider,
    configured: status.configured,
    source: status.source,
    state: status.configured && status.source !== "stale" ? "signed-in" : "signed-out",
    message: status.configured ? (status.label || `Connected via ${status.source || "stored credentials"}`) : "Not configured",
  };
};

const providerName = (id) => displayApi.BUILT_IN_PROVIDER_DISPLAY_NAMES?.[id]
  || id.split(/[-_]/).map((word) => word ? word[0].toUpperCase() + word.slice(1) : word).join(" ");
const safeModel = (model, available) => ({
  provider: model.provider,
  id: model.id,
  name: model.name || model.id,
  reasoning: Boolean(model.reasoning),
  thinkingLevels: modelsApi.getSupportedThinkingLevels(model),
  input: Array.isArray(model.input) ? model.input : ["text"],
  contextWindow: model.contextWindow,
  maxTokens: model.maxTokens,
  available: available.has(`${model.provider}/${model.id}`),
});
const settingsPath = join(agentDir, "settings.json");
async function readSettings() {
  try { return JSON.parse(await readFile(settingsPath, "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}
function parseFavorite(pattern) {
  const slash = pattern.indexOf("/");
  if (slash < 1 || /[*?[\]]/.test(pattern)) return { pattern };
  const provider = pattern.slice(0, slash);
  let modelId = pattern.slice(slash + 1);
  let thinkingLevel;
  const colon = modelId.lastIndexOf(":");
  if (colon > 0 && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(modelId.slice(colon + 1))) {
    thinkingLevel = modelId.slice(colon + 1);
    modelId = modelId.slice(0, colon);
  }
  return { provider, modelId, thinkingLevel };
}

let result;
if (command === "catalog") {
  const all = registry.getAll();
  const available = new Set(registry.getAvailable().map((model) => `${model.provider}/${model.id}`));
  const oauth = new Map(auth.getOAuthProviders().map((provider) => [provider.id, provider.name]));
  const grouped = new Map();
  for (const model of all) {
    if (!grouped.has(model.provider)) grouped.set(model.provider, []);
    grouped.get(model.provider).push(safeModel(model, available));
  }
  const settings = await readSettings();
  result = {
    providers: [...grouped].map(([id, models]) => ({
      id, name: oauth.get(id) || providerName(id), oauth: oauth.has(id), auth: authView(id), models,
    })).sort((a, b) => a.name.localeCompare(b.name)),
    favorites: (settings.enabledModels || []).map(parseFavorite),
    defaults: {
      provider: settings.defaultProvider,
      modelId: settings.defaultModel,
      thinkingLevel: settings.defaultThinkingLevel,
    },
  };
} else if (command === "status") {
  result = authView(input.provider);
} else if (command === "set-api-key") {
  if (!input.provider || typeof input.key !== "string" || !input.key.trim()) throw new Error("Provider and API key are required.");
  auth.set(input.provider, { type: "api_key", key: input.key.trim() });
  registry.refresh();
  result = authView(input.provider);
} else if (command === "logout") {
  if (!input.provider) throw new Error("Provider is required.");
  auth.logout(input.provider);
  registry.refresh();
  result = authView(input.provider);
} else if (command === "save-favorites") {
  if (!Array.isArray(input.models)) throw new Error("Models must be an array.");
  const settings = await readSettings();
  settings.enabledModels = input.models.map((item) => {
    if (!item.provider || !item.modelId) throw new Error("Each favorite needs provider and modelId.");
    const model = registry.find(item.provider, item.modelId);
    if (!model) throw new Error(`Unknown model: ${item.provider}/${item.modelId}`);
    const levels = modelsApi.getSupportedThinkingLevels(model);
    if (item.thinkingLevel && !levels.includes(item.thinkingLevel)) throw new Error(`Unsupported thinking level for ${item.provider}/${item.modelId}`);
    return `${item.provider}/${item.modelId}${item.thinkingLevel ? `:${item.thinkingLevel}` : ""}`;
  });
  await writeJson(settingsPath, settings);
  result = { favorites: settings.enabledModels.map(parseFavorite) };
} else if (command === "save-default") {
  const model = registry.find(input.provider, input.modelId);
  if (!model) throw new Error(`Unknown model: ${input.provider}/${input.modelId}`);
  const levels = modelsApi.getSupportedThinkingLevels(model);
  if (!levels.includes(input.thinkingLevel)) throw new Error(`Unsupported thinking level for ${input.provider}/${input.modelId}`);
  if (!auth.hasAuth(input.provider)) throw new Error(`Configure ${providerName(input.provider)} before making it the default.`);
  const settings = await readSettings();
  settings.defaultProvider = input.provider;
  settings.defaultModel = input.modelId;
  settings.defaultThinkingLevel = input.thinkingLevel;
  await writeJson(settingsPath, settings);
  result = { provider: input.provider, modelId: input.modelId, thinkingLevel: input.thinkingLevel };
} else if (command === "read-models-config") {
  try { result = { text: await readFile(modelsPath, "utf8") }; }
  catch (error) { if (error?.code === "ENOENT") result = { text: "{\n  \"providers\": {}\n}\n" }; else throw error; }
} else if (command === "write-models-config") {
  const parsed = JSON.parse(input.text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("models.json must contain an object.");
  const validationPath = `${modelsPath}.${process.pid}.validate`;
  await writeJson(validationPath, parsed);
  const validationRegistry = coding.ModelRegistry.create(auth, validationPath);
  const validationError = validationRegistry.getError?.();
  await unlink(validationPath).catch(() => undefined);
  if (validationError) throw new Error(validationError);
  await writeJson(modelsPath, parsed);
  registry.refresh();
  result = { text: `${JSON.stringify(parsed, null, 2)}\n` };
} else {
  throw new Error(`Unknown command: ${command}`);
}

process.stdout.write(`${JSON.stringify(result)}\n`);
