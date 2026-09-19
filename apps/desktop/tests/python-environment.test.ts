import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeBrokenPythonEnvironment } from "../../../scripts/python-environment.mjs";

describe("managed Python repair", () => {
  it("removes a venv whose interpreter symlink target disappeared", () => {
    const project = mkdtempSync(join(tmpdir(), "pi-cad-python-"));
    const bin = join(project, ".venv", "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync("/missing/uv/python3.12", join(bin, "python"));

    expect(removeBrokenPythonEnvironment(project)).toBe(true);
    expect(removeBrokenPythonEnvironment(project)).toBe(false);
  });

  it("keeps a venv with a usable interpreter path", () => {
    const project = mkdtempSync(join(tmpdir(), "pi-cad-python-"));
    const bin = join(project, ".venv", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "python"), "present");

    expect(removeBrokenPythonEnvironment(project)).toBe(false);
  });
});
