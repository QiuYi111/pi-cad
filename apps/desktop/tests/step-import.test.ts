import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importStepIntoProject, type StepImportRuntime } from "../electron/main/step-import";

const STEP_BODY = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Minimal stand-in for the runtime bridge. It executes the same POSIX command
 * surface the main process sends (`sh`/`mkdir`/`cp`/`mv`/`rm`) against real files so
 * the production import logic is exercised end to end.
 */
class FakeRuntime implements StepImportRuntime {
  readonly commands: string[][] = [];

  constructor(private readonly intercept?: (args: string[]) => Promise<{ stdout: string; stderr: string }> | undefined) {}

  async exec(args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.commands.push(args);
    const intercepted = await this.intercept?.(args);
    if (intercepted) return intercepted;
    const [command, ...rest] = args;
    if (command === "sh") {
      const path = rest.at(-1)!;
      return existsSync(path) ? { stdout: `${sha256File(path)}\n`, stderr: "" } : { stdout: "missing\n", stderr: "" };
    }
    if (command === "mkdir") {
      mkdirSync(rest.at(-1)!, { recursive: true });
      return { stdout: "", stderr: "" };
    }
    if (command === "cp" || command === "mv") {
      const [source, destination] = rest.slice(-2) as [string, string];
      if (!existsSync(destination)) copyFileSync(source, destination);
      return { stdout: "", stderr: "" };
    }
    if (command === "rm") {
      rmSync(rest.at(-1)!, { force: true });
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected runtime command: ${args.join(" ")}`);
  }
}

const temporary: string[] = [];
function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-cad-step-import-"));
  temporary.push(directory);
  return directory;
}

afterEach(() => {
  while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true });
});

describe("desktop STEP import", () => {
  it("stores the chosen file in the project, verified and under its content hash", async () => {
    const project = scratch();
    const source = join(scratch(), "supplier.step");
    writeFileSync(source, STEP_BODY);
    const runtime = new FakeRuntime();

    const relative = await importStepIntoProject(runtime, { source, fileName: "supplier.step", projectPath: project });

    expect(relative).toBe(`imports/${sha256File(source).slice(0, 16)}-supplier.step`);
    expect(readFileSync(join(project, relative), "utf8")).toBe(STEP_BODY);
    expect(runtime.commands.filter(([command]) => command === "cp")).toHaveLength(1);
    expect(runtime.commands.some(([command, ...rest]) => command === "mv" && rest.includes("-n"))).toBe(true);
  });

  it("reuses a project copy whose bytes still match the selection", async () => {
    const project = scratch();
    const source = join(scratch(), "supplier.step");
    writeFileSync(source, STEP_BODY);
    const runtime = new FakeRuntime();
    const first = await importStepIntoProject(runtime, { source, fileName: "supplier.step", projectPath: project });
    runtime.commands.length = 0;

    const second = await importStepIntoProject(runtime, { source, fileName: "supplier.step", projectPath: project });

    expect(second).toBe(first);
    expect(runtime.commands.some(([command]) => command === "cp")).toBe(false);
    expect(readFileSync(join(project, second), "utf8")).toBe(STEP_BODY);
  });

  it("refuses to silently reuse a project copy that was modified after import", async () => {
    const project = scratch();
    const source = join(scratch(), "supplier.step");
    writeFileSync(source, STEP_BODY);
    const runtime = new FakeRuntime();
    const relative = await importStepIntoProject(runtime, { source, fileName: "supplier.step", projectPath: project });
    const destination = join(project, relative);
    writeFileSync(destination, "modified by hand\n");

    await expect(importStepIntoProject(runtime, { source, fileName: "supplier.step", projectPath: project }))
      .rejects.toThrow(/already has different content/);
    expect(readFileSync(destination, "utf8")).toBe("modified by hand\n");
  });

  it("removes a published copy that does not match the selected file", async () => {
    const project = scratch();
    const source = join(scratch(), "supplier.step");
    writeFileSync(source, STEP_BODY);
    const runtime = new FakeRuntime(async (args) => {
      if (args[0] !== "cp") return undefined;
      const destination = args.at(-1)!;
      writeFileSync(destination, STEP_BODY.slice(0, 10));
      return { stdout: "", stderr: "" };
    });

    await expect(importStepIntoProject(runtime, { source, fileName: "supplier.step", projectPath: project }))
      .rejects.toThrow(/did not match the selected file/);
    expect(readdirSync(join(project, "imports"))).toEqual([]);
  });

  it("keeps a concurrent project file instead of overwriting it", async () => {
    const project = scratch();
    const source = join(scratch(), "supplier.step");
    writeFileSync(source, STEP_BODY);
    const hash = sha256File(source);
    const destination = join(project, `imports/${hash.slice(0, 16)}-supplier.step`);
    const runtime = new FakeRuntime(async (args) => {
      if (args[0] !== "mv") return undefined;
      writeFileSync(destination, "another writer\n");
      return { stdout: "", stderr: "" };
    });

    await expect(importStepIntoProject(runtime, { source, fileName: "supplier.step", projectPath: project }))
      .rejects.toThrow(/already has different content/);
    expect(readFileSync(destination, "utf8")).toBe("another writer\n");
    expect(readdirSync(join(project, "imports"))).toEqual([`${hash.slice(0, 16)}-supplier.step`]);
  });

  it("rejects selections it cannot read or verify", async () => {
    const project = scratch();
    const runtime = new FakeRuntime();

    await expect(importStepIntoProject(runtime, { source: join(project, "absent.step"), fileName: "absent.step", projectPath: project }))
      .rejects.toThrow(/Could not read the selected STEP file/);
    expect(runtime.commands.some(([command]) => command === "cp")).toBe(false);

    const source = join(scratch(), "drawing.pdf");
    writeFileSync(source, STEP_BODY);
    await expect(importStepIntoProject(runtime, { source, fileName: "drawing.pdf", projectPath: project }))
      .rejects.toThrow(/Select a \.step or \.stp file/);
    await expect(importStepIntoProject(runtime, { source, fileName: "supplier.step", projectPath: "" }))
      .rejects.toThrow(/Choose a project before importing STEP/);
  });
});
