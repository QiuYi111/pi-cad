import { createJiti } from "jiti";
import { cpSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Chaos suites are slow (~16 min) and run nightly via `npm run test:chaos`.
// The real-Reify suite is split by boundary; each file is one boundary.
// Environment setup mirrors tests/run-ts-tests.mjs.
process.env.PYTHONDONTWRITEBYTECODE ??= "1";
process.env.PI_CAD_WORKFLOW_HOME = mkdtempSync(join(tmpdir(), "pi-cad-workflow-home-"));
const testWorkflowRoot = join(process.env.PI_CAD_WORKFLOW_HOME, ".pi-cad", "workflows");
mkdirSync(testWorkflowRoot, { recursive: true });
cpSync(new URL("../workflow-packages/mechanical/default.yaml", import.meta.url), join(testWorkflowRoot, "mechanical-default.yaml"));

const jiti = createJiti(import.meta.url, { moduleCache: false });
await jiti.import("./chaos.test.ts", { default: true });
await jiti.import("./chaos-reify-core.test.ts", { default: true });
await jiti.import("./chaos-reify-process.test.ts", { default: true });
await jiti.import("./chaos-reify-storage.test.ts", { default: true });
await jiti.import("./chaos-reify-credentials.test.ts", { default: true });
await jiti.import("./chaos-reify-network.test.ts", { default: true });
await jiti.import("./chaos-reify-race.test.ts", { default: true });
await jiti.import("./chaos-invariants.test.ts", { default: true });
await jiti.import("./chaos-campaign.test.ts", { default: true });
