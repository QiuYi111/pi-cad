import { fileURLToPath } from "node:url";

export function packageRoot(): string {
  // <package>/src/shared/paths.ts -> <package>
  return fileURLToPath(new URL("../../", import.meta.url));
}
