import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SettingsStore } from "../electron/main/settings-store";
import { assertCandidateAdoptionAllowed } from "../electron/main/traces";

vi.mock("electron", () => ({
  app: { getPath: () => "/unused", getAppPath: () => "/unused", isPackaged: true },
}));

async function storeWith(content?: string) {
  const dir = await mkdtemp(join(tmpdir(), "pi-cad-settings-mode-"));
  const path = join(dir, "settings.json");
  if (content !== undefined) await writeFile(path, content, "utf8");
  return { path, store: new SettingsStore(path) };
}

describe("settings mode", () => {
  it("defaults to local when no settings file exists", async () => {
    const { store } = await storeWith();
    expect((await store.get()).mode).toBe("local");
  });

  it("loads an existing settings file without a mode field as local", async () => {
    const { store } = await storeWith(JSON.stringify({ provider: "zai", model: "glm", onboardingComplete: true }));
    const settings = await store.get();
    expect(settings.mode).toBe("local");
    expect(settings.provider).toBe("zai");
  });

  it("treats unknown mode values as local", async () => {
    const { store } = await storeWith(JSON.stringify({ mode: "remote" }));
    expect((await store.get()).mode).toBe("local");
  });

  it("persists cloud mode through update", async () => {
    const { path, store } = await storeWith();
    await store.update({ mode: "cloud" });
    expect((await store.get()).mode).toBe("cloud");
    expect(JSON.parse(await readFile(path, "utf8")).mode).toBe("cloud");
  });

  it("refuses experience adoption in cloud mode and allows it locally", () => {
    expect(() => assertCandidateAdoptionAllowed({ mode: "cloud" })).toThrow("内测期云端模式不支持采纳经验");
    expect(() => assertCandidateAdoptionAllowed({ mode: "local" })).not.toThrow();
  });
});
