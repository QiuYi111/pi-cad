import { canonicalDigest, canonicalJson, jsonValue, type JsonValue } from "./canonical.ts";

export const REGISTRY_KINDS = [
  "actions",
  "grants",
  "hooks",
  "contextProviders",
  "reviewProfiles",
  "recordTypes",
  "evidenceTypes",
  "recipeKinds",
  "runtimeProfiles",
] as const;

export type RegistryKind = (typeof REGISTRY_KINDS)[number];

export interface CompatibleContract {
  version: string;
  schemaDigest: string;
  semanticsDigest: string;
}

export interface RegistrationContract {
  version: string;
  schema: JsonValue;
  semantics: JsonValue;
  compatibleWith?: CompatibleContract[];
}

export interface Registration<T = unknown> {
  id: string;
  contract: RegistrationContract;
  implementation?: T;
}

export interface ContractEntry {
  version: string;
  schemaDigest: string;
  semanticsDigest: string;
}

const ID = /^[a-z][a-z0-9_]*(?:[.:/-][a-z0-9_]+)*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/;
const DIGEST = /^[a-f0-9]{64}$/;

function normalize<T>(registration: Registration<T>): Registration<T> {
  if (!ID.test(registration.id)) throw new Error(`invalid registry ID: ${registration.id}`);
  if (!VERSION.test(registration.contract.version)) throw new Error(`invalid contract version for ${registration.id}: ${registration.contract.version}`);
  const schema = jsonValue(registration.contract.schema, `${registration.id}.schema`);
  const semantics = jsonValue(registration.contract.semantics, `${registration.id}.semantics`);
  const compatibleWith = registration.contract.compatibleWith?.map((entry) => {
    if (!VERSION.test(entry.version) || !DIGEST.test(entry.schemaDigest) || !DIGEST.test(entry.semanticsDigest)) {
      throw new Error(`invalid compatibility declaration for ${registration.id}`);
    }
    return { ...entry };
  });
  return {
    ...registration,
    contract: {
      version: registration.contract.version,
      schema,
      semantics,
      ...(compatibleWith?.length ? { compatibleWith } : {}),
    },
  };
}

export function contractEntry(registration: Registration): ContractEntry {
  return {
    version: registration.contract.version,
    schemaDigest: canonicalDigest(registration.contract.schema),
    semanticsDigest: canonicalDigest(registration.contract.semantics),
  };
}

/** Strict, deterministic registry. Implementations are deliberately not hashed. */
export class StrictRegistry<T = unknown> {
  private readonly values = new Map<string, Registration<T>>();
  private frozen = false;

  constructor(readonly kind: RegistryKind) {}

  register(registration: Registration<T>): Registration<T> {
    if (this.frozen) throw new Error(`${this.kind} registry is frozen`);
    const value = normalize(registration);
    if (this.values.has(value.id)) throw new Error(`duplicate ${this.kind} registration: ${value.id}`);
    this.values.set(value.id, value);
    return value;
  }

  /** Runtime extension instances may re-register the same immutable tool contract. */
  registerIdempotent(registration: Registration<T>): Registration<T> {
    if (this.frozen) {
      const existing = this.get(registration.id);
      if (!existing) throw new Error(`${this.kind} registry is frozen`);
      const candidate = normalize(registration);
      if (canonicalJson(contractEntry(existing)) !== canonicalJson(contractEntry(candidate))) {
        throw new Error(`incompatible duplicate ${this.kind} registration: ${candidate.id}`);
      }
      return existing;
    }
    const existing = this.values.get(registration.id);
    if (!existing) return this.register(registration);
    const candidate = normalize(registration);
    if (canonicalJson(contractEntry(existing)) !== canonicalJson(contractEntry(candidate))) {
      throw new Error(`incompatible duplicate ${this.kind} registration: ${candidate.id}`);
    }
    return existing;
  }

  get(id: string): Registration<T> | undefined {
    return this.values.get(id);
  }

  require(id: string): Registration<T> {
    const value = this.get(id);
    if (!value) throw new Error(`unknown ${this.kind} registration: ${id}`);
    return value;
  }

  entries(): Registration<T>[] {
    return [...this.values.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  freeze(): this {
    this.frozen = true;
    return this;
  }

  get isFrozen(): boolean {
    return this.frozen;
  }
}

export type RegistrySet = { [K in RegistryKind]: StrictRegistry };

export function createRegistrySet(): RegistrySet {
  return Object.fromEntries(REGISTRY_KINDS.map((kind) => [kind, new StrictRegistry(kind)])) as RegistrySet;
}
