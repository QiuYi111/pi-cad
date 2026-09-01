import { createServer } from "node:net";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AppSettings, ParaViewSession } from "../../src/shared/contracts.js";
import type { RuntimeBridge } from "./runtime-bridge.js";
import { ViewerBackend } from "./viewer.js";

async function freePort(): Promise<number> {
  return new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : accept(port));
    });
  });
}

async function waitUntilReady(url: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 45_000) {
    if (child.exitCode !== null) throw new Error(`ParaView exited before its viewer opened (code ${child.exitCode}).`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* startup */ }
    await new Promise((accept) => setTimeout(accept, 250));
  }
  throw new Error("ParaView took too long to open.");
}

export class ParaViewBackend {
  private child: ChildProcessWithoutNullStreams | null = null;
  private session: ParaViewSession = { state: "unavailable" };

  constructor(private readonly bridge: RuntimeBridge) {}

  async open(settings: AppSettings, path: string): Promise<ParaViewSession> {
    const viewer = new ViewerBackend(this.bridge);
    const source = await viewer.resolveProjectPath(settings, path);
    if (this.session.state === "ready" && this.session.sourcePath === source && this.child?.exitCode === null) return this.session;
    await this.stop();
    this.session = { state: "starting", sourcePath: source };
    try {
      const { piCadRepo } = await this.bridge.resolveRuntimePaths(settings);
      const { python } = await this.ensureEnvironment();
      const port = await freePort();
      const url = `http://127.0.0.1:${port}/`;
      const child = this.bridge.spawn(["env", "QT_QPA_PLATFORM=offscreen", python, `${piCadRepo}/scripts/desktop-paraview-server.py`, source, "--port", String(port)]);
      this.child = child;
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000); });
      await waitUntilReady(url, child).catch((error) => {
        throw new Error(`${error instanceof Error ? error.message : error}${stderr.trim() ? ` ${stderr.trim()}` : ""}`);
      });
      this.session = { state: "ready", sourcePath: source, url };
      child.once("exit", (code) => {
        if (this.child !== child) return;
        this.child = null;
        this.session = { state: "error", sourcePath: source, message: `ParaView stopped${code === null ? "" : ` (code ${code})`}.` };
      });
      return this.session;
    } catch (error) {
      await this.stop();
      this.session = { state: "error", sourcePath: source, message: error instanceof Error ? error.message : String(error) };
      return this.session;
    }
  }

  async openDesktop(settings: AppSettings, path: string): Promise<void> {
    const source = await new ViewerBackend(this.bridge).resolveProjectPath(settings, path);
    const { pvpython } = await this.resolveParaView();
    const executable = `${pvpython.slice(0, -"pvpython".length)}paraview`;
    const present = await this.bridge.exec(["test", "-x", executable]).then(() => true, () => false);
    if (!present) throw new Error("Full ParaView Desktop is not installed.");
    const child = this.bridge.spawn([executable, source]);
    child.unref();
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((accept) => setTimeout(accept, 120));
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    this.session = { state: "unavailable" };
  }

  private async resolveParaView(): Promise<{ pvpython: string }> {
    const home = await this.bridge.homeDirectory();
    const { stdout } = await this.bridge.exec(["bash", "-lc", `for candidate in ${JSON.stringify(home)}/.local/share/pi-cad-desktop/paraview/*/bin/pvpython "$(command -v pvpython 2>/dev/null || true)"; do test -x "$candidate" && printf '%s' "$candidate" && break; done`]);
    const pvpython = stdout.trim();
    if (!pvpython) throw new Error("The complete ParaView runtime is not installed.");
    return { pvpython };
  }

  private async ensureEnvironment(): Promise<{ python: string; environment: string }> {
    const home = await this.bridge.homeDirectory();
    const { pvpython } = await this.resolveParaView();
    const environment = `${home}/.local/share/pi-cad-desktop/paraview-venv`;
    const python = `${environment}/bin/python`;
    const check = await this.bridge.exec(["bash", "-lc", [
      `test -x ${JSON.stringify(python)}`,
      `${JSON.stringify(python)} -c 'import trame, trame_vtk, trame_vuetify, vtkmodules'`,
    ].join(" && ")]).then(() => true, () => false);
    if (check) return { python, environment };
    const uv = await this.bridge.commandPath("uv");
    const { stdout } = await this.bridge.exec(["bash", "-lc", "for candidate in /usr/bin/python3 \"$(command -v python3 2>/dev/null || true)\"; do test -x \"$candidate\" && \"$candidate\" -c 'import vtkmodules' >/dev/null 2>&1 && printf '%s' \"$candidate\" && break; done"]);
    const vtkPython = stdout.trim();
    if (!vtkPython) throw new Error("ParaView is installed, but its VTK Python modules are unavailable.");
    await this.bridge.exec([uv, "venv", environment, "--python", vtkPython, "--system-site-packages", "--clear"], { timeout: 5 * 60_000 });
    await this.bridge.exec([uv, "pip", "install", "--python", python, "trame>=3.12,<4", "trame-vtk>=2.10,<3", "trame-vuetify>=3.1,<4"], { timeout: 10 * 60_000 });
    await this.bridge.exec([python, "-c", "import trame, trame_vtk, trame_vuetify, vtkmodules"], { timeout: 60_000 });
    return { python, environment };
  }
}
