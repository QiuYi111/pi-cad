import { spawnSync } from "node:child_process";

const builder = "./node_modules/electron-builder/out/cli/cli.js";

if (process.platform === "win32") {
  const result = spawnSync(process.execPath, [builder, "--win", "nsis"], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
  const translated = spawnSync("wslpath", ["-w", process.cwd()], { encoding: "utf8" });
  if (translated.status !== 0) throw new Error(translated.stderr || "Unable to translate the WSL project path.");
  const directory = translated.stdout.trim().replaceAll("'", "''");
  const command = [
    `$directory = '${directory}'`,
    "Push-Location -LiteralPath $directory",
    "try { node.exe '.\\node_modules\\electron-builder\\out\\cli\\cli.js' --win nsis; exit $LASTEXITCODE } finally { Pop-Location }",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

console.error("Windows packaging requires Windows Node, Wine, or WSL interop with Windows Node installed.");
process.exit(1);
