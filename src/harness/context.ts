import { performance } from "node:perf_hooks";

import type { JsonValue } from "./canonical.ts";
import type { RegistrySet } from "./registry.ts";
import { TransactionStore } from "./transaction-store.ts";

export interface ContextSnapshotReader {
  readProject(): Promise<JsonValue | null>;
  readState(): Promise<JsonValue | null>;
  readWorkflow(): Promise<JsonValue | null>;
  readRegistryContract(): Promise<JsonValue | null>;
  readIndex(name: string): Promise<JsonValue | null>;
  readContextFrame(): Promise<JsonValue | null>;
}

export interface ContextFragment {
  text: string;
}

export interface ContextProviderContract {
  id: string;
  version: string;
  maxBytesRead: number;
  maxBytesEmitted: number;
  render(reader: ContextSnapshotReader): Promise<ContextFragment>;
}

export interface ContextProviderMetrics {
  providerId: string;
  durationMs: number;
  bytesRead: number;
  bytesEmitted: number;
  cacheHit: boolean;
  truncated: boolean;
}

interface ReaderCounters {
  bytesRead: number;
  cacheHits: number;
}

const READ_LIMITS = {
  project: 128 * 1024,
  state: 256 * 1024,
  workflow: 512 * 1024,
  registry: 512 * 1024,
  index: 512 * 1024,
  frame: 128 * 1024,
} as const;

class RestrictedContextSnapshotReader implements ContextSnapshotReader {
  private readonly cache = new Map<string, JsonValue | null>();
  private countersValue: ReaderCounters = { bytesRead: 0, cacheHits: 0 };

  constructor(
    private readonly project: TransactionStore,
    private readonly run: TransactionStore | null,
    private readonly allowedIndexes: ReadonlySet<string>,
  ) {}

  counters(): ReaderCounters { return { ...this.countersValue }; }

  readProject(): Promise<JsonValue | null> { return this.read("project:state", this.project, "state.json", READ_LIMITS.project); }
  readState(): Promise<JsonValue | null> { return this.read("run:state", this.run, "state.json", READ_LIMITS.state); }
  readWorkflow(): Promise<JsonValue | null> { return this.read("run:workflow", this.run, "workflow.json", READ_LIMITS.workflow); }
  readRegistryContract(): Promise<JsonValue | null> { return this.read("run:registry", this.run, "registry-contract.json", READ_LIMITS.registry); }
  readContextFrame(): Promise<JsonValue | null> { return this.read("run:frame", this.run, "context/frame.json", READ_LIMITS.frame); }

  readIndex(name: string): Promise<JsonValue | null> {
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || !this.allowedIndexes.has(name)) throw new Error(`context index is not registered: ${name}`);
    return this.read(`run:index:${name}`, this.run, `indexes/${name}.json`, READ_LIMITS.index);
  }

  private async read(key: string, store: TransactionStore | null, path: string, maxBytes: number): Promise<JsonValue | null> {
    if (this.cache.has(key)) {
      this.countersValue.cacheHits += 1;
      return this.cache.get(key)!;
    }
    if (!store) {
      this.cache.set(key, null);
      return null;
    }
    const content = await store.readPayloadBounded(path, maxBytes);
    this.countersValue.bytesRead += content?.length ?? 0;
    const value = content ? JSON.parse(content.toString("utf-8")) as JsonValue : null;
    this.cache.set(key, value);
    return value;
  }
}

export class ContextMetricsRing {
  private readonly values: ContextProviderMetrics[] = [];
  constructor(readonly capacity = 256) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error("context metrics capacity must be positive");
  }
  push(metric: ContextProviderMetrics): void {
    this.values.push(metric);
    if (this.values.length > this.capacity) this.values.splice(0, this.values.length - this.capacity);
  }
  snapshot(): ContextProviderMetrics[] { return this.values.map((value) => ({ ...value })); }
}

export class ContextCompiler {
  private readonly providers = new Map<string, ContextProviderContract>();
  readonly metrics: ContextMetricsRing;

  constructor(private readonly registries: RegistrySet, metrics = new ContextMetricsRing()) {
    this.metrics = metrics;
  }

  register(provider: ContextProviderContract): void {
    if (this.providers.has(provider.id)) throw new Error(`duplicate Context Provider: ${provider.id}`);
    if (!Number.isInteger(provider.maxBytesRead) || provider.maxBytesRead <= 0 || !Number.isInteger(provider.maxBytesEmitted) || provider.maxBytesEmitted <= 0) throw new Error(`invalid Context Provider budgets: ${provider.id}`);
    const registration = this.registries.contextProviders.require(provider.id);
    if (registration.contract.version !== provider.version) throw new Error(`Context Provider version mismatch: ${provider.id}`);
    const semantics = registration.contract.semantics as Record<string, unknown>;
    if (typeof semantics.maxBytesRead === "number" && provider.maxBytesRead > semantics.maxBytesRead) throw new Error(`Context Provider read budget exceeds registry: ${provider.id}`);
    if (typeof semantics.maxBytesEmitted === "number" && provider.maxBytesEmitted > semantics.maxBytesEmitted) throw new Error(`Context Provider emit budget exceeds registry: ${provider.id}`);
    this.providers.set(provider.id, provider);
  }

  async compile(input: {
    project: TransactionStore;
    run: TransactionStore | null;
    providerIds: string[];
    allowedIndexes: ReadonlySet<string>;
    aggregateReadBudget: number;
    aggregateEmitBudget: number;
  }): Promise<{ text: string; metrics: ContextProviderMetrics[] }> {
    const reader = new RestrictedContextSnapshotReader(input.project, input.run, input.allowedIndexes);
    const metrics: ContextProviderMetrics[] = [];
    const fragments: string[] = [];
    let totalRead = 0;
    let totalEmitted = 0;
    for (const id of input.providerIds) {
      const provider = this.providers.get(id);
      if (!provider) throw new Error(`Context Provider has no implementation: ${id}`);
      const before = reader.counters();
      const started = performance.now();
      const fragment = await provider.render(reader);
      const after = reader.counters();
      const bytesRead = after.bytesRead - before.bytesRead;
      if (bytesRead > provider.maxBytesRead) throw new Error(`Context Provider exceeded read budget: ${id}`);
      let content = Buffer.from(fragment.text, "utf-8");
      const truncated = content.length > provider.maxBytesEmitted;
      if (truncated) content = content.subarray(0, provider.maxBytesEmitted);
      const text = content.toString("utf-8");
      const metric: ContextProviderMetrics = {
        providerId: id,
        durationMs: performance.now() - started,
        bytesRead,
        bytesEmitted: Buffer.byteLength(text),
        cacheHit: after.cacheHits > before.cacheHits,
        truncated,
      };
      totalRead += metric.bytesRead;
      totalEmitted += metric.bytesEmitted;
      if (totalRead > input.aggregateReadBudget) throw new Error("Context Compiler exceeded aggregate read budget");
      if (totalEmitted > input.aggregateEmitBudget) throw new Error("Context Compiler exceeded aggregate emit budget");
      metrics.push(metric);
      this.metrics.push(metric);
      if (text.trim()) fragments.push(text.trim());
    }
    return { text: fragments.join("\n\n"), metrics };
  }
}
