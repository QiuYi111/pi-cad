#!/usr/bin/env node

import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const VERSION = "3.0.19";
const PROTOCOL = "@howaboua/pi-codex-conversion/code-mode-provider/v1";
const packageRoot = process.env.PI_CODEX_CONVERSION_ROOT
  ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "npm", "node_modules", "@howaboua", "pi-codex-conversion");
const packageJsonPath = join(packageRoot, "package.json");
const runtimePath = join(packageRoot, "dist", "tools", "code-mode", "tools.js");

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
if (packageJson.version !== VERSION) {
  throw new Error(`Pi-CAD provider bridge supports pi-codex-conversion ${VERSION}; found ${String(packageJson.version)}. Refusing to patch an unknown build.`);
}

const original = await readFile(runtimePath, "utf8");
const declarationAnchor = 'const REGISTRATION_KEY = Symbol.for("@howaboua/pi-codex-conversion.code-mode");';
const bindingAnchor = "        registerPublicCodeModeTools(pi, processState.runtime);";
const broker = `${declarationAnchor}\nconst PROVIDER_PROTOCOL = "${PROTOCOL}";\nconst PROVIDER_REQUEST_CHANNEL = \`\${PROVIDER_PROTOCOL}/request\`;\nconst PROVIDER_AVAILABLE_CHANNEL = \`\${PROVIDER_PROTOCOL}/available\`;\nconst providerBrokerApis = new WeakSet();\nfunction registerProviderBroker(pi, runtime) {\n    if (providerBrokerApis.has(pi))\n        return;\n    providerBrokerApis.add(pi);\n    let active = true;\n    const broker = {\n        protocol: PROVIDER_PROTOCOL,\n        isActive: () => active,\n        register(provider) {\n            if (!active)\n                return () => { };\n            const id = runtime.addProvider(provider);\n            return () => runtime.removeProvider(id);\n        },\n    };\n    const announce = () => { if (active)\n        pi.events.emit(PROVIDER_AVAILABLE_CHANNEL, broker); };\n    pi.events.on(PROVIDER_REQUEST_CHANNEL, (value) => {\n        if (value && typeof value === "object" && "protocol" in value && value.protocol === PROVIDER_PROTOCOL)\n            announce();\n    });\n    pi.on("session_shutdown", () => { active = false; });\n    announce();\n}`;
const backupPath = `${runtimePath}.pi-cad-provider-bridge-v1.bak`;

if (original.includes(PROTOCOL)) {
  try {
    await access(backupPath);
  } catch {
    const restored = original
      .replace(broker, declarationAnchor)
      .replace(`${bindingAnchor}\n        registerProviderBroker(pi, processState.runtime);`, bindingAnchor);
    if (restored === original) throw new Error("installed bridge differs from Pi-CAD's validated patch; cannot create a safe backup");
    await writeFile(backupPath, restored, "utf8");
  }
  console.log(`pi-codex-conversion ${VERSION}: provider bridge already installed`);
  process.exit(0);
}

if (!original.includes(declarationAnchor) || !original.includes(bindingAnchor)) {
  throw new Error("pi-codex-conversion layout differs from the validated 3.0.19 build; no files changed");
}
const patched = original
  .replace(declarationAnchor, broker)
  .replace(bindingAnchor, `${bindingAnchor}\n        registerProviderBroker(pi, processState.runtime);`);

const temporaryPath = `${runtimePath}.pi-cad-provider-bridge-v1.tmp`;
await mkdir(dirname(runtimePath), { recursive: true });
await copyFile(runtimePath, backupPath);
await writeFile(temporaryPath, patched, "utf8");
await rename(temporaryPath, runtimePath);
console.log(`pi-codex-conversion ${VERSION}: installed provider bridge; backup=${backupPath}`);
