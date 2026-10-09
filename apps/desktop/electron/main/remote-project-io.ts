import { readFile, stat, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { isProjectRelative, type ProjectIO } from "./cad-transfer-paths.js";
import type { RemoteBridge } from "./remote-bridge.js";

/** The bridge calls a project folder needs. */
export type RemoteProjectBridge = Pick<RemoteBridge, "exec" | "pipe" | "download" | "upload">;

export interface RemoteProjectIOOptions {
  projectId: string;
  /** Local directory that holds downloaded copies of project files. */
  cacheRoot: string;
}

/** Quotes a value for a POSIX shell script. */
const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Project folder inside a cloud workspace (plan §9.6). Reads and writes run
 * as shell commands through the bridge; file bytes move through upload and
 * download. Host paths are local cache copies, kept while the remote checksum
 * still matches the sidecar `<file>.sha256`.
 */
export class RemoteProjectIO implements ProjectIO {
  /** Spool polling goes through the gateway, so it runs at most every two seconds (plan §9.6). */
  readonly spoolPollMs = 2_000;

  constructor(private readonly bridge: RemoteProjectBridge, readonly root: string, private readonly options: RemoteProjectIOOptions) {}

  private abs(relative: string): string {
    return `${this.root.replace(/\/+$/, "")}/${relative}`;
  }

  private requireRelative(relative: string): void {
    if (!isProjectRelative(relative)) throw new Error(`${relative} is not a project path`);
  }

  async readText(relative: string): Promise<string | null> {
    if (!isProjectRelative(relative)) return null;
    const file = q(this.abs(relative));
    try {
      const { stdout } = await this.bridge.exec(["sh", "-c", `if [ -f ${file} ]; then cat -- ${file}; else exit 3; fi`]);
      return stdout;
    } catch {
      return null;
    }
  }

  async writeTextAtomic(relative: string, text: string): Promise<void> {
    this.requireRelative(relative);
    const target = q(this.abs(relative));
    const temporary = q(`${this.abs(relative)}.tmp`);
    await this.bridge.pipe(
      ["sh", "-c", `mkdir -p -- ${q(posix.dirname(this.abs(relative)))} && cat > ${temporary} && mv -f -- ${temporary} ${target}`],
      text,
    );
  }

  async readdir(relative: string): Promise<string[]> {
    if (!isProjectRelative(relative)) return [];
    try {
      const { stdout } = await this.bridge.exec(["sh", "-c", `ls -1A -- ${q(this.abs(relative))} 2>/dev/null || true`]);
      return stdout.split("\n").map((line) => line.replace(/\r$/, "")).filter(Boolean);
    } catch {
      return [];
    }
  }

  async exists(relative: string): Promise<boolean> {
    if (!isProjectRelative(relative)) return false;
    try {
      await this.bridge.exec(["test", "-e", this.abs(relative)]);
      return true;
    } catch {
      return false;
    }
  }

  async remove(relative: string): Promise<void> {
    this.requireRelative(relative);
    await this.bridge.exec(["rm", "-f", "--", this.abs(relative)]);
  }

  async copyIn(hostFile: string, relative: string): Promise<void> {
    this.requireRelative(relative);
    await this.bridge.upload(hostFile, this.abs(relative));
  }

  /** Local cache copy of a project file, downloaded only when the remote checksum differs from the sidecar. */
  async toHostPath(relative: string): Promise<string> {
    this.requireRelative(relative);
    const remote = this.abs(relative);
    const local = join(this.options.cacheRoot, this.options.projectId, ...relative.split("/"));
    const { stdout } = await this.bridge.exec(["sha256sum", "--", remote]);
    const sha256 = stdout.trim().split(/\s+/)[0] ?? "";
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Could not read the checksum of ${relative}.`);
    const sidecar = `${local}.sha256`;
    const cached = await readFile(sidecar, "utf8").catch(() => null);
    if (cached?.trim() === sha256 && await isFile(local)) return local;
    const downloaded = await this.bridge.download(remote, local);
    await writeFile(sidecar, `${downloaded.sha256}\n`, "utf8");
    return local;
  }
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isFile(), () => false);
}
