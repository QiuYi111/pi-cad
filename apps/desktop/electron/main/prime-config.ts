import type { AppSettings, AuthStatus, ModelCatalog, ModelFavorite, ModelSelection } from "../../src/shared/contracts.js";
import type { RuntimeBridge } from "./runtime-bridge.js";

export class PrimeConfigService {
  constructor(private readonly bridge: RuntimeBridge) {}

  private async run(settings: AppSettings, command: string, input: unknown = {}): Promise<any> {
    const { piCadRepo, primeAgentRepo, projectPath } = await this.bridge.resolveRuntimePaths(settings);
    const home = await this.bridge.homeDirectory();
    const node = await this.bridge.commandPath("node");
    const result = await this.bridge.exec([
      node,
      `${piCadRepo}/scripts/desktop-prime-config.mjs`,
      primeAgentRepo,
      `${home}/.prime/agent`,
      projectPath || home,
      command,
    ], { input: JSON.stringify(input), timeout: command === "catalog" ? 60_000 : 30_000 });
    return JSON.parse(result.stdout.trim() || "{}");
  }

  catalog(settings: AppSettings): Promise<ModelCatalog> { return this.run(settings, "catalog"); }
  status(settings: AppSettings, provider: string): Promise<AuthStatus> { return this.run(settings, "status", { provider }); }
  setApiKey(settings: AppSettings, provider: string, key: string): Promise<AuthStatus> { return this.run(settings, "set-api-key", { provider, key }); }
  logout(settings: AppSettings, provider: string): Promise<AuthStatus> { return this.run(settings, "logout", { provider }); }
  saveFavorites(settings: AppSettings, models: ModelFavorite[]): Promise<{ favorites: ModelFavorite[] }> { return this.run(settings, "save-favorites", { models }); }
  saveDefault(settings: AppSettings, value: ModelSelection): Promise<ModelSelection> { return this.run(settings, "save-default", value); }
  readModelsConfig(settings: AppSettings): Promise<{ text: string }> { return this.run(settings, "read-models-config"); }
  writeModelsConfig(settings: AppSettings, text: string): Promise<{ text: string }> { return this.run(settings, "write-models-config", { text }); }
}
