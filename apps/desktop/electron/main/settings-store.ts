import { app } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AppSettings } from "../../src/shared/contracts.js";

const defaults = (): AppSettings => ({
  distro: process.env.PI_CAD_WSL_DISTRO || "Ubuntu",
  projectPath: process.env.PI_CAD_PROJECT_CWD || "",
  piCadRepo: process.env.PI_CAD_REPO || (app.isPackaged ? "" : resolve(app.getAppPath(), "../..")),
  primeAgentRepo: process.env.PRIME_AGENT_REPO || "",
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  thinking: "minimal",
  permission: "workspace",
  reviewer: { mode: "inherit" },
});

export class SettingsStore {
  readonly path: string;

  constructor(path = join(app.getPath("userData"), "settings.json")) {
    this.path = path;
  }

  async get(): Promise<AppSettings> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<AppSettings>;
      return { ...defaults(), ...parsed, reviewer: { ...defaults().reviewer, ...parsed.reviewer } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return defaults();
    }
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.get();
    const next: AppSettings = {
      ...current,
      ...patch,
      reviewer: patch.reviewer ? { ...current.reviewer, ...patch.reviewer } : current.reviewer,
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
    return next;
  }
}
