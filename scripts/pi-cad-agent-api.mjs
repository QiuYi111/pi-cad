#!/usr/bin/env node
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { main } = await jiti.import("../src/agent-api/cli.ts", { default: true });
process.exitCode = await main(process.argv.slice(2));
