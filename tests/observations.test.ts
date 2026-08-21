import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CadEventEnvelope } from "../src/shared/protocol.ts";
import { bundleFromEnvelope, bundleToRecord } from "../src/observations/bundle.ts";
import { observationProfile, profileProjection } from "../src/observations/profiles.ts";
import {
  observeContent,
  renderBundle,
  renderBundleContent,
} from "../src/observations/renderer.ts";

function envelope(overrides: Partial<CadEventEnvelope> = {}): CadEventEnvelope {
  return {
    ok: true,
    tool: "render",
    toolVersion: "0.8.0",
    backendVersion: "build123d 0.7",
    inputHashes: { artifact: "abc123" },
    outputHashes: {},
    durationMs: 42,
    warnings: [],
    artifacts: [],
    payload: {},
    ...overrides,
  };
}

test("bundle: warnings and errors normalize into diagnostics", () => {
  const withWarnings = bundleFromEnvelope(
    envelope({ warnings: ["mesh is coarse"] }),
    { headline: "h" },
  );
  assert.equal(withWarnings.diagnostics.length, 1);
  assert.equal(withWarnings.diagnostics[0].level, "warning");

  const failed = bundleFromEnvelope(
    envelope({ ok: false, payload: { error: "step not found" } }),
    { headline: "h" },
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.diagnostics.at(-1)?.level, "error");
  assert.equal(failed.diagnostics.at(-1)?.message, "step not found");
});

test("bundle: artifacts carry roles and full provenance", () => {
  const bundle = bundleFromEnvelope(
    envelope({
      artifacts: [{ path: "out/a.step", kind: "step", sha256: "deadbeef" }],
    }),
    { headline: "h", artifactRoles: { step: "candidate" } },
  );
  assert.equal(bundle.artifacts[0].role, "candidate");
  assert.equal(bundle.provenance.inputHashes.artifact, "abc123");
  assert.equal(bundle.provenance.backendVersion, "build123d 0.7");
  assert.deepEqual(bundleToRecord(bundle).artifacts, bundle.artifacts);
});

test("profiles: render/measure/interference projections", () => {
  const visual = profileProjection(
    envelope({
      payload: {
        views: [{ name: "iso", path: "evidence/iso.png" }],
        bbox: [0, 0, 0, 10, 10, 10],
        units: "mm",
        solidCount: 1,
      },
    }),
  );
  assert.match(visual.headline, /1 views/);
  assert.equal(visual.visuals[0].name, "iso");
  assert.ok(visual.facts.some((f) => f.key === "bbox" && f.value.includes("10.00")));
  assert.ok(visual.facts.some((f) => f.key === "solids" && f.value === "1"));

  const measured = profileProjection(
    envelope({ tool: "measure", payload: { metric: "distance", value: 32.5, units: "mm" } }),
  );
  assert.match(measured.headline, /32\.500000/);
  assert.ok(measured.facts.some((f) => f.key === "metric"));

  const interference = profileProjection(
    envelope({
      tool: "inspect-interference",
      payload: {
        pairs: [
          { a: "part1", b: "part2", classification: "penetration", intersectionVolume: 4000 },
        ],
      },
    }),
  );
  assert.match(interference.headline, /1 pairs/);
  assert.match(interference.facts[0].value, /penetration/);
  assert.match(interference.facts[0].value, /4000\.000/);
});

test("profiles: unknown tool falls back to bounded generic facts", () => {
  const profile = observationProfile("nonexistent-tool");
  const headline = profile.headline({ error: "x" });
  assert.equal(headline, "x");
  const facts = observationProfile("nonexistent-tool").facts?.({ a: 1, b: "two" }) ?? [];
  assert.deepEqual(
    facts.map((f) => f.key),
    ["a", "b"],
  );
});

test("renderer: visual-first ordering, envelope appendix, artifact lines", () => {
  const bundle = bundleFromEnvelope(
    envelope({
      artifacts: [{ path: "out/a.step", kind: "step", sha256: "deadbeefcafe" }],
    }),
    {
      headline: "render ok",
      facts: [{ key: "bbox", value: "0,0,0" }],
      visuals: [{ name: "iso", path: "x/iso.png" }],
    },
  );

  const rendered = renderBundle(bundle, { includeEnvelope: envelope() });
  assert.equal(rendered.imagePaths.length, 1);
  assert.ok(rendered.text.startsWith("render ok"));
  assert.ok(rendered.text.includes("facts:"));
  assert.ok(rendered.text.includes("  bbox: 0,0,0"));
  assert.ok(rendered.text.includes("provenance: tool=render"));
  assert.ok(rendered.text.includes("sha256:deadbeefcafe"));
  assert.ok(rendered.text.includes('"tool": "render"'));

  const bare = renderBundle(bundle);
  assert.ok(!bare.text.includes('"tool"'));
});

test("renderer: images load and order before text; text-only stays single block", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cad-obs-"));
  try {
    const png = join(dir, "iso.png");
    writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));
    const bundle = bundleFromEnvelope(
      envelope(),
      { headline: "visual", visuals: [{ name: "iso", path: png }] },
    );
    const content = await renderBundleContent(bundle);
    assert.equal(content.length, 2);
    assert.equal(content[0].type, "image");
    assert.equal(content[1].type, "text");

    const textFirst = await renderBundleContent(bundle, { order: "text-first" });
    assert.equal(textFirst[0].type, "text");

    const noImages = await renderBundleContent(
      bundleFromEnvelope(envelope(), { headline: "h" }),
    );
    assert.equal(noImages.length, 1);
    assert.equal(noImages[0].type, "text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("observeContent: profile defaults, envelope appendix on by default", async () => {
  const observed = await observeContent(
    envelope({ payload: { error: "boom" }, ok: false }),
  );
  assert.equal(observed.bundle.ok, false);
  assert.match(observed.content[0].text!, /visual render failed: boom/);
  assert.match(observed.content[0].text!, /\[error\] boom/);
});
