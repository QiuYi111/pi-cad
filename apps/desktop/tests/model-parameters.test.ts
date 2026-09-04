import { describe, expect, it } from "vitest";

import { parameterDefinitionsWithValues, validateParameterValues } from "../src/shared/model-parameters";

const parameters = [
  { id: "width", type: "number" as const, default: 40, value: 40, min: 20, max: 80, step: 1, unit: "mm" },
  { id: "brace", type: "boolean" as const, default: true, value: true },
  { id: "style", type: "enum" as const, default: "plain", value: "plain", options: [{ value: "plain" }, { value: "ribbed" }] },
];

describe("desktop model parameters", () => {
  it("validates patches and fills untouched values", () => {
    expect(validateParameterValues(parameters, { width: 55, style: "ribbed" })).toEqual({
      width: 55,
      brace: true,
      style: "ribbed",
    });
    expect(() => validateParameterValues(parameters, { width: 200 })).toThrow(/width.*20.*80/);
    expect(() => validateParameterValues(parameters, { unknown: 1 })).toThrow(/unknown.*not declared/);
  });

  it("rebuilds the public definition record with current values", () => {
    expect(parameterDefinitionsWithValues(parameters, { width: 55 }).width).toMatchObject({
      type: "number",
      default: 40,
      value: 55,
      min: 20,
      max: 80,
    });
  });
});
