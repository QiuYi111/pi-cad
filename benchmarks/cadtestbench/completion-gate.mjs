#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const cwd = process.cwd();
const runsDir = join(cwd, ".pi-cad", "runs");
const fail = (message) => {
  console.error(`WORKFLOW_INCOMPLETE: ${message}`);
  process.exit(42);
};

if (!existsSync(runsDir)) fail("no Pi-CAD run exists; continue the task instead of reporting completion");
const states = readdirSync(runsDir)
  .sort()
  .reverse()
  .map((name) => join(runsDir, name, "state.json"))
  .filter(existsSync);
if (!states.length) fail("no canonical state exists");
const state = JSON.parse(readFileSync(states[0], "utf8"));
if (state.status !== "done" || state.phase !== "done") {
  fail(`canonical workflow is ${state.phase ?? "unknown"}/${state.status ?? "unknown"}; reach DONE before answering`);
}

const projectPath = join(cwd, ".pi-cad", "project.json");
if (!existsSync(projectPath)) fail("project state is missing");
const project = JSON.parse(readFileSync(projectPath, "utf8"));
const artifact = project.head?.artifactPath;
if (!artifact || !/\.(step|stp)$/i.test(artifact)) fail("Project Head has no STEP artifact");
const artifactPath = isAbsolute(artifact) ? artifact : resolve(cwd, artifact);
if (!existsSync(artifactPath)) fail(`Project Head STEP is missing on disk: ${artifact}`);

console.log(`WORKFLOW_COMPLETE: ${artifact}`);
