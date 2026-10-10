import { ipcMain } from "electron";
import type { ModelFavorite, ModelSelection } from "../../../src/shared/contracts.js";
import { IPC } from "../../../src/shared/contracts.js";
import { authE2E } from "../desktop-e2e.js";
import type { MainServices } from "../services.js";

const demoCatalog = () => ({ providers: [
  { id: "openai-codex", name: "OpenAI Codex", oauth: true, auth: { provider: "openai-codex", state: "signed-in", configured: true, source: "stored", message: "ChatGPT connected" }, models: [
    { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true, thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"], input: ["text", "image"], available: true },
    { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", reasoning: true, thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"], input: ["text", "image"], available: true },
  ] },
  { id: "zai", name: "ZAI", oauth: false, auth: { provider: "zai", state: "signed-out", configured: false, message: "Not configured" }, models: [
    { provider: "zai", id: "glm-5.3", name: "GLM-5.3", reasoning: true, thinkingLevels: ["off", "minimal", "low", "medium", "high"], input: ["text"], available: false },
  ] },
], favorites: [{ provider: "openai-codex", modelId: "gpt-5.6-sol", thinkingLevel: "minimal" }, { provider: "openai-codex", modelId: "gpt-5.6-luna", thinkingLevel: "low" }], defaults: { provider: "openai-codex", modelId: "gpt-5.6-sol", thinkingLevel: "minimal" } });

/** Prime sign-in, model catalog, and favorites. Desktop E2E answers come from a fixed catalog. */
export function registerAuthIpc(s: MainServices) {
  ipcMain.handle(IPC.authCatalog, async () => {
    if (authE2E) return demoCatalog();
    await s.managedRuntimeBootstrap;
    return (await s.ensurePrimeConfig()).catalog(await s.settingsStore.get());
  });
  ipcMain.handle(IPC.authStatusGet, async (_event, provider: string) => authE2E ? demoCatalog().providers.find((item) => item.id === provider)?.auth : (await s.ensurePrimeConfig()).status(await s.settingsStore.get(), provider));
  ipcMain.handle(IPC.authSetApiKey, async (_event, provider: string, key: string) => authE2E ? { provider, state: "signed-in", configured: true, source: "stored", message: "Connected" } : (await s.ensurePrimeConfig()).setApiKey(await s.settingsStore.get(), provider, key));
  ipcMain.handle(IPC.authLogin, async (_event, provider: string) => authE2E ? { provider, state: "signed-in", configured: true, source: "stored", message: "Connected" } : (await s.ensureAuth()).login(await s.settingsStore.get(), provider));
  ipcMain.handle(IPC.authManualCode, async (_event, value: string) => (await s.ensureAuth()).submitManualCode(value));
  ipcMain.handle(IPC.authCancel, async () => (await s.ensureAuth()).cancel());
  ipcMain.handle(IPC.authSignOut, async (_event, provider: string) => authE2E ? { provider, state: "signed-out", configured: false, message: "Not configured" } : (await s.ensurePrimeConfig()).logout(await s.settingsStore.get(), provider));
  ipcMain.handle(IPC.authSaveFavorites, async (_event, models: ModelFavorite[]) => authE2E ? { favorites: models } : (await s.ensurePrimeConfig()).saveFavorites(await s.settingsStore.get(), models));
  ipcMain.handle(IPC.authSaveDefault, async (_event, value: ModelSelection) => {
    if (!authE2E) await (await s.ensurePrimeConfig()).saveDefault(await s.settingsStore.get(), value);
    await s.settingsStore.update({ provider: value.provider, model: value.modelId, thinking: value.thinkingLevel });
    return value;
  });
  ipcMain.handle(IPC.authReadModelsConfig, async () => authE2E ? { text: "{\n  \"providers\": {}\n}\n" } : (await s.ensurePrimeConfig()).readModelsConfig(await s.settingsStore.get()));
  ipcMain.handle(IPC.authWriteModelsConfig, async (_event, text: string) => authE2E ? { text } : (await s.ensurePrimeConfig()).writeModelsConfig(await s.settingsStore.get(), text));
}
