import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Check } from "typebox/value";

interface MockPi {
  tools: Map<string, any>;
  registerTool(tool: { name: string }): void;
  registerCommand(): void;
  on(): void;
  setActiveTools(): void;
  appendEntry(): void;
  sendUserMessage(): void;
  setSessionName(): void;
  events: { emit(): void; on(): void };
}

function mockPi(): MockPi {
  const pi: MockPi = {
    tools: new Map(),
    registerTool(tool) {
      pi.tools.set(tool.name, tool);
    },
    registerCommand() {},
    on() {},
    setActiveTools() {},
    appendEntry() {},
    sendUserMessage() {},
    setSessionName() {},
    events: { emit() {}, on() {} },
  };
  return pi;
}

test("cad_generate_drawing takes structured arguments and canonicalizes the spec", async () => {
  const pi = mockPi();
  const drawing = (await import("../src/extensions/drawing/index.ts")).default;
  drawing(pi as any);
  const tool = pi.tools.get("cad_generate_drawing");
  assert.ok(tool, "cad_generate_drawing is registered");

  const keys = Object.keys(tool.parameters.properties);
  assert.ok(!keys.includes("spec"));
  assert.ok(!keys.includes("outputDir"));
  assert.ok(keys.includes("artifact"));
  assert.ok(keys.includes("views"));
  assert.ok(keys.includes("dimensions"));

  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-drawing-tool-"));
  try {
    // Produce a real STEP artifact so the drawing backend can import it.
    // Spawn through the harness's own Python resolution (venv when present)
    // so the test passes on fresh installs and CI.
    const { buildStep } = await import("../src/shared/capability.ts");
    await buildStep(cwd, { source: join(process.cwd(), "tests/fixtures/plate.py"), output: join(cwd, "plate.step"), force: true });

    const result = await tool.execute(
      "d1",
      {
        stage: "generate",
        artifact: "plate.step",
        views: [
          { name: "front", scale: 1.0 },
          { name: "top" },
        ],
        dimensions: [
          {
            p1: [20, 20],
            p2: [120, 20],
            text: "100",
            featureRefs: ["#p0", "#p1"],
            tolerance: { lower: -0.2, upper: 0.2 },
            inspectionMethod: "calipers",
            ctq: false,
          },
        ],
        notes: ["Remove all burrs."],
      },
      undefined,
      undefined,
      { cwd },
    );
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.match(text, /cad_generate_drawing stage=generate/);

    // The spec lands in run-scoped storage, not an agent-chosen directory.
    const adhoc = join(cwd, ".pi-cad", "adhoc", "drawing");
    const dirs = await readdir(adhoc);
    assert.equal(dirs.length, 1);
    const spec = JSON.parse(await readFile(join(adhoc, dirs[0], "spec.json"), "utf-8"));
    // The drawing backend resolves relative artifacts against the spec
    // directory; the canonicalized spec must therefore pin the absolute path.
    assert.ok(spec.artifact.startsWith(cwd));
    assert.equal(spec.units, "mm");
    assert.equal(spec.dimensions[0].feature_refs[0], "#p0");
    assert.equal(spec.dimensions[0].inspection_method, "calipers");

    const envelope = result.details.envelope;
    assert.ok(envelope.ok, JSON.stringify(envelope.payload));
    const kinds = envelope.artifacts.map((a: any) => a.kind);
    assert.ok(kinds.every((k: string) => k === "drawing"));
    assert.ok(envelope.artifacts.length >= 1);
    for (const artifact of envelope.artifacts) {
      assert.ok(artifact.sha256, "drawing artifacts are hashed");
    }

    // Unknown view names are rejected by the tool schema before any file is
    // touched (the harness validates params against this schema).
    assert.equal(
      Check(tool.parameters, {
        stage: "validate",
        artifact: "plate.step",
        views: [{ name: "oblique" }],
      }),
      false,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cad_render_scene takes structured arguments and canonicalizes the spec", async () => {
  const pi = mockPi();
  const presentation = (await import("../src/extensions/presentation/index.ts")).default;
  presentation(pi as any);
  const tool = pi.tools.get("cad_render_scene");
  assert.ok(tool, "cad_render_scene is registered");

  const keys = Object.keys(tool.parameters.properties);
  assert.ok(!keys.includes("spec"));
  assert.ok(!keys.includes("outputDir"));
  assert.ok(keys.includes("directions"));
  assert.ok(keys.includes("lighting"));
  assert.ok(keys.includes("camera"));

  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-present-tool-"));
  try {
    await writeFile(join(cwd, "part.glb"), "stub-glb", "utf-8");
    await writeFile(join(cwd, "hero.jpg"), "stub-hero", "utf-8");
    await writeFile(join(cwd, "detail.jpg"), "stub-detail", "utf-8");

    const result = await tool.execute(
      "p1",
      {
        stage: "generate",
        artifact: "part.glb",
        directions: [
          { name: "hero", reference: "hero.jpg" },
          { name: "detail", reference: "detail.jpg" },
        ],
        // Controlled vocabulary (review P0-7): the interpreter actually
        // consumes family/pattern/lens/composition.
        materials: [
          { pattern: "machined", family: "metal" },
          { pattern: "matte", family: "rubber" },
        ],
        lighting: { key: "softbox 45deg", fill: "bounce card", rim: "strip light" },
        camera: { lens: "85mm", composition: "hero" },
      },
      undefined,
      undefined,
      { cwd },
    );
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.match(text, /cad_render_scene stage=generate status=script-generated/);

    const adhoc = join(cwd, ".pi-cad", "adhoc", "presentation");
    const dirs = await readdir(adhoc);
    assert.equal(dirs.length, 1);
    const spec = JSON.parse(await readFile(join(adhoc, dirs[0], "spec.json"), "utf-8"));
    assert.ok(spec.artifact.startsWith(cwd));
    assert.ok(spec.directions[0].reference.startsWith(cwd));
    assert.equal(spec.directions.length, 2);

    const envelope = result.details.envelope;
    assert.ok(envelope.ok);
    assert.equal(envelope.artifacts.length, 1);
    assert.equal(envelope.artifacts[0].kind, "presentation");
    assert.ok(envelope.artifacts[0].sha256);

    // A missing reference image fails closed before running the backend.
    await assert.rejects(
      () =>
        tool.execute(
          "p2",
          {
            stage: "validate",
            artifact: "part.glb",
            directions: [
              { name: "hero", reference: "missing.jpg" },
              { name: "detail", reference: "detail.jpg" },
            ],
            materials: [{ pattern: "body_*", family: "aluminum" }],
            lighting: { key: "softbox", fill: "white", rim: "cool" },
            camera: { lens: "85mm", composition: "rule-of-thirds" },
          },
          undefined,
          undefined,
          { cwd },
        ),
      /missing\.jpg/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cad_render_scene preview renders with blender and binds evidence to the design", async () => {
  const { execFileSync } = await import("node:child_process");
  let blender = "";
  try {
    blender = execFileSync("blender", ["--version"], { encoding: "utf-8" });
  } catch {
    blender = "";
  }
  if (!blender) {
    // Honest skip: same fail-soft contract as the capability itself.
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-render-"));
  try {
    // Build a real two-box STEP through the deterministic backend.
    writeFileSync(
      join(cwd, "boxes.py"),
      [
        "import build123d as bd",
        "with bd.BuildPart() as p:",
        "    bd.Box(40, 30, 12)",
        "    a = p.part",
        "with bd.BuildPart() as p:",
        "    bd.Box(20, 20, 35)",
        "    b = p.part",
        "result = bd.Compound([a, b.moved(bd.Location((0, 0, 23.5)))])",
        "",
      ].join("\n"),
    );
    const { buildStep } = await import("../src/shared/capability.ts");
    await buildStep(cwd, { source: "boxes.py", output: "boxes.step", force: true });
    // Minimal valid 1x1 grayscale PNG, written without image libraries.
    for (const name of ["ref1.png", "ref2.png"]) {
      const { deflateSync, crc32 } = await import("node:zlib");
      const chunk = (type: string, data: Buffer) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const typeBuf = Buffer.from(type, "ascii");
        const crcBuf = Buffer.alloc(4);
        crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
        return Buffer.concat([length, typeBuf, data, crcBuf]);
      };
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(1, 0);
      ihdr.writeUInt32BE(1, 4);
      ihdr[8] = 8;
      ihdr[9] = 0;
      const idat = deflateSync(Buffer.from([0, 128]));
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", idat),
        chunk("IEND", Buffer.alloc(0)),
      ]);
      await writeFile(join(cwd, name), png);
    }
    const pi = mockPi();
    const presentation = (await import("../src/extensions/presentation/index.ts")).default;
    presentation(pi as never);
    const tool = pi.tools.get("cad_render_scene");
    const result = await tool.execute(
      "p1",
      {
        stage: "preview",
        artifact: "boxes.step",
        directions: [
          { name: "hero", reference: "ref1.png" },
          { name: "top", reference: "ref2.png" },
        ],
        materials: [{ pattern: "brushed", family: "metal" }],
        lighting: { key: "softbox", fill: "bounce", rim: "strip" },
        camera: { lens: "85mm", composition: "hero" },
        assemblyDefinition: {
          sequence: [{ step: 1, installs: ["base"] }, { step: 2, installs: ["tower"] }],
          explodeDirections: { tower: [0, 0, 1], base: [0, 0, -0.3] },
        },
        resolution: { width: 160, height: 120 },
        fps: 12,
        outputs: { hero: true, exploded: true, turntable: false, assembly: false },
      },
      undefined,
      undefined,
      { cwd },
    );
    assert.match(result.content[0].text as string, /status=rendered/);
    // Preview pixels come back multimodally: the preview -> inspect ->
    // revise loop needs the images in the conversation.
    const imageParts = result.content.filter((part) => part.type === "image");
    assert.ok(imageParts.length >= 2, `expected preview images, got ${imageParts.length}`);
    // Evidence subject is the DESIGN (boxes.step), not the spec.
    const artifactSha = result.details.envelope.inputHashes.artifact;
    assert.ok(artifactSha);
    assert.equal(result.details.artifactHash, artifactSha);
    // The manifest binds subject + spec + hashed outputs.
    const manifestPath = (result.details.envelope.payload as { manifest: string }).manifest;
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    assert.equal(manifest.subjectArtifactHash, artifactSha);
    assert.equal(manifest.status, "rendered");
    assert.ok(manifest.outputs["hero.png"].sha256);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function cwd0(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}
