import { createHash } from "node:crypto";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function jsonValue(value: unknown, where = "value"): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${where} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${where}[${index}]`));
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      result[key] = jsonValue(item, `${where}.${key}`);
    }
    return result;
  }
  throw new Error(`${where} is not JSON-serializable`);
}

export function canonicalJson(value: unknown): string {
  const normalized = jsonValue(value);
  const render = (item: JsonValue): string => {
    if (Array.isArray(item)) return `[${item.map(render).join(",")}]`;
    if (item && typeof item === "object") {
      return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${render(item[key]!)}`).join(",")}}`;
    }
    return JSON.stringify(item);
  };
  return render(normalized);
}

export function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
