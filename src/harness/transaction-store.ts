import { randomUUID, createHash } from "node:crypto";
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { jsonValue, type JsonValue } from "./canonical.ts";

interface TransactionFile {
  path: string;
  size: number;
  sha256: string;
}

export interface TransactionManifestV1 {
  schema: 1;
  txId: string;
  parentTxId: string | null;
  parentCommitHash: string | null;
  parentGeneration: number;
  nextGeneration: number;
  files: TransactionFile[];
}

export interface TransactionCommitV1 {
  schema: 1;
  txId: string;
  parentGeneration: number;
  nextGeneration: number;
  manifestHash: string;
  committedAt: string;
}

export interface HeadPointerV1 {
  schema: 1;
  generation: number;
  txId: string;
  commitHash: string;
}

export interface TransactionEventV1 {
  type: string;
  data?: JsonValue;
}

export type TransactionFaultPoint = "after_payloads" | "after_manifest" | "after_commit" | "after_head" | "after_materialize";

export interface CommitTransactionInput {
  expectedGeneration: number;
  payloads: Record<string, string | Buffer | JsonValue>;
  event: TransactionEventV1;
  faultAt?: TransactionFaultPoint;
}

export class TransactionConflictError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`transaction generation conflict: expected ${expected}, actual ${actual}`);
    this.name = "TransactionConflictError";
  }
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function payloadContent(value: string | Buffer | JsonValue): string | Buffer {
  if (Buffer.isBuffer(value) || typeof value === "string") return value;
  return `${JSON.stringify(jsonValue(value), null, 2)}\n`;
}

function safePayloadPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..") || isAbsolute(path)) throw new Error(`unsafe transaction payload path: ${path}`);
  if (["HEAD", "commit.json", "manifest.json", "events.jsonl"].includes(normalized) || normalized.startsWith("transactions/")) throw new Error(`reserved transaction payload path: ${path}`);
  return normalized;
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicWrite(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content);
  await fsyncFile(temporary);
  await rename(temporary, path);
  await fsyncDirectory(dirname(path));
}

function fault(input: CommitTransactionInput, point: TransactionFaultPoint): void {
  if (input.faultAt === point) throw new Error(`injected transaction crash: ${point}`);
}

export class TransactionStore {
  readonly runDirectory: string;
  readonly transactionsDirectory: string;
  readonly headPath: string;
  private readonly lockPath: string;

  constructor(runDirectory: string) {
    this.runDirectory = resolve(runDirectory);
    this.transactionsDirectory = join(this.runDirectory, "transactions");
    this.headPath = join(this.runDirectory, "HEAD");
    this.lockPath = join(this.runDirectory, ".head.lock");
  }

