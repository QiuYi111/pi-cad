// Stand-in for `python -m cadctl.worker`: one JSON frame per request line.
// `args[0] === "hang"` never answers, so a test can kill the worker mid-request.
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (request.args[0] === "hang") {
    process.stderr.write("fake cadctl worker is hanging\n");
    continue;
  }
  process.stdout.write(`${JSON.stringify({ id: request.id, workerPid: process.pid, exitCode: 0, stdout: JSON.stringify({ pid: process.pid, args: request.args }), stderr: "" })}\n`);
}
