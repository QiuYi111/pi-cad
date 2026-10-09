import { join } from "node:path";

import { startAuthoritySidecar } from "../../src/authority/sidecar.ts";

/**
 * Chaos-side host for the real Reify runtime.
 *
 * This runs the same `startAuthoritySidecar()` the Desktop and Prime talk to:
 * a long-lived process that owns the canonical run store and serves the real
 * author/reviewer Unix sockets. The chaos runner spawns it as a child so a
 * real runtime has a real lifecycle (start / stop / restart) and real
 * requests, instead of the one-shot `agent-api` process per request.
 */
export async function runReifyRuntimeHost(argv: string[]): Promise<void> {
  const project = argv[0];
  if (!project) throw new Error("reify runtime host requires a project directory");
  const runtimeDirectory = argv[1] ?? join(project, ".chaos-runtime");
  const sidecar = await startAuthoritySidecar({ cwd: project, runtimeDirectory });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      pid: process.pid,
      authorSocket: sidecar.authorSocket,
      reviewerSocket: sidecar.reviewerSocket,
    })}\n`,
  );
  const shutdown = async () => {
    try {
      await sidecar.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  // Stay alive until the parent stops us.
  await new Promise<never>(() => {});
}
