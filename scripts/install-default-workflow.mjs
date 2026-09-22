import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// Only replace an exact previously shipped copy. User edits always win.
const superseded = new Set([
  "ee14b5d4775cfd08ae9c11e07387c6b69374af5fbda849f3abdc107e695fc9ea",
]);

export function installDefaultWorkflow(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) {
    const digest = createHash("sha256").update(readFileSync(destination)).digest("hex");
    if (!superseded.has(digest)) return false;
  }
  copyFileSync(source, destination);
  return true;
}
