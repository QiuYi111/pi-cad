import { describe, expect, it } from "vitest";
import { ViewerBackend } from "../electron/main/viewer";
import { toThreeCadShapes } from "../src/renderer/src/lib/cad-scene";
import { preferredSource, sourceForArtifact, sourcesFromCatalog } from "../src/renderer/src/lib/viewer-catalog";

const emptyCatalog = {
  projectId: "", projectHead: { updatedAt: "", artifacts: [] }, currentRun: null, commits: [], simulationRuns: [], parameterManifests: [],
};

/** A bridge that records every Agent API body and answers with one result. */
function agentApiBridge(requests: Array<Record<string, unknown>>, result: unknown) {
  return {
    resolveRuntimePaths: async () => ({ piCadRepo: "/runtime/pi-cad", projectPath: "/projects/bracket" }),
    toRuntimePath: async (path: string) => path,
    homeDirectory: async () => "/home/tester",
    commandPath: async () => "/usr/bin/node",
    exec: async () => ({ stdout: "/projects/bracket\n", stderr: "" }),
    pipe: async (_args: string[], input: string) => {
      requests.push(JSON.parse(input) as Record<string, unknown>);
      return { stdout: `${JSON.stringify({ schema: 1, ok: true, result })}\n`, stderr: "" };
    },
  };
}

