import { describe, expect, it } from "vitest";
import { ViewerBackend } from "../electron/main/viewer";
import { toThreeCadShapes } from "../src/renderer/src/lib/cad-scene";
import { preferredSource, sourcesFromCatalog } from "../src/renderer/src/lib/viewer-catalog";

describe("desktop viewer bridge", () => {
  it("projects canonical artifacts and simulation observations without inventing identities", () => {
    const sources = sourcesFromCatalog({
      projectId: "phone", projectHead: { updatedAt: "now", artifacts: [{ id: "head", path: "release.step", sha256: "h", role: "authoritative-design" }] },
      currentRun: { id: "r", phase: "build", status: "active", updatedAt: "now", artifacts: [{ id: "candidate:authoritative", path: "candidate.step", sha256: "c", role: "authoritative-candidate-design" }] },
      commits: [], simulationRuns: [{ id: "s", recipeId: "static", status: "completed", outputs: [{ name: "stress", type: "field", path: "stress.vtp", sha256: "f", unit: "MPa" }] }],
    });
    expect(sources.map((source) => source.path)).toEqual(["candidate.step", "release.step", "stress.vtp"]);
    expect(preferredSource(sources)?.path).toBe("candidate.step");
  });
  it("adapts STEP tessellation to the open-source Z-up CAD scene protocol", () => {
    const scene = toThreeCadShapes({
      source: "/project/bracket.step",
      parts: [{ name: "Bracket", positions: [0,0,0, 1,0,0, 0,1,0], indices: [0,1,2], color: "#ffffff" }],
      bounds: { min: [0,0,0], max: [1,1,0] },
    });
    expect(scene.name).toBe("bracket.step");
    expect(scene.parts?.[0]?.state).toEqual([1, 1]);
    expect(scene.parts?.[0]?.shape && "triangles_per_face" in scene.parts[0].shape ? scene.parts[0].shape.triangles_per_face : []).toEqual([1]);
    expect(scene.bb).toMatchObject({ xmin: 0, ymax: 1, zmax: 0 });
  });

  it("maps sandbox artifacts back into the active project", async () => {
    let command: string[] = [];
    const bridge = {
      resolveRuntimePaths: async () => ({ piCadRepo: "/runtime/pi-cad", projectPath: "/projects/bracket" }),
      toRuntimePath: async (path: string) => path,
      exec: async (args: string[]) => { command = args; return { stdout: JSON.stringify({ source: args.at(-1), parts: [], bounds: { min: [0,0,0], max: [1,1,1] } }), stderr: "" }; },
    };
    const result = await new ViewerBackend(bridge as never).loadStep({} as never, "/workspace/build/part.step");
    expect(command.slice(0, 2)).toEqual(["/runtime/pi-cad/python/.venv/bin/python", "/runtime/pi-cad/scripts/desktop-export-mesh.py"]);
    expect(command.at(-1)).toBe("/projects/bracket/build/part.step");
    expect(result.source).toBe("/projects/bracket/build/part.step");
  });

  it("uses the converter extracted from the packaged runtime", async () => {
    let command: string[] = [];
    const bridge = {
      bundledRuntimePath: "C:\\Pi-CAD\\resources\\runtime",
      resolveRuntimePaths: async () => ({ piCadRepo: "/installed/pi-cad", projectPath: "/project" }),
      toRuntimePath: async (path: string) => path.startsWith("C:") ? "/mnt/c/Pi-CAD/resources/runtime" : path,
      exec: async (args: string[]) => { command = args; return { stdout: JSON.stringify({ source: args.at(-1), parts: [], bounds: { min: [0,0,0], max: [1,1,1] } }), stderr: "" }; },
    };
    await new ViewerBackend(bridge as never).loadStep({} as never, "/project/model.step");
    expect(command[0]).toBe("/installed/pi-cad/python/.venv/bin/python");
    expect(command[1]).toBe("/installed/pi-cad/scripts/desktop-export-mesh.py");
  });

  it("rejects models outside the active project", async () => {
    const bridge = {
      resolveRuntimePaths: async () => ({ piCadRepo: "/runtime/pi-cad", projectPath: "/projects/bracket" }),
      toRuntimePath: async () => "/etc/passwd.step",
    };
    await expect(new ViewerBackend(bridge as never).loadStep({} as never, "/etc/passwd.step")).rejects.toThrow(/active project/);
  });
});
