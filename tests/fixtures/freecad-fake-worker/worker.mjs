// Stand-in for `python -m reify_freecad.worker`: speaks the same NDJSON protocol.
import { createInterface } from "node:readline";

const opened = new Set();
const lines = createInterface({ input: process.stdin });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

for await (const line of lines) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  const reply = (body) => process.stdout.write(`${JSON.stringify({ id: request.id, ...body })}\n`);
  const args = request.args ?? {};
  if (request.op === "open") {
    opened.add(request.doc);
    reply({ ok: true, result: { pid: process.pid, opened: [...opened], export: args.export, rev: 0 } });
  } else if (request.op === "echo") {
    const started = Date.now();
    if (args.ms) await sleep(args.ms);
    reply({ ok: true, result: { pid: process.pid, started, finished: Date.now(), tag: args.tag, reopened: opened.has(request.doc), budgetS: request.budgetS } });
  } else if (request.op === "crash") {
    process.stderr.write("fake worker is about to crash\n");
    process.exit(3);
  } else if (request.op === "fail") {
    reply({ ok: false, error: { code: args.code ?? "FILLET_FAILED", message: "fillet failed", target: "bracket/edge", detail: { failedOpIndex: 1 }, hints: ["reduce radius"], rolledBack: true } });
  } else {
    reply({ ok: true, result: { op: request.op, args } });
  }
}
