import type {
  ModelParameterDefinition,
  ModelParameterValue,
} from "./contracts";

function check(parameter: ModelParameterDefinition, value: unknown): ModelParameterValue {
  if (parameter.type === "number" || parameter.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`${parameter.id} must be a finite number`);
    }
    if (parameter.type === "integer" && !Number.isInteger(value)) {
      throw new TypeError(`${parameter.id} must be an integer`);
    }
    if ((parameter.min !== undefined && value < parameter.min)
      || (parameter.max !== undefined && value > parameter.max)) {
      throw new RangeError(`${parameter.id} must be between ${parameter.min ?? "-infinity"} and ${parameter.max ?? "infinity"}`);
    }
    return value;
  }
  if (parameter.type === "boolean") {
    if (typeof value !== "boolean") throw new TypeError(`${parameter.id} must be boolean`);
    return value;
  }
  if (typeof value !== "string" || !parameter.options?.some((option) => option.value === value)) {
    throw new TypeError(`${parameter.id} must be a listed option`);
  }
  return value;
}

export function validateParameterValues(
  parameters: ModelParameterDefinition[],
  updates: Record<string, unknown>,
): Record<string, ModelParameterValue> {
  const byId = new Map(parameters.map((parameter) => [parameter.id, parameter]));
  for (const id of Object.keys(updates)) {
    if (!byId.has(id)) throw new TypeError(`${id} is not declared`);
  }
  return Object.fromEntries(parameters.map((parameter) => [
    parameter.id,
    check(parameter, updates[parameter.id] ?? parameter.value),
  ]));
}

export function parameterDefinitionsWithValues(
  parameters: ModelParameterDefinition[],
  updates: Record<string, unknown>,
): Record<string, Omit<ModelParameterDefinition, "id">> {
  const values = validateParameterValues(parameters, updates);
  return Object.fromEntries(parameters.map(({ id, ...definition }) => [
    id,
    { ...definition, value: values[id]! },
  ]));
}
