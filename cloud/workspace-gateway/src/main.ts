import { createTokenVerifier } from "./auth.js";
import { httpPoster, startActivityReporter } from "./activity.js";
import { startGateway } from "./server.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const verifyToken = await createTokenVerifier({
  publicKeyPem: required("REIFY_GATEWAY_PUBKEY").replace(/\\n/g, "\n"),
  workspaceName: required("REIFY_WORKSPACE_NAME"),
});

const gateway = await startGateway({
  port: Number(process.env.REIFY_GATEWAY_PORT ?? 7000),
  workspaceRoot: process.env.REIFY_WORKSPACE_ROOT ?? "/workspace",
  readOnlyRoots: ["/opt/reify"],
  verifyToken,
  ignoredCommands: (process.env.REIFY_ACTIVITY_IGNORE ?? "").split(",").filter(Boolean),
});

if (process.env.REIFY_ACTIVITY_URL) {
  startActivityReporter({
    monitor: gateway.monitor,
    post: httpPoster(process.env.REIFY_ACTIVITY_URL, process.env.REIFY_ACTIVITY_TOKEN ?? ""),
  });
}

console.log(`workspace gateway listening on :${gateway.port}`);
