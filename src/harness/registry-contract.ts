import { canonicalDigest } from "./canonical.ts";
import { contractEntry, REGISTRY_KINDS, type ContractEntry, type RegistryKind, type RegistrySet } from "./registry.ts";

export const KERNEL_PROTOCOL = "pi-cad-harness/7.0";

export type RegistryContractEntries = Record<string, ContractEntry>;

export interface RegistryContractV1 {
  schema: 1;
  kernelProtocol: string;
  hash: string;
  actions: RegistryContractEntries;
  grants: RegistryContractEntries;
  hooks: RegistryContractEntries;
  contextProviders: RegistryContractEntries;
  reviewProfiles: RegistryContractEntries;
  recordTypes: RegistryContractEntries;
  evidenceTypes: RegistryContractEntries;
  recipeKinds: RegistryContractEntries;
  runtimeProfiles: RegistryContractEntries;
}

export interface RegistryCompatibilityIssue {
  kind: RegistryKind | "contract";
  id: string;
  reason: "invalid_hash" | "kernel_protocol" | "missing" | "incompatible";
  pinned?: ContractEntry;
  current?: ContractEntry;
}

function payload(contract: Omit<RegistryContractV1, "hash"> | RegistryContractV1): Omit<RegistryContractV1, "hash"> {
  const { hash: _hash, ...rest } = contract as RegistryContractV1;
  return rest;
}

export function registryContractHash(contract: Omit<RegistryContractV1, "hash"> | RegistryContractV1): string {
  return canonicalDigest(payload(contract));
}

export function buildRegistryContract(registries: RegistrySet): RegistryContractV1 {
  const collections = Object.fromEntries(REGISTRY_KINDS.map((kind) => [
    kind,
    Object.fromEntries(registries[kind].entries().map((registration) => [registration.id, contractEntry(registration)])),
  ])) as Pick<RegistryContractV1, RegistryKind>;
  const body: Omit<RegistryContractV1, "hash"> = { schema: 1, kernelProtocol: KERNEL_PROTOCOL, ...collections };
  return { ...body, hash: registryContractHash(body) };
}

export function verifyRegistryContract(pinned: RegistryContractV1, registries: RegistrySet): RegistryCompatibilityIssue[] {
  const issues: RegistryCompatibilityIssue[] = [];
  if (pinned.hash !== registryContractHash(pinned)) issues.push({ kind: "contract", id: "hash", reason: "invalid_hash" });
  if (pinned.kernelProtocol !== KERNEL_PROTOCOL) issues.push({ kind: "contract", id: "kernelProtocol", reason: "kernel_protocol" });
  for (const kind of REGISTRY_KINDS) {
    for (const [id, expected] of Object.entries(pinned[kind])) {
      const registration = registries[kind].get(id);
      if (!registration) {
        issues.push({ kind, id, reason: "missing", pinned: expected });
        continue;
      }
      const current = contractEntry(registration);
      const exact = current.version === expected.version
        && current.schemaDigest === expected.schemaDigest
        && current.semanticsDigest === expected.semanticsDigest;
      const compatible = registration.contract.compatibleWith?.some((entry) =>
        entry.version === expected.version
        && entry.schemaDigest === expected.schemaDigest
        && entry.semanticsDigest === expected.semanticsDigest,
      ) ?? false;
      if (!exact && !compatible) issues.push({ kind, id, reason: "incompatible", pinned: expected, current });
    }
  }
  return issues;
}

export function assertRegistryContractCompatible(pinned: RegistryContractV1, registries: RegistrySet): void {
  const issues = verifyRegistryContract(pinned, registries);
  if (issues.length) {
    throw new Error(`Registry Contract incompatible: ${issues.map((item) => `${item.kind}:${item.id}:${item.reason}`).join(", ")}`);
  }
}
