import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { RuntimeBridge } from "./runtime-bridge.js";
import type { ProjectIO } from "./cad-transfer-paths.js";

/** Project folder on the local file system (macOS, Linux, and native Windows). */
export class NativeProjectIO implements ProjectIO {
  constructor(readonly root: string) {}
  private abs(relative: string) { return join(this.root, ...relative.split("/")); }
  async readText(relative: string) { try { return await readFile(this.abs(relative), "utf8"); } catch { return null; } }
  async writeTextAtomic(relative: string, text: string) {
    const file = this.abs(relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, text, "utf8");
    await rename(`${file}.tmp`, file);
  }
  async readdir(relative: string) { try { return await readdir(this.abs(relative)); } catch { return []; } }
  async exists(relative: string) { try { await stat(this.abs(relative)); return true; } catch { return false; } }
  async remove(relative: string) { await rm(this.abs(relative), { force: true }); }
  async copyIn(hostFile: string, relative: string) {
    const target = this.abs(relative);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(hostFile, `${target}.tmp`);
    await rename(`${target}.tmp`, target);
  }
  async toHostPath(relative: string) { return this.abs(relative); }
}

/** wsl.exe re-parses its arguments, so `sh -c '...$1...' name arg` loses `$1`: quote values into the script instead. */
const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

type BridgeSlice = Pick<RuntimeBridge, "exec" | "pipe" | "toRuntimePath" | "kind">;

/**
 * Project folder reached through the runtime bridge. In a WSL setup the folder
 * lives inside the distro while the executors write to the Windows file system:
 * `toRuntimePath` turns a Windows path into /mnt/c/... for `cp`, and `wslpath -w`
 * turns a project path into a Windows path for the UI.
 */
export class BridgeProjectIO implements ProjectIO {
  constructor(private readonly bridge: BridgeSlice, readonly root: string) {}
  private abs(relative: string) { return `${this.root.replace(/\/+$/, "")}/${relative}`; }
  async readText(relative: string) {
    try {
      const { stdout } = await this.bridge.exec(["sh", "-c", `if [ -f ${q(this.abs(relative))} ]; then cat -- ${q(this.abs(relative))}; else exit 3; fi`]);
      return stdout;
    } catch { return null; }
  }
  async writeTextAtomic(relative: string, text: string) {
    await this.bridge.pipe(
      ["sh", "-c", `mkdir -p -- ${q(posix.dirname(this.abs(relative)))} && cat > ${q(`${this.abs(relative)}.tmp`)} && mv -f -- ${q(`${this.abs(relative)}.tmp`)} ${q(this.abs(relative))}`], text,
    );
  }
  async readdir(relative: string) {
    try {
      const { stdout } = await this.bridge.exec(["sh", "-c", `ls -1A -- ${q(this.abs(relative))} 2>/dev/null || true`]);
      return stdout.split("\n").map((line) => line.replace(/\r$/, "")).filter(Boolean);
    } catch { return []; }
  }
  async exists(relative: string) {
    try { await this.bridge.exec(["test", "-e", this.abs(relative)]); return true; } catch { return false; }
  }
  async remove(relative: string) { await this.bridge.exec(["rm", "-f", "--", this.abs(relative)]); }
  async copyIn(hostFile: string, relative: string) {
    const source = await this.bridge.toRuntimePath(hostFile);
    await this.bridge.exec(
      ["sh", "-c", `mkdir -p -- ${q(posix.dirname(this.abs(relative)))} && cp -f -- ${q(source)} ${q(`${this.abs(relative)}.tmp`)} && mv -f -- ${q(`${this.abs(relative)}.tmp`)} ${q(this.abs(relative))}`],
      { timeout: 120_000 },
    );
  }
  async toHostPath(relative: string) {
    const abs = this.abs(relative);
    if (this.bridge.kind !== "wsl") return abs;
    const { stdout } = await this.bridge.exec(["wslpath", "-w", abs]);
    return stdout.trim() || abs;
  }
}
