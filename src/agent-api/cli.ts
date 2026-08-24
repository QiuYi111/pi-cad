import { resolve } from "node:path";

import { assertLinuxRuntime } from "../shared/platform.ts";
import { handleAgentApi } from "./handlers.ts";
import type { AgentApiRequest, AgentApiResponse } from "./protocol.ts";

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  assertLinuxRuntime("Pi-CAD Agent API");
  if (argv[0] !== "agent-api" || argv.length > 2) throw new Error("usage: pi-cad agent-api [cwd]");
  const cwd = resolve(argv[1] ?? process.env.PI_CAD_PROJECT_CWD ?? process.cwd());
  let response: AgentApiResponse;
  try {
    const request = JSON.parse(await stdin()) as AgentApiRequest;
    response = { schema: 1, ok: true, result: await handleAgentApi(cwd, request) };
  } catch (error) {
    response = { schema: 1, ok: false, error: { type: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) } };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
  return response.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stdout.write(`${JSON.stringify({ schema: 1, ok: false, error: { type: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) } })}\n`);
    process.exitCode = 1;
  });
}
