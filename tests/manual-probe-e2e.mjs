// E2E: load the unified probe extension through a fake pi, drive a routed
// state, call cad_probe preset=python, and assert immutability + subject fence.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cwd = mkdtempSync(join(tmpdir(), "probe-e2e-"));
try {
  const { default: ext } = await import("../src/extensions/probe/index.ts");
  const tools = new Map();
  const pi = {
    registerTool: (t) => tools.set(t.name, t),
    registerCommand: () => {},
    on: () => {},
  };
  ext(pi);
  const probe = tools.get("cad_probe");
  if (!probe) throw new Error("cad_probe not registered");

  const stateDir = join(cwd, ".pi-cad", "runs", "r1");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(cwd, ".pi-cad", "project.json"), JSON.stringify({
    schemaVersion: 5, projectId: "p", head: {}, currentRunId: "r1",
    createdAt: "x", updatedAt: "x",
  }));
  const fixture = readFileSync(new URL("../tests/fixtures/interference_contact.step", import.meta.url));
  const artifactPath = join(cwd, "build", "part.step");
  mkdirSync(join(cwd, "build"), { recursive: true });
  writeFileSync(artifactPath, fixture);
  const before = {
    schemaVersion: 5, runId: "r1", projectId: "p", createdAt: "x", updatedAt: "x",
    route: { objective: "design", lineage: "greenfield", structure: "part", maturity: "prototype" },
    phase: "review", status: "active", mutationPolicy: "read_only",
    evidence: [], staleEvidence: [],
    currentArtifactPath: "build/part.step",
  };
  writeFileSync(join(stateDir, "state.json"), JSON.stringify(before));

  const result = await probe.execute("t1", {
    preset: "python",
    subject: "current",
    purpose: "shape factor check",
    code: [
      "bb = shape.bounding_box()",
      "result = {'volume': shape.volume, 'shape_factor': shape.volume / (bb.size.X*bb.size.Y*bb.size.Z), 'solids': len(shape.solids())}",
    ].join("\n"),
  }, undefined, undefined, { cwd });
  console.log("TOOL OUTPUT:", result.content[0].text.slice(0, 260));
  console.log("details.kind present?", "kind" in (result.details ?? {}));
  console.log("subjectArtifactHash:", (result.details ?? {}).subjectArtifactHash?.slice(0, 12));

  const after = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
  console.log("state unchanged:", JSON.stringify(after) === JSON.stringify(before));

  const b = await probe.execute("t2", { preset: "python", subject: "baseline", purpose: "x", code: "result = 1" }, undefined, undefined, { cwd });
  console.log("baseline-unbound:", b.content[0].text.slice(0, 80));
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
