import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const repository = resolve(import.meta.dirname, "../../..");
const inspector = resolve(repository, "scripts/desktop-inspect-vtk.py");
const python = resolve(repository, "python/.venv/bin/python");

describe("VTU simulation metadata", () => {
  it("reports fixed mesh, field ranges, units, and model provenance", async () => {
    const { stdout } = await exec(python, [inspector, resolve(repository, "apps/desktop/tests/fixtures/tetra-stress.vtu")]);
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ pointCount: 4, cellCount: 1, bounds: { x: [0, 40], y: [0, 30], z: [0, 12] }, modelSource: "build/tetra.step#sha256-known" });
    expect(result.fields).toEqual([
      { name: "von Mises stress", association: "point", components: 1, min: 10, max: 82, unit: "MPa" },
      { name: "displacement", association: "point", components: 3, min: 0, max: 0.34, unit: "mm" },
    ]);
  });
  it("fails clearly for formats outside the first supported embedded contract", async () => {
    await expect(exec(python, [inspector, resolve(repository, "tests/fixtures/section_box.step")]))
      .rejects.toMatchObject({ stderr: expect.stringContaining("supports ASCII VTK XML .vtu") });
  });
});
