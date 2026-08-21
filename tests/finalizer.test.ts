/**
 * Candidate finalizer tests (refactor Phase 4).
 *
 * The happy path is covered end-to-end by workflows-full tests (byte-
 * compatible text is the oracle). Here we pin the MODEL/control split:
 * proposal construction fails closed, and the finalizer refuses
 * proposals it did not receive from MODEL execution.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildProposal,
  convertProposal,
  type CandidateProposal,
} from "../src/modules/model/finalizer.ts";

const cwd = mkdtempSync(join(tmpdir(), "pi-cad-finalizer-"));
try {
  await test("buildProposal: missing source fails closed with the legacy text", async () => {
    const result = await buildProposal(cwd, "models/ghost.py", "c1");
    assert.ok(!result.ok);
    if (!result.ok && "text" in result) {
      assert.match(result.text, /candidate source does not exist: models\/ghost\.py/);
    }
  });

  await test("buildProposal: broken source surfaces buildFailed structure", async () => {
    mkdirSync(join(cwd, "models"), { recursive: true });
    const source = join(cwd, "models", "broken.py");
    writeFileSync(source, "raise RuntimeError('boom')\n");
    const result = await buildProposal(cwd, "models/broken.py", "c2");
    assert.ok(!result.ok);
    if (!result.ok && "buildFailed" in result) {
      assert.ok(result.buildFailed);
      assert.ok(result.error.length > 0);
      assert.ok(result.details);
    } else {
      assert.fail("expected buildFailed-shaped failure");
    }
  });

  await test("buildProposal: minimal source produces a hashed proposal", async () => {
    const source = join(cwd, "models", "box.py");
    writeFileSync(
      source,
      [
        "from cadctl.model import gen_step",
        "import build123d as bd",
        "result = bd.Box(10, 10, 10)",
      ].join("\n"),
    );
    const result = await buildProposal(cwd, "models/box.py", "c3");
    assert.ok(result.ok, JSON.stringify(result));
    if (result.ok) {
      const proposal: CandidateProposal = result.proposal;
      assert.equal(proposal.kind, "build");
      assert.equal(proposal.label, "c3");
      assert.match(proposal.artifactHash, /^[0-9a-f]{64}$/);
      assert.match(proposal.sourceHash, /^[0-9a-f]{64}$/);
      assert.ok(proposal.envelope.ok);
      assert.ok(proposal.artifactPath.endsWith(".step"));
    }
  });

  await test("convertProposal: missing source fails closed", async () => {
    const result = await convertProposal(cwd, "models/ghost.step", "c4", "stl", "out/ghost.stl");
    assert.ok(!result.ok);
    if (!result.ok && "text" in result) {
      assert.match(result.text, /candidate source does not exist/);
    }
  });
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