  async readHead(): Promise<HeadPointerV1 | null> {
    try {
      const head = JSON.parse(await readFile(this.headPath, "utf-8")) as HeadPointerV1;
      if (head.schema !== 1 || !Number.isInteger(head.generation) || head.generation <= 0 || !/^tx-[a-f0-9-]+$/.test(head.txId) || !/^[a-f0-9]{64}$/.test(head.commitHash)) throw new Error("invalid transaction HEAD");
      return head;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async commit(input: CommitTransactionInput): Promise<HeadPointerV1> {
    await mkdir(this.transactionsDirectory, { recursive: true });
    const initialHead = await this.readHead();
    const initialGeneration = initialHead?.generation ?? 0;
    if (initialGeneration !== input.expectedGeneration) throw new TransactionConflictError(input.expectedGeneration, initialGeneration);
    const txId = `tx-${randomUUID()}`;
    const directory = join(this.transactionsDirectory, txId);
    await mkdir(directory, { recursive: false });
    const files: TransactionFile[] = [];
    for (const [rawPath, value] of Object.entries(input.payloads).sort(([a], [b]) => a.localeCompare(b))) {
      const path = safePayloadPath(rawPath);
      const content = payloadContent(value);
      const destination = join(directory, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content, { flag: "wx" });
      await fsyncFile(destination);
      files.push({ path, size: Buffer.byteLength(content), sha256: sha256(content) });
    }
    const eventContent = `${JSON.stringify({ schema: 1, ...input.event }, null, 2)}\n`;
    await writeFile(join(directory, "event.json"), eventContent, { flag: "wx" });
    await fsyncFile(join(directory, "event.json"));
    files.push({ path: "event.json", size: Buffer.byteLength(eventContent), sha256: sha256(eventContent) });
    fault(input, "after_payloads");
    const manifest: TransactionManifestV1 = {
      schema: 1,
      txId,
      parentTxId: initialHead?.txId ?? null,
      parentCommitHash: initialHead?.commitHash ?? null,
      parentGeneration: initialGeneration,
      nextGeneration: initialGeneration + 1,
      files,
    };
    const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(join(directory, "manifest.json"), manifestContent, { flag: "wx" });
    await fsyncFile(join(directory, "manifest.json"));
    await fsyncDirectory(directory);
    fault(input, "after_manifest");
    const commit: TransactionCommitV1 = {
      schema: 1,
      txId,
      parentGeneration: initialGeneration,
      nextGeneration: initialGeneration + 1,
      manifestHash: sha256(manifestContent),
      committedAt: new Date().toISOString(),
    };
    const commitContent = `${JSON.stringify(commit, null, 2)}\n`;
    await writeFile(join(directory, "commit.json"), commitContent, { flag: "wx" });
    await fsyncFile(join(directory, "commit.json"));
    await fsyncDirectory(directory);
    fault(input, "after_commit");

    let lock;
    try {
      lock = await open(this.lockPath, "wx");
      await lock.writeFile(`${JSON.stringify({ schema: 1, pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      await lock.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new TransactionConflictError(input.expectedGeneration, (await this.readHead())?.generation ?? 0);
      throw error;
    }
    let head: HeadPointerV1;
    try {
      const current = await this.readHead();
      const actual = current?.generation ?? 0;
      if (actual !== input.expectedGeneration) throw new TransactionConflictError(input.expectedGeneration, actual);
      head = { schema: 1, generation: commit.nextGeneration, txId, commitHash: sha256(commitContent) };
      await atomicWrite(this.headPath, `${JSON.stringify(head, null, 2)}\n`);
    } finally {
      await lock.close();
      await rm(this.lockPath, { force: true });
    }
    fault(input, "after_head");
    await this.materialize(head);
    fault(input, "after_materialize");
    return head;
  }

  async readPayload(path: string): Promise<Buffer | null> {
    const head = await this.readHead();
    if (!head) return null;
    const { directory, manifest } = await this.verifyTransaction(head, false);
    const normalized = safePayloadPath(path);
    const descriptor = manifest.files.find((file) => file.path === normalized);
    if (!descriptor) return null;
    const content = await readFile(join(directory, normalized));
    if (content.length !== descriptor.size || sha256(content) !== descriptor.sha256) throw new Error(`transaction payload hash mismatch: ${normalized}`);
    return content;
  }

  async readJson<T>(path: string): Promise<T | null> {
    const content = await this.readPayload(path);
    return content ? JSON.parse(content.toString("utf-8")) as T : null;
  }

  async readJsonBounded<T>(path: string, maxBytes: number): Promise<T | null> {
    const content = await this.readPayloadBounded(path, maxBytes);
    return content ? JSON.parse(content.toString("utf-8")) as T : null;
  }

  async readPayloadBounded(path: string, maxBytes: number): Promise<Buffer | null> {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error("bounded transaction read requires a positive byte limit");
    const head = await this.readHead();
    if (!head) return null;
    const { directory, manifest } = await this.verifyTransaction(head, false);
    const normalized = safePayloadPath(path);
    const descriptor = manifest.files.find((file) => file.path === normalized);
    if (!descriptor) return null;
    if (descriptor.size > maxBytes) throw new Error(`transaction payload exceeds read budget: ${normalized} (${descriptor.size} > ${maxBytes})`);
    const content = await readFile(join(directory, normalized));
    if (content.length !== descriptor.size || sha256(content) !== descriptor.sha256) throw new Error(`transaction payload hash mismatch: ${normalized}`);
    return content;
  }

  /** Return the complete immutable generation payload (journal event excluded). */
  async readSnapshotPayloads(): Promise<Record<string, Buffer>> {
    const head = await this.readHead();
    if (!head) return {};
    const { directory, manifest } = await this.verifyTransaction(head);
    const payloads: Record<string, Buffer> = {};
    for (const descriptor of manifest.files) {
      if (descriptor.path === "event.json") continue;
      payloads[descriptor.path] = await readFile(join(directory, descriptor.path));
    }
    return payloads;
  }

  async recover(): Promise<HeadPointerV1 | null> {
    await mkdir(this.transactionsDirectory, { recursive: true });
    // A process can die while holding the CAS lock. Explicit recovery may
    // remove it only after proving the recorded owner process no longer
    // exists; an active writer is never guessed stale by age.
    try {
      const owner = JSON.parse(await readFile(this.lockPath, "utf-8")) as { schema?: unknown; pid?: unknown };
      if (owner.schema !== 1 || !Number.isInteger(owner.pid) || Number(owner.pid) <= 0) throw new Error("malformed transaction lock");
      try {
        process.kill(Number(owner.pid), 0);
        throw new Error(`transaction recovery refused: writer process ${owner.pid} is still active`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        await rm(this.lockPath, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const head = await this.readHead();
    if (head) {
      await this.verifyTransaction(head);
      await this.materialize(head);
    }
    for (const name of await readdir(this.transactionsDirectory)) {
      if (!/^tx-[a-f0-9-]+$/.test(name) || name === head?.txId) continue;
      const directory = join(this.transactionsDirectory, name);
      try {
        await stat(join(directory, "commit.json"));
      } catch {
        await rm(directory, { recursive: true, force: true });
      }
    }
    return head;
  }

  private async verifyTransaction(head: HeadPointerV1, verifyPayloads = true): Promise<{ directory: string; manifest: TransactionManifestV1; commit: TransactionCommitV1 }> {
    const directory = join(this.transactionsDirectory, head.txId);
    const commitContent = await readFile(join(directory, "commit.json"));
    if (sha256(commitContent) !== head.commitHash) throw new Error("transaction commit hash mismatch");
    const commit = JSON.parse(commitContent.toString("utf-8")) as TransactionCommitV1;
    const manifestContent = await readFile(join(directory, "manifest.json"));
    if (sha256(manifestContent) !== commit.manifestHash) throw new Error("transaction manifest hash mismatch");
    const manifest = JSON.parse(manifestContent.toString("utf-8")) as TransactionManifestV1;
    if (commit.schema !== 1 || manifest.schema !== 1 || commit.txId !== head.txId || manifest.txId !== head.txId || commit.nextGeneration !== head.generation || manifest.nextGeneration !== head.generation) throw new Error("transaction identity mismatch");
    if (verifyPayloads) {
      for (const descriptor of manifest.files) {
        const path = safePayloadPath(descriptor.path);
        const content = await readFile(join(directory, path));
        if (content.length !== descriptor.size || sha256(content) !== descriptor.sha256) throw new Error(`transaction payload hash mismatch: ${path}`);
      }
    }
    return { directory, manifest, commit };
  }

  private async transactionChain(head: HeadPointerV1): Promise<Array<{ directory: string; manifest: TransactionManifestV1 }>> {
    const chain: Array<{ directory: string; manifest: TransactionManifestV1 }> = [];
    let txId: string | null = head.txId;
    let expectedGeneration = head.generation;
    let expectedCommitHash: string | null = head.commitHash;
    while (txId) {
      const directory = join(this.transactionsDirectory, txId);
      const commitContent = await readFile(join(directory, "commit.json"));
      if (sha256(commitContent) !== expectedCommitHash) throw new Error("broken transaction commit ancestry");
      const commit = JSON.parse(commitContent.toString("utf-8")) as TransactionCommitV1;
      const manifestContent = await readFile(join(directory, "manifest.json"));
      if (sha256(manifestContent) !== commit.manifestHash) throw new Error("broken transaction manifest ancestry");
      const manifest = JSON.parse(manifestContent.toString("utf-8")) as TransactionManifestV1;
      if (manifest.txId !== txId || manifest.nextGeneration !== expectedGeneration) throw new Error("broken transaction ancestry");
      chain.push({ directory, manifest });
      txId = manifest.parentTxId;
      expectedCommitHash = manifest.parentCommitHash;
      expectedGeneration = manifest.parentGeneration;
    }
    if (expectedGeneration !== 0 || expectedCommitHash !== null) throw new Error("transaction ancestry does not reach generation zero");
    return chain.reverse();
  }

  private async materialize(head: HeadPointerV1): Promise<void> {
    const { directory, manifest } = await this.verifyTransaction(head);
    for (const descriptor of manifest.files) {
      if (descriptor.path === "event.json") continue;
      const source = join(directory, descriptor.path);
      const destination = join(this.runDirectory, descriptor.path);
      const rel = relative(this.runDirectory, destination);
      if (rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`materialized view escapes run: ${descriptor.path}`);
      await mkdir(dirname(destination), { recursive: true });
      const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
      await copyFile(source, temporary);
      await fsyncFile(temporary);
      await rename(temporary, destination);
    }
    const events: string[] = [];
    for (const item of await this.transactionChain(head)) {
      const event = JSON.parse(await readFile(join(item.directory, "event.json"), "utf-8")) as Record<string, unknown>;
      events.push(JSON.stringify({ txId: item.manifest.txId, generation: item.manifest.nextGeneration, ...event }));
    }
    await atomicWrite(join(this.runDirectory, "events.jsonl"), `${events.join("\n")}\n`);
  }
}
