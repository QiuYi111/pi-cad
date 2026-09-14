import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeModelParameterDefinitions,
  validateModelParameterValues,
} from "../src/shared/model-parameters.ts";

test("model parameters normalize into a deterministic UI contract", () => {
  const contract = normalizeModelParameterDefinitions({
    base_width: {
      default: 75,
      min: 55,
      max: 110,
      step: 1,
      unit: "mm",
      label: "Base width",
      group: "Base",
    },
    enabled: { default: true, label: "Show brace" },
    style: {
      default: "plain",
      options: [
        { value: "plain", label: "Plain" },
        { value: "ribbed", label: "Ribbed" },
      ],
    },
  });

  assert.deepEqual(contract.values, {
    base_width: 75,
    enabled: true,
    style: "plain",
  });
  assert.deepEqual(
    contract.parameters.map(({ id, type, value }) => ({ id, type, value })),
    [
      { id: "base_width", type: "number", value: 75 },
      { id: "enabled", type: "boolean", value: true },
      { id: "style", type: "enum", value: "plain" },
    ],
  );
});

test("model parameter values are checked before executing user source", () => {
  const contract = normalizeModelParameterDefinitions({
    wall: { default: 2, min: 1, max: 6, step: 0.25, unit: "mm" },
    detent: { default: "open", options: [{ value: "open" }, { value: "closed" }] },
  });

  assert.deepEqual(validateModelParameterValues(contract.parameters, { wall: 3.25 }), {
    wall: 3.25,
    detent: "open",
  });
  assert.throws(
    () => validateModelParameterValues(contract.parameters, { wall: 9 }),
    /wall.*between 1 and 6/,
  );
  assert.throws(
    () => validateModelParameterValues(contract.parameters, { detent: "missing" }),
    /detent.*listed option/,
  );
  assert.throws(
    () => normalizeModelParameterDefinitions({ bad: { default: Number.NaN } }),
    /finite number/,
  );
});
