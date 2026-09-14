import { describe, expect, it } from "vitest";
import { simulationStaleReason } from "../src/renderer/src/components/ParaViewFrame";
import type { SimulationMetadata, ViewerSource } from "../src/shared/contracts";

const metadata = (modelSource: string | null): SimulationMetadata => ({
  format: "VTU", source: "result.vtu", pointCount: 4, cellCount: 1,
  bounds: { x: [0, 1], y: [0, 1], z: [0, 1] }, fields: [], modelSource,
});
const model = (sha256: string): Extract<ViewerSource, { kind: "cad" }> => ({
  kind: "cad", id: "head", label: "model", path: "build/tetra.step", role: "authoritative", scope: "head", sha256,
});

describe("simulation result provenance", () => {
  it("keeps a result current only for the exact CAD path and hash", () => {
    expect(simulationStaleReason(metadata("build/tetra.step#sha-a"), model("sha-a"))).toBe("");
    expect(simulationStaleReason(metadata("build/tetra.step#sha-a"), model("sha-b"))).toContain("CAD hash changed");
    expect(simulationStaleReason(metadata("build/other.step#sha-a"), model("sha-a"))).toContain("Result uses");
  });

  it("treats missing model provenance as requiring recomputation", () => {
    expect(simulationStaleReason(metadata(null), model("sha-a"))).toContain("does not record");
  });
});
