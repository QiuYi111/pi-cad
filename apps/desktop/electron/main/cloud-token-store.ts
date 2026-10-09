import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CloudSessionStore, StoredCloudSession } from "./cloud-session.js";

/** Encryption used for the saved session. Electron's safeStorage implements this in the main process. */
export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

/**
 * Cloud sign-in saved in the user data directory, encrypted with the OS keychain
 * through the cipher (plan §9.2). Unreadable or missing files mean signed out.
 */
export class EncryptedCloudSessionStore implements CloudSessionStore {
  constructor(private readonly path: string, private readonly cipher: SecretCipher) {}

  available(): boolean {
    return this.cipher.isAvailable();
  }

  async load(): Promise<StoredCloudSession | null> {
    let raw: Buffer;
    try {
      raw = await readFile(this.path);
    } catch {
      return null;
    }
    try {
      return JSON.parse(this.cipher.decrypt(raw)) as StoredCloudSession;
    } catch {
      return null;
    }
  }

  async save(session: StoredCloudSession): Promise<void> {
    if (!this.cipher.isAvailable()) throw new Error("This system cannot store sign-in securely.");
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, this.cipher.encrypt(JSON.stringify(session)), { mode: 0o600 });
    await rename(temporary, this.path);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
