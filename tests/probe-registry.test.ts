import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ensureProbePresets,
  probePreset,
  probePresetNames,
  renderProbeResult,
} from "../src/modules/probe/index.ts";
import type { CadEventEnvelope } from "../src/shared/protocol.ts";

function okEnvelope(tool: string, payload: Record<string, unknown> = {}): CadEventEnvelope {
  return {
    ok: true,
    tool,
    toolVersion: "0.8.0",
    inputHashes: { artifact: "hash-a" },
    outputHashes: {},
    durationMs: 5,
    warnings: [],
    artifacts: [{ path: "out.json", kind: "json", sha256: "beef" }],
    payload,
  };
}

test("registry: builtin presets register exactly once and are enumerable", () => {
  ensureProbePresets();
  ensureProbePresets(); // idempotent
  const names = probePresetNames();
  for (const expected of [
    "visual",
    "geometry",
    "surfaces",
    "measure",
    "section",
    "sections-scan",
    "compare",
    "assembly",
    "interference",
  ]) {
    assert.ok(names.includes(expected), `missing preset ${expected}`);
  }
  for (const name of names) {
    assert.ok(probePreset(name), `preset ${name} must resolve`);
  }
});

test("renderProbeResult: success carries observation + kind + artifact hash", async () => {
  const rendered = await renderProbeResult(
    {
      envelope: okEnvelope("inspect", { volume: 1000 }),
      kind: "geometry",
      headline: "geometry facts: part.step",
      includeEnvelope: false,
    },
    "cad_inspect_geometry",
  );
  const text = rendered.content.find((c) => c.type === "text")!.text!;
  assert.ok(text.startsWith("geometry facts: part.step"));
  assert.ok(text.includes("provenance: tool=inspect"));
  assert.equal(rendered.details.kind, "geometry");
  assert.equal(rendered.details.artifactHash, "hash-a");
  assert.ok((rendered.details.observation as Record<string, unknown>).headline);
});

test("renderProbeResult: failure renders <label> failed with error", async () => {
  const envelope = okEnvelope("inspect");
  envelope.ok = false;
  envelope.payload = { error: "step not found" };
  const rendered = await renderProbeResult(
    { envelope, headline: "x" },
    "cad_inspect_geometry",
  );
  assert.match(rendered.content[0].text!, /^cad_inspect_geometry failed: step not found/);
  assert.equal(rendered.details.presetFailed, true);
});

test("renderProbeResult: explicit facts override profile projection", async () => {
  const rendered = await renderProbeResult(
    {
      envelope: okEnvelope("inspect-surfaces", {}),
      headline: "surface facts",
      facts: [{ key: "f0", value: "plane area=12.0" }],
      includeEnvelope: false,
    },
  );
  const text = rendered.content.find((c) => c.type === "text")!.text!;
  assert.ok(text.includes("f0: plane area=12.0"));
});

test("presets: geometry preset hits cadctl through the real backend", async () => {
  ensureProbePresets();
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-probe-"));
  try {
    // Reuse the interference contact fixture as a tiny STEP assembly.
    const fixture = readFileSync(new URL("./fixtures/interference_contact.step", import.meta.url));
    mkdirSync(join(cwd, "build"), { recursive: true });
    const artifact = join(cwd, "build", "part.step");
    writeFileSync(artifact, fixture);

    const geometry = probePreset("geometry")!;
    const result = await geometry.run({ artifact }, { cwd });
    assert.ok(result.envelope.ok, `cadctl inspect failed: ${JSON.stringify(result.envelope.payload)}`);
    assert.equal(result.kind, "geometry");

    const rendered = await renderProbeResult(result, "cad_inspect_geometry");
    assert.ok((rendered.details.artifactHash as string).length > 0);
    const text = rendered.content.find((c) => c.type === "text")!.text!;
    assert.ok(text.includes("facts:"), "observation facts section present");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
