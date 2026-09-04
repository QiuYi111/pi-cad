export type ModelParameterValue = number | string | boolean;

export type ModelParameterType = "number" | "integer" | "boolean" | "enum";

export interface ModelParameterOption {
  value: string;
  label?: string;
}

export interface ModelParameterDefinitionInput {
  type?: ModelParameterType;
  default: ModelParameterValue;
  value?: ModelParameterValue;
  min?: number;
  max?: number;
  step?: number;
  options?: ModelParameterOption[];
  unit?: string;
  label?: string;
  description?: string;
  group?: string;
}

export interface ModelParameterDefinition
  extends Omit<ModelParameterDefinitionInput, "type" | "value" | "options"> {
  id: string;
  type: ModelParameterType;
  value: ModelParameterValue;
  options?: ModelParameterOption[];
}

export interface ModelParameterContract {
  parameters: ModelParameterDefinition[];
  values: Record<string, ModelParameterValue>;
}

export interface ModelParameterManifestV1 {
  schema: 1;
  modelId: string;
  source: { path: string; sha256: string; entrypoint: "build" };
  output: { path: string; sha256: string };
  parameters: ModelParameterDefinition[];
}

export interface StoredModelParameterManifest {
  path: string;
  sha256: string;
  manifest: ModelParameterManifestV1;
}

const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const MAX_PARAMETERS = 64;
const MAX_TEXT_LENGTH = 240;

function fail(id: string, message: string): never {
  throw new TypeError(`model parameter ${id}: ${message}`);
}

function boundedText(id: string, field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_LENGTH) {
    fail(id, `${field} must be 1-${MAX_TEXT_LENGTH} characters`);
  }
  return value;
}

function finiteNumber(id: string, field: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(id, `${field} must be a finite number`);
  }
  return value;
}

function inferType(id: string, input: ModelParameterDefinitionInput): ModelParameterType {
  if (input.type) return input.type;
  if (input.options) return "enum";
  if (typeof input.default === "number") return "number";
  if (typeof input.default === "boolean") return "boolean";
  if (typeof input.default === "string") return "enum";
  return fail(id, "default must be a number, string, or boolean");
}

function checkValue(
  parameter: Pick<ModelParameterDefinition, "id" | "type" | "min" | "max" | "options">,
  value: unknown,
): ModelParameterValue {
  const { id, type, min, max, options } = parameter;
  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail(id, "value must be a finite number");
    }
    if (type === "integer" && !Number.isInteger(value)) {
      fail(id, "value must be an integer");
    }
    if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
      fail(id, `value must be between ${min ?? "-infinity"} and ${max ?? "infinity"}`);
    }
    return value;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") fail(id, "value must be boolean");
    return value;
  }
  if (typeof value !== "string") fail(id, "value must be a string");
  if (!options?.some((option) => option.value === value)) {
    fail(id, "value must be a listed option");
  }
  return value;
}

export function normalizeModelParameterDefinitions(
  definitions: Record<string, ModelParameterDefinitionInput>,
): ModelParameterContract {
  if (!definitions || typeof definitions !== "object" || Array.isArray(definitions)) {
    throw new TypeError("model parameters must be an object");
  }
  const entries = Object.entries(definitions);
  if (entries.length === 0) throw new TypeError("model parameters cannot be empty");
  if (entries.length > MAX_PARAMETERS) {
    throw new TypeError(`model parameters cannot exceed ${MAX_PARAMETERS}`);
  }

  const parameters = entries.map(([id, input]) => {
    if (!ID_PATTERN.test(id)) fail(id, "id is invalid");
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      fail(id, "definition must be an object");
    }
    const type = inferType(id, input);
    const min = finiteNumber(id, "min", input.min);
    const max = finiteNumber(id, "max", input.max);
    const step = finiteNumber(id, "step", input.step);
    if (min !== undefined && max !== undefined && min > max) fail(id, "min cannot exceed max");
    if (step !== undefined && step <= 0) fail(id, "step must be positive");
    if ((type === "boolean" || type === "enum") && (min !== undefined || max !== undefined || step !== undefined)) {
      fail(id, `${type} parameters cannot define numeric bounds`);
    }

    let options: ModelParameterOption[] | undefined;
    if (type === "enum") {
      if (!Array.isArray(input.options) || input.options.length === 0) {
        fail(id, "enum parameters require options");
      }
      const seen = new Set<string>();
      options = input.options.map((option) => {
        if (!option || typeof option !== "object" || typeof option.value !== "string") {
          fail(id, "each option needs a string value");
        }
        const value = boundedText(id, "option value", option.value)!;
        if (seen.has(value)) fail(id, `duplicate option ${value}`);
        seen.add(value);
        return {
          value,
          ...(option.label === undefined
            ? {}
            : { label: boundedText(id, "option label", option.label) }),
        };
      });
    } else if (input.options !== undefined) {
      fail(id, "options are only valid for enum parameters");
    }

    const parameter: ModelParameterDefinition = {
      id,
      type,
      default: input.default,
      value: input.value ?? input.default,
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
      ...(step === undefined ? {} : { step }),
      ...(options === undefined ? {} : { options }),
      ...(input.unit === undefined ? {} : { unit: boundedText(id, "unit", input.unit) }),
      ...(input.label === undefined ? {} : { label: boundedText(id, "label", input.label) }),
      ...(input.description === undefined
        ? {}
        : { description: boundedText(id, "description", input.description) }),
      ...(input.group === undefined ? {} : { group: boundedText(id, "group", input.group) }),
    };
    parameter.default = checkValue(parameter, parameter.default);
    parameter.value = checkValue(parameter, parameter.value);
    return parameter;
  });

  return {
    parameters,
    values: Object.fromEntries(parameters.map((parameter) => [parameter.id, parameter.value])),
  };
}

export function validateModelParameterValues(
  parameters: ModelParameterDefinition[],
  updates: Record<string, unknown>,
): Record<string, ModelParameterValue> {
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    throw new TypeError("model parameter values must be an object");
  }
  const byId = new Map(parameters.map((parameter) => [parameter.id, parameter]));
  for (const id of Object.keys(updates)) {
    if (!byId.has(id)) fail(id, "is not declared");
  }
  return Object.fromEntries(
    parameters.map((parameter) => [
      parameter.id,
      checkValue(parameter, updates[parameter.id] ?? parameter.value),
    ]),
  );
}
