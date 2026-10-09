import { basename, join } from "node:path";

import { harnessRunDirectory } from "./storage-paths.ts";

export function defaultVisualEvidenceDir(cwd: string, artifact: string): string {
  return join(cwd, ".pi-cad", "evidence", "visual", basename(artifact).replace(/\.[^.]+$/, ""));
}

export function defaultGeometryEvidencePath(cwd: string, artifact: string): string {
  return join(
    cwd,
    ".pi-cad",
    "evidence",
    "geometry",
    `${basename(artifact).replace(/\.[^.]+$/, "")}.json`,
  );
}

export function runEvidenceRoot(cwd: string, runId: string): string {
  return join(harnessRunDirectory(cwd, runId), "evidence");
}

export function runVisualEvidenceDir(cwd: string, runId: string, artifact: string): string {
  return join(runEvidenceRoot(cwd, runId), "visual", basename(artifact).replace(/\.[^.]+$/, ""));
}

export function runGeometryEvidencePath(cwd: string, runId: string, artifact: string): string {
  return join(runEvidenceRoot(cwd, runId), "geometry", `${basename(artifact).replace(/\.[^.]+$/, "")}.json`);
}

export function runCompareEvidencePath(cwd: string, runId: string, label: string): string {
  return join(runEvidenceRoot(cwd, runId), "compare", `${label.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

export function runInterferenceEvidencePath(cwd: string, runId: string, artifact: string): string {
  return join(runEvidenceRoot(cwd, runId), "interference", `${basename(artifact).replace(/\.[^.]+$/, "")}.json`);
}

export function runAssemblyEvidencePath(cwd: string, runId: string, artifact: string): string {
  return join(runEvidenceRoot(cwd, runId), "assembly", `${basename(artifact).replace(/\.[^.]+$/, "")}.json`);
}

