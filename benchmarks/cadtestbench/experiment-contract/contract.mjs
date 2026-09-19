#!/usr/bin/env node
/**
 * Versioned experiment contract for the ICLR 2027 Reify submission (RES-345).
 *
 * The JSON file is the single source of truth. Everything else in this
 * directory is derived: this loader canonicalizes it, hashes it, and verifies
 * the recorded hash so a runner without chat context can prove which contract
 * version a batch of runs used.
 *
 * Usage:
 *   node contract.mjs --print-hash
 *   node contract.mjs --write-hash
 *   node contract.mjs --verify
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACT_DIR = fileURLToPath(new URL(".", import.meta.url));
export const CONTRACT_PATH = join(CONTRACT_DIR, "experiment-contract.v1.json");
export const CONTRACT_HASH_PATH = join(CONTRACT_DIR, "experiment-contract.v1.sha256");

/** Stable stringify: object keys sorted, arrays kept in order. */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

export function contractHash(contract) {
  return createHash("sha256").update(canonicalize(contract), "utf8").digest("hex");
}

export function loadContract(path = CONTRACT_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function recordedHash(path = CONTRACT_HASH_PATH) {
  try {
    return readFileSync(path, "utf8").trim().split(/\s+/)[0] ?? null;
  } catch {
    return null;
  }
}

export function verifyContract(path = CONTRACT_PATH, hashPath = CONTRACT_HASH_PATH) {
  const contract = loadContract(path);
  const actual = contractHash(contract);
  const recorded = recordedHash(hashPath);
  return { contract, actual, recorded, ok: recorded !== null && recorded === actual };
}

function main(argv) {
  const command = argv[0] ?? "--verify";
  if (command === "--print-hash") {
    process.stdout.write(`${contractHash(loadContract())}\n`);
    return 0;
  }
  if (command === "--write-hash") {
    const hash = contractHash(loadContract());
    writeFileSync(CONTRACT_HASH_PATH, `${hash}  experiment-contract.v1.json\n`, "utf8");
    process.stdout.write(`${hash}\n`);
    return 0;
  }
  if (command === "--verify") {
    const result = verifyContract();
    process.stdout.write(`contract sha256 ${result.actual}\n`);
    process.stdout.write(`recorded sha256 ${result.recorded ?? "<missing>"}\n`);
    if (!result.ok) {
      process.stderr.write("contract hash mismatch: re-run node contract.mjs --write-hash after an intentional contract change\n");
      return 1;
    }
    return 0;
  }
  process.stderr.write(`unknown command: ${command}\n`);
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
