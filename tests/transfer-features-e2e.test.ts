import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { handleTransferOperation } from "../src/agent-api/transfer-ops.ts";
import { resolveFreecadRuntime, runPartCommand, shutdownPartWorkers } from "../src/shared/freecad-worker.ts";

let installed = true;
try { resolveFreecadRuntime(); } catch { installed = false; }

after(() => shutdownPartWorkers());

test("transfer-features builds the canonical JSON from a real FreeCAD document", { skip: !installed && "FreeCAD is not installed" }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "transfer-e2e-"));
  try {
    await mkdir(join(cwd, "parts"), { recursive: true });
    const doc = join(cwd, "parts", "plate.FCStd");
    await runPartCommand(cwd, { op: "open", doc, args: { output: join(cwd, "build", "plate.step"), historyDir: join(cwd, ".h"), root: cwd, body: "plate", create: true } });
    await runPartCommand(cwd, { op: "apply", doc, args: { ops: [
      { op: "param", name: "w", value: 40, unit: "mm" },
      { op: "sketch", name: "plate/prof", plane: "XY", shapes: [{ rect: { center: [0, 0], size: ["=w", 30] } }] },
      { op: "pad", name: "plate/base", sketch: "plate/prof", length: 5 },
      { op: "sketch", name: "plate/hs", plane: "XY", offset: 5, shapes: [{ circle: { center: [10, 8], diameter: 6 } }, { circle: { center: [-10, 8], diameter: 6 } }] },
      { op: "pocket", name: "plate/holes", sketch: "plate/hs", type: "through_all", depth: 5 },
    ] } });
    const result = await handleTransferOperation(cwd, { schema: 1, op: "transfer-features", doc: "parts/plate.FCStd" }) as any;
    assert.equal(result.features, 2);
    const json = JSON.parse(readFileSync(join(cwd, result.path), "utf8"));
    assert.equal(json.schema, "reify.features/1");
    assert.deepEqual(json.bodies[0].features.map((f: any) => [f.name, f.type, f.direction]), [["plate/base", "pad", [0, 0, 1]], ["plate/holes", "pocket", [0, 0, -1]]]);
    assert.equal(json.reference.feature_volumes.length, 2);
    assert.ok(existsSync(join(cwd, result.path)));
  } finally {
    shutdownPartWorkers();
    await rm(cwd, { recursive: true, force: true });
  }
});