describe("desktop viewer bridge", () => {
  it("projects canonical artifacts and simulation observations without inventing identities", () => {
    const sources = sourcesFromCatalog({
      projectId: "phone", projectHead: { updatedAt: "now", artifacts: [{ id: "head", path: "release.step", sha256: "h", role: "authoritative-design" }] },
      currentRun: { id: "r", phase: "build", status: "active", updatedAt: "now", artifacts: [{ id: "candidate:authoritative", path: "candidate.step", sha256: "c", role: "authoritative-candidate-design" }, { id: "scene", path: "presentation.blend", sha256: "b", role: "presentation-scene" }] },
      commits: [], simulationRuns: [{ id: "s", recipeId: "static", status: "completed", outputs: [{ name: "stress", type: "field", path: "stress.vtp", sha256: "f", unit: "MPa" }] }], parameterManifests: [],
    });
    expect(sources.map((source) => source.path)).toEqual(["candidate.step", "presentation.blend", "release.step", "stress.vtp"]);
    expect(preferredSource(sources)?.path).toBe("candidate.step");
    expect(sources).toMatchObject([
      { kind: "cad", scope: "current", role: "authoritative-candidate-design", sha256: "c" },
      { kind: "blender", scope: "current", role: "presentation-scene", sha256: "b" },
      { kind: "cad", scope: "head", role: "authoritative-design", sha256: "h" },
      { kind: "simulation", outputType: "field", runId: "s", sha256: "f", unit: "MPa" },
    ]);
  });

  it("selects the artifact returned by the latest build", () => {
    const sources = sourcesFromCatalog(emptyCatalog, "new-build.step");
    expect(sourceForArtifact(sources, "new-build.step")?.path).toBe("new-build.step");
  });

  it("matches build paths across slash styles", () => {
    const sources = sourcesFromCatalog(emptyCatalog, "C:\\project\\candidate.step");
    expect(sourceForArtifact(sources, "C:/project/candidate.step")?.path).toBe("C:\\project\\candidate.step");
  });
  it("keeps two preserved hashes at the same path as distinct versions", () => {
    const sources = sourcesFromCatalog({ ...emptyCatalog, commits: [
      { id: "v1", name: "Hole 8 mm", parent: null, phase: "review", createdAt: "one", artifacts: [{ id: "part", path: "build/plate.step", sha256: "sha-8", role: "authoritative-design" }] },
      { id: "v2", name: "Hole 10 mm", parent: "v1", phase: "review", createdAt: "two", artifacts: [{ id: "part", path: "build/plate.step", sha256: "sha-10", role: "authoritative-design" }] },
    ] });
    expect(sources.filter((source) => source.kind === "cad")).toMatchObject([
      { scope: "commit", commitId: "v1", path: "build/plate.step", sha256: "sha-8" },
      { scope: "commit", commitId: "v2", path: "build/plate.step", sha256: "sha-10" },
    ]);
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

  it("exports the open STEP to the user-selected destination", async () => {
    let command: string[] = [];
    const bridge = {
      resolveRuntimePaths: async () => ({ piCadRepo: "/runtime/pi-cad", projectPath: "/projects/bracket" }),
      toRuntimePath: async (path: string) => path === "C:\\Users\\Jordan\\Downloads\\bracket.step"
        ? "/mnt/c/Users/Jordan/Downloads/bracket.step"
        : path,
      exec: async (args: string[]) => { command = args; return { stdout: "", stderr: "" }; },
    };

    await new ViewerBackend(bridge as never).exportStep(
      {} as never,
      "/workspace/build/bracket.step",
      "C:\\Users\\Jordan\\Downloads\\bracket.step",
    );

    expect(command).toEqual([
      "cp", "--", "/projects/bracket/build/bracket.step", "/mnt/c/Users/Jordan/Downloads/bracket.step",
    ]);
  });

  it("reads the artifact catalog of the conversation the window shows", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const bridge = agentApiBridge(requests, emptyCatalog);

    await new ViewerBackend(bridge as never, () => "session-a").catalog({ projectPath: "/projects/bracket" } as never);
    // An explicit conversation wins over the window's own.
    await new ViewerBackend(bridge as never, () => "session-a").catalog({ projectPath: "/projects/bracket" } as never, "session-b");
    // The window of a conversation Prime has not opened yet is unbound, and
    // says so: it must not read the project-global run by naming nobody.
    await new ViewerBackend(bridge as never, () => null).catalog({ projectPath: "/projects/bracket" } as never);
    // Only a caller with no window at all (headless, packaged smoke) names no
    // conversation and keeps the legacy project-global pointer.
    await new ViewerBackend(bridge as never).catalog({ projectPath: "/projects/bracket" } as never);

    expect(requests).toEqual([
      { schema: 1, op: "viewer-catalog", sessionId: "session-a" },
      { schema: 1, op: "viewer-catalog", sessionId: "session-b" },
      { schema: 1, op: "viewer-catalog", sessionId: null },
      { schema: 1, op: "viewer-catalog" },
    ]);
  });

  it("scopes every run-authority call of a parameter change to the window's conversation", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const catalog = {
      ...emptyCatalog,
      parameterManifests: [{
        path: "build/part.step.parameters.json",
        sha256: "manifest",
        manifest: {
          schema: 1, modelId: "part", source: { path: "part.py", sha256: "source" }, output: { path: "build/part.step", sha256: "step" },
          parameters: [{ id: "width", type: "number", default: 40, value: 40, min: 20, max: 80, step: 1, unit: "mm" }],
        },
      }],
    };
    const bridge = {
      resolveRuntimePaths: async () => ({ piCadRepo: "/runtime/pi-cad", projectPath: "/projects/bracket" }),
      toRuntimePath: async (path: string) => path,
      homeDirectory: async () => "/home/tester",
      commandPath: async () => "/usr/bin/node",
      exec: async () => ({ stdout: "/projects/bracket\n", stderr: "" }),
      pipe: async (_args: string[], input: string) => {
        const request = JSON.parse(input) as Record<string, unknown>;
        requests.push(request);
        const result = request.op === "viewer-catalog"
          ? catalog
          : request.op === "workflow-current"
            ? { runId: "run-b", workflowId: "mechanical.naked", workflowVersion: "1.0.0", workflowHash: "hash", phase: "work", status: "active", operations: [{ capability: "cad_build_step" }] }
            : {};
        return { stdout: `${JSON.stringify({ schema: 1, ok: true, result })}\n`, stderr: "" };
      },
    };

    await new ViewerBackend(bridge as never, () => "session-b").applyParameters(
      { projectPath: "/projects/bracket" } as never,
      "build/part.step.parameters.json",
      { width: 68 },
    );

    expect(requests.map((request) => request.op)).toEqual(["viewer-catalog", "workflow-current", "model-build"]);
    for (const request of requests) expect(request.sessionId).toBe("session-b");
    expect(requests.at(-1)).toMatchObject({ op: "model-build", source: "part.py", output: "build/part.step", force: true });
  });

  it("refuses a parameter change in a window that has no Prime session yet", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const viewer = new ViewerBackend(agentApiBridge(requests, emptyCatalog) as never, () => null);
    await expect(viewer.applyParameters({ projectPath: "/projects/bracket" } as never, "build/part.step.parameters.json", { width: 68 }))
      .rejects.toThrow(/no workflow yet/);
    // Refusing must not touch anyone: no project run, no other conversation.
    expect(requests).toEqual([]);
  });
});
