import { createHash, type Hash } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { ProtocolError } from "./errors.js";

const CHUNK_BYTES = 64 * 1024;

// Streams a file in chunks, handing each to `emit`; stops early when emit returns false.
export async function streamFile(abs: string, emit: (chunk: Buffer) => boolean): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(abs, { highWaterMark: CHUNK_BYTES }) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    size += chunk.length;
    if (!emit(chunk)) break;
  }
  return { size, sha256: hash.digest("hex") };
}

// An upload writes `<abs>.tmp` and renames it into place only after size and sha256 match.
export class Upload {
  readonly tmp: string;
  private readonly out: WriteStream;
  private readonly hash: Hash = createHash("sha256");
  private received = 0;
  private failure: Error | undefined;

  constructor(readonly path: string, readonly abs: string, readonly size: number, readonly sha256: string) {
    this.tmp = `${abs}.tmp`;
    this.out = createWriteStream(this.tmp);
    this.out.on("error", (error) => {
      this.failure ??= error;
    });
  }

  write(data: Uint8Array): void {
    if (this.failure) return;
    this.received += data.length;
    if (this.received > this.size) {
      this.failure = new ProtocolError("size_mismatch", `upload to ${this.path} exceeds declared size ${this.size}`);
      return;
    }
    this.hash.update(data);
    this.out.write(data);
  }

  async commit(): Promise<void> {
    this.out.end();
    await finished(this.out).catch((error: Error) => {
      this.failure ??= error;
    });
    const digest = this.hash.digest("hex");
    if (!this.failure && this.received !== this.size) {
      this.failure = new ProtocolError("size_mismatch", `upload to ${this.path} is ${this.received} bytes, expected ${this.size}`);
    }
    if (!this.failure && digest !== this.sha256) {
      this.failure = new ProtocolError("checksum_mismatch", `upload to ${this.path} does not match sha256`);
    }
    if (this.failure) {
      await this.discard();
      throw this.failure;
    }
    await rename(this.tmp, this.abs).catch(async (error: unknown) => {
      await this.discard();
      throw error;
    });
  }

  async discard(): Promise<void> {
    this.out.destroy();
    await unlink(this.tmp).catch(() => {});
  }
}
