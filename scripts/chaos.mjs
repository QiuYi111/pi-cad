#!/usr/bin/env node
// Single launcher for the chaos POC. Sub-entries run through jiti so the
// harness needs no build step and no extra toolchain.
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const modulePath = (relative) => fileURLToPath(new URL(relative, import.meta.url));

const [subcommand, ...rest] = process.argv.slice(2);

if (subcommand === "__serve") {
  const { runServerEntry } = await jiti.import(modulePath("../chaos/sut/server.ts"));
  await runServerEntry(rest);
} else if (subcommand === "__worker") {
  const { runWorkerEntry } = await jiti.import(modulePath("../chaos/sut/worker.ts"));
  await runWorkerEntry(rest);
} else if (subcommand === "__upstream") {
  const { runUpstreamEntry } = await jiti.import(modulePath("../chaos/sut/upstream.ts"));
  await runUpstreamEntry(rest);
} else if (subcommand === "reify") {
  // Real-Reify vertical slice: drives production Reify processes, not the POC SUT.
  const { runReifyCli } = await jiti.import(modulePath("../chaos/reify/cli.ts"));
  process.exit(await runReifyCli(rest));
} else {
  const { runCli } = await jiti.import(modulePath("../chaos/cli.ts"));
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
