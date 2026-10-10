import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { dirname, join } from "node:path";

export async function configureBlenderMcp(agentDir: string, command: string, env: Record<string, { env: string }>): Promise<void> {
  const path = join(agentDir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const current = settings.mcpServers && typeof settings.mcpServers === "object" && !Array.isArray(settings.mcpServers)
    ? settings.mcpServers as Record<string, unknown> : {};
  settings.mcpServers = {
    ...current,
    blender: { type: "stdio", command, args: [], env, startupTimeoutMs: 20_000, callTimeoutMs: 300_000 },
  };
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function freeTcpPort(): Promise<number> {
  return new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("could not allocate Blender MCP port"));
      server.close((error) => error ? reject(error) : accept(address.port));
    });
  });
}

async function waitForTcp(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`managed Blender MCP exited with code ${child.exitCode}`);
    const connected = await new Promise<boolean>((accept) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(250);
      socket.once("connect", () => { socket.destroy(); accept(true); });
      socket.once("timeout", () => { socket.destroy(); accept(false); });
      socket.once("error", () => accept(false));
    });
    if (connected) return;
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw new Error("managed Blender MCP did not become ready within 30 seconds");
}

export async function startManagedBlenderMcp(repository: string): Promise<{ close: () => Promise<void> } | null> {
  const manifest = JSON.parse(await readFile(join(repository, "scripts", "blender-manifest.json"), "utf8")) as { version: string; platforms: Record<string, { binary?: string }> };
  const key = process.arch === "arm64" ? "linux-arm64" : "linux-x64";
  const entry = manifest.platforms[key];
  if (!entry?.binary) return null;
  const binary = join(repository, ".runtime", "blender", manifest.version, key, "blender");
  if (!existsSync(binary)) return null;
  const port = await freeTcpPort();
  process.env.PI_CAD_BLENDER_MCP_PORT = String(port);
  const addon = join(repository, "third_party", "blender-mcp", "addon");
  const expression = `import sys;sys.path.insert(0,${JSON.stringify(addon)});import blender_mcp_addon;blender_mcp_addon.register()`;
  const runtimeDir = dirname(binary);
  const child = spawn(binary, ["--background", "--factory-startup", "--online-mode", "--python-expr", expression, "--command", "blender_mcp", "--host", "127.0.0.1", "--port", String(port)], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, OMP_NUM_THREADS: "1", LD_LIBRARY_PATH: [join(runtimeDir, "lib"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") },
  });
  let diagnostic = "";
  child.stderr?.on("data", (chunk: Buffer) => { diagnostic = `${diagnostic}${chunk.toString("utf8")}`.slice(-4096); });
  try { await waitForTcp(port, child); }
  catch (error) { child.kill("SIGTERM"); throw new Error(`${error instanceof Error ? error.message : String(error)}${diagnostic ? `: ${diagnostic.trim()}` : ""}`); }
  return { close: () => new Promise((accept) => {
    if (child.exitCode !== null) return accept();
    child.once("exit", () => accept());
    child.kill("SIGTERM");
    setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2_000).unref();
  }) };
}
