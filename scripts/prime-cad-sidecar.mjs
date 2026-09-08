#!/usr/bin/env node
import { createJiti } from "jiti";

// WSL traffic can bypass a Windows TUN adapter. The desktop forwards the
// configured loopback proxy; install it for Prime's provider fetches too.
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy) {
  const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { main } = await jiti.import("../src/authority/launcher.ts", { default: true });
process.exitCode = await main(process.argv.slice(2));
