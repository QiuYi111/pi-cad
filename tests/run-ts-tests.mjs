import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
await jiti.import("./state-machine.test.ts", { default: true });
await jiti.import("./extensions-smoke.test.ts", { default: true });
await jiti.import("./harness-v0.test.ts", { default: true });
await jiti.import("./restore.test.ts", { default: true });
await jiti.import("./policy.test.ts", { default: true });
await jiti.import("./workflows-full.test.ts", { default: true });
await jiti.import("./harness-convert.test.ts", { default: true });
await jiti.import("./task-lifecycle.test.ts", { default: true });
await jiti.import("./commands-lifecycle.test.ts", { default: true });
