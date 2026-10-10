import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function mergePrimeCredentials(source: Record<string, unknown>, destination: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...destination };
  for (const [provider, entry] of Object.entries(source)) {
    const current = merged[provider];
    if (current === undefined || isFresherCredential(entry, current)) merged[provider] = entry;
  }
  return merged;
}

/**
 * A refreshed OAuth credential carries a later expiry than the one it replaced.
 * An older expiry means the copy failed to refresh, or refreshed before another
 * run did: writing it back would hand the next launch a refresh token that is
 * already spent, and the user would have to sign in again. Entries without an
 * expiry (API keys) are taken from the source because /login inside the
 * sandbox is the ordinary way to add them.
 */
function isFresherCredential(source: unknown, destination: unknown): boolean {
  const sourceExpiry = credentialExpiry(source);
  const destinationExpiry = credentialExpiry(destination);
  if (sourceExpiry === null) return destinationExpiry === null;
  if (destinationExpiry === null) return true;
  return sourceExpiry > destinationExpiry;
}

function credentialExpiry(entry: unknown): number | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const expires = (entry as { expires?: unknown }).expires;
  return typeof expires === "number" && Number.isFinite(expires) ? expires : null;
}

/**
 * Linux binds the durable agent directory into the sandbox, so credentials
 * never leave the file Prime locks and rotates and nothing has to be copied
 * back. The macOS sandbox cannot redirect a path, so the author still works on
 * a per-launch copy; Prime's /login writes auth.json there, and without this
 * handoff a fresh login would disappear with the runtime directory. Merge
 * credentials back, newest first, and leave settings and session state
 * isolated per launch.
 */
export async function persistPrimeCredentials(source: string, destination: string): Promise<void> {
  const sourcePath = join(source, "auth.json");
  let sourceCredentials: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    sourceCredentials = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const destinationPath = join(destination, "auth.json");
  let destinationCredentials: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(destinationPath, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      destinationCredentials = parsed as Record<string, unknown>;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(destination, { recursive: true, mode: 0o700 });
  const temporaryPath = join(destination, `auth.json.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(mergePrimeCredentials(sourceCredentials, destinationCredentials), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, destinationPath);
}
