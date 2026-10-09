// Stand-in for `python -m reify_freecad.worker`: speaks the same NDJSON protocol.
import { join } from "node:path";
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
  } else if (request.op === "dfm") {
    // A canned DFM report shaped like cmd_dfm: one error on a face centred at [10, 10, 10].
    // It echoes what it received so a test can check the arguments and the budget made it through.
    reply({
      ok: true,
      result: {
        rulepack: "quanzhou.cnc_mill", material: "al6061", rev: 2, analyzer: "builtin", asi: null,
        counts: { error: 1, warn: 0, info: 0, pass: 2 },
        issues: [{
          rule: "hole.min_diameter", severity: "error", layer: "lint",
          target: { body: "bracket", face: 3, centre: [10, 10, 10] }, measured: 1.0, limit: 1.2, unit: "mm",
          message: "hole is too small", hints: ["use a larger drill"], source: "fake (p.1)",
        }],
        coverage: [{ rule: "edge.double_side_fillet", layer: "geometry", status: "skipped", reason: "analysis_situs_unavailable" }],
        highlight: { paths: ["bracket/m3_tap"] },
        annotations: [{ text: "hole.min_diameter", at: [10, 10, 12] }],
        report_path: join(process.cwd(), "build", "dfm", "rev-2.json"),
        received: { args, budgetS: request.budgetS ?? null },
      },
    });
  } else {
    reply({ ok: true, result: { op: request.op, args } });
  }
}
