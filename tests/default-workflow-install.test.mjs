import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { installDefaultWorkflow } from "../scripts/install-default-workflow.mjs";

test("install and upgrade the shipped workflow while preserving user edits", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-install-"));
  const source = new URL("../workflow-packages/mechanical/default.yaml", import.meta.url);
  const destination = join(root, "default.yaml");
  const current = readFileSync(source, "utf8");
  try {
    assert.equal(installDefaultWorkflow(source, destination), true);
    assert.equal(readFileSync(destination, "utf8"), current);
    const previous = current.replaceAll("4.0.1", "4.0.0").replaceAll("Python REPL", "IPython").replaceAll("rlm.spawn(", "rlm(");
    writeFileSync(destination, previous);
    assert.equal(installDefaultWorkflow(source, destination), true);
    assert.equal(readFileSync(destination, "utf8"), current);
    writeFileSync(destination, previous + "\n# My custom workflow\n");
    assert.equal(installDefaultWorkflow(source, destination), false);
    assert.match(readFileSync(destination, "utf8"), /My custom workflow/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
