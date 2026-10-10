#!/usr/bin/env node
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
// The composition point: the authority sidecar is domain-neutral, so the
// Mechanical Pack is handed to it here.
const { main } = await jiti.import("../src/authority/launcher.ts", { default: true });
const { mechanicalAuthorityDomain } = await jiti.import("../src/composition/mechanical-authority.ts", { default: true });
process.exitCode = await main(mechanicalAuthorityDomain, process.argv.slice(2));
