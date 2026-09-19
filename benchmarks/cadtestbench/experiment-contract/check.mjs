#!/usr/bin/env node
/**
 * RES-345 conformance checker.
 *
 * Each gate answers one pilot requirement from the frozen contract
 * (experiment-contract.v1.json → pilot_gates). A gate passes only when the
 * repository contains the mechanism the contract requires; a gate fails with
 * the evidence that is missing today. The green suite asserts the checker
 * itself is well formed and matches the contract; the red suite asserts every
 * gate passes (it fails until the fixes land).
 *
 * Usage:
 *   node check.mjs            # human table
 *   node check.mjs --json     # machine readable
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTRACT_DIR, loadContract } from "./contract.mjs";

const REPO = join(CONTRACT_DIR, "..", "..", "..");
const BENCH_RUNNER = join(REPO, "benchmarks", "cadtestbench", "run.mjs");
const EXPERIENCE_TOOLS = join(REPO, "src", "integrations", "prime", "experience-tools.ts");
const IPYTHON_OPS = join(REPO, "packages", "prime-transcript-lab", "prime_trace", "ipython_ops.py");
const TRANSCRIPT_METRICS = join(REPO, "packages", "prime-transcript-lab", "prime_trace", "metrics.py");
const LEGACY_SIMULATION = join(REPO, "src", "extensions", "simulation", "index.ts");
const SIMULATION_V2 = join(REPO, "src", "extensions", "simulation", "v2.ts");

function read(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function matches(pattern, text) {
  return new RegExp(pattern, "m").test(text);
}

const gates = [
  {
    id: "gate.two_tasks_invisible",
    repro: 'rg -n "sensitivePaths|orig-|--concurrency" benchmarks/cadtestbench/run.mjs',
    ticket_item: 1,
    requirement: "两个并发任务互不可见",
    expected: "每次运行按题隔离：每题有独立 staging 与独立评分素材，不使用仓库级共享 vault，且支持并发调度。",
    check() {
      const runner = read(BENCH_RUNNER);
      const globalVault = matches("orig-\\$\\{|sensitivePaths\\(\\)", runner);
      const concurrency = matches("--concurrency|CONCURRENCY", runner);
      const perSampleEval = /for \(const sampleId of idList\)[\s\S]{0,4000}const evalRoot = join/.test(runner);
      const evidence = [
        globalVault ? `run.mjs 仍把仓库内真值打成全局 vault（sensitivePaths/orig-）` : "",
        concurrency ? "" : "run.mjs 不支持 --concurrency，隔离依赖全程串行",
        perSampleEval ? "" : "评分素材 evalRoot 不在每题循环内建立",
      ].filter(Boolean);
      return { ok: evidence.length === 0, evidence };
    },
  },
  {
    id: "gate.grader_unreadable",
    repro: 'rg -n "tarCreate|tarExtract|auditSession" benchmarks/cadtestbench/run.mjs',
    ticket_item: 1,
    requirement: "评分源码与历史经验对 Agent 不可读",
    expected: "评分数据、评分源码与历史结果对被测 Agent 不可读，且不靠临时打包/删除仓库文件实现。",
    check() {
      const runner = read(BENCH_RUNNER);
      const vault = matches("tarCreate\\(|tarExtract\\(", runner);
      const audit = matches("auditSession", runner);
      const evidence = [
        vault ? "run.mjs 用 tar 打包/解包仓库文件做隔离，压缩包不是权限隔离" : "",
        audit ? "" : "没有对越界读取做审计",
      ].filter(Boolean);
      return { ok: evidence.length === 0, evidence };
    },
  },
  {
    id: "gate.experience_off",
    repro: 'rg -n "PI_CAD_EXPERIENCE" benchmarks/cadtestbench/run.mjs src/authority/launcher.ts src/integrations/prime/experience-tools.ts',
    ticket_item: 2,
    requirement: "主实验经验读写均关闭",
    expected: "主实验运行环境关闭经验读取、检索、写入与自动 refine，且读取侧有独立开关，不只是换目录名。",
    check() {
      const runner = read(BENCH_RUNNER);
      const tools = read(EXPERIENCE_TOOLS);
      const evidence = [];
      if (/PI_CAD_EXPERIENCE_ENABLED:\s*"1"/.test(runner)) evidence.push('run.mjs 给主实验设 PI_CAD_EXPERIENCE_ENABLED: "1"');
      if (!/PI_CAD_EXPERIENCE_(READ|SEARCH)[A-Z_]*/.test(tools)) evidence.push("经验读取工具没有读取开关（experience-tools.ts 只用写入侧开关）");
      return { ok: evidence.length === 0, evidence };
    },
  },
  {
    id: "gate.public_prompt_clean",
    repro: 'rg -n "adversarial requirements reviewer|Benchmark execution contract" benchmarks/cadtestbench/run.mjs',
    ticket_item: 3,
    requirement: "公共题面无旧审核或阶段暗示",
    expected: "公共题面只包含题目本身；各组启动说明分开，不在题面尾部强制独立审核或限制阶段。",
    check() {
      const runner = read(BENCH_RUNNER);
      const promptLine = runner.split("\n").find((line) => /const prompt = `\$\{prompts\.get\(sampleId\)\}/.test(line)) ?? "";
      const hints = ["reviewer", "wait_for_user", "phase", "workflow package", "headless"].filter((word) => promptLine.includes(word));
      return {
        ok: hints.length === 0,
        evidence: hints.length ? [`公共题面拼接了审核/阶段指令：${hints.join(", ")}`] : [],
      };
    },
  },
  {
    id: "gate.ipython_action_metering",
    repro: 'rg -n "function sessionMetrics" -A 32 benchmarks/cadtestbench/run.mjs',
    ticket_item: 4,
    requirement: "一次 IPython 里多个 CAD 动作分别计量",
    expected: "运行记录从真实事件里数每个 CAD 动作；一次 IPython 里有多个动作时分别计数，不以一条 IPython 代替一次 CAD 操作。",
    check() {
      const runner = read(BENCH_RUNNER);
      const ops = read(IPYTHON_OPS);
      const hasCounts = matches("action_counts|known_tool_stats|analyze_ipython|prime-trace", runner);
      return {
        ok: hasCounts,
        evidence: hasCounts
          ? []
          : [
              "run.mjs 的 sessionMetrics 只按 toolCall 名字计数，一条 IPython 记 1 次，不数里面的 CAD 动作",
              ops.includes("known_tool_calls") ? "prime_trace 已有逐动作计数，但运行记录没有使用它" : "",
            ].filter(Boolean),
      };
    },
  },
  {
    id: "gate.accounting_complete",
    repro: 'rg -n "RETRIES|retry" benchmarks/cadtestbench/run.mjs packages/prime-transcript-lab/prime_trace/metrics.py',
    ticket_item: 4,
    requirement: "子 Agent、重试与错误不漏账",
    expected: "计量覆盖子 Agent 用量、供应商重试次数与工具错误，且不把一条 IPython 当一次 CAD 操作。",
    check() {
      const runner = read(BENCH_RUNNER);
      const metrics = read(TRANSCRIPT_METRICS);
      const evidence = [];
      if (!/retries|retry/i.test(metrics)) evidence.push("metrics.py 没有重试计量");
      if (!/ipython/i.test(runner)) evidence.push("run.mjs 的 sessionMetrics 不读 IPython 内部动作");
      if (!/subagent/i.test(runner)) evidence.push("run.mjs 不单独统计子 Agent");
      return { ok: evidence.length === 0, evidence };
    },
  },
  {
    id: "gate.explicit_step_submission",
    repro: 'rg -n "latestRun|currentArtifactPath|submission.json" benchmarks/cadtestbench/run.mjs',
    ticket_item: 5,
    requirement: "最终 STEP 明确提交并复验 hash",
    expected: "最终产物由显式 submission.json 指定并复验 sha256；禁止按最近修改时间取 STEP。",
    check() {
      const runner = read(BENCH_RUNNER);
      const explicit = matches("submission\\.json", runner);
      const latestRun = matches("latestRun\\(workdir\\)", runner);
      const evidence = [];
      if (!explicit) evidence.push("run.mjs 没有 submission.json 显式提交路径");
      if (latestRun) evidence.push("run.mjs 仍用 latestRun/currentArtifactPath 兜底解析产物");
      return { ok: evidence.length === 0, evidence };
    },
  },
  {
    id: "gate.simulation_attachment",
    repro: 'rg -n "image|attach" src/extensions/simulation/index.ts',
    ticket_item: 6,
    requirement: "仿真图像进入模型请求，而不只是落盘 PNG",
    expected: "仿真观察导出的图片作为附件进入模型请求，两个仿真入口一致。",
    check() {
      const legacy = read(LEGACY_SIMULATION);
      const v2 = read(SIMULATION_V2);
      const legacyAttaches = /attach|type:\s*"image"|image_url/.test(legacy);
      const v2Attaches = /type === "image"|type:\s*"image"/.test(v2);
      const evidence = [];
      if (!legacyAttaches) evidence.push("旧 cad_simulate 路径保存 observation 但没有把图片作为附件返回");
      if (!v2Attaches) evidence.push("Simulation V2 没有返回图片附件");
      return { ok: evidence.length === 0, evidence };
    },
  },
  {
    id: "gate.session_binding_alignment",
    repro: 'rg -n "pi-cad.workflow-binding" src apps/desktop/electron',
    ticket_item: 7,
    requirement: "复用 RES-342/RES-343 的 session 绑定，不另写第二套生命周期",
    expected: "仓储使用 pi-cad.workflow-binding 作为 conversation→run 绑定；本合约不新增第二套生命周期实现。",
    check() {
      const binding = matches("pi-cad\\.workflow-binding", read(join(REPO, "src", "integrations", "prime", "extension.ts")));
      const anyBinding = matches("pi-cad\\.workflow-binding", repoWideSearch(["src", "apps/desktop/electron"]));
      return {
        ok: binding || anyBinding,
        evidence: binding || anyBinding ? [] : ["仓储内没有 pi-cad.workflow-binding，RES-342 尚未落地；本票只冻结对齐要求"],
      };
    },
  },
  {
    id: "gate.cancel_cleanup",
    repro: 'rg -n "child.kill|SIGKILL|detached" benchmarks/cadtestbench/run.mjs',
    ticket_item: 7,
    requirement: "取消或超时结束全部子进程与子 Agent",
    expected: "取消/超时按进程组清理，覆盖子进程与子 Agent，而不是只杀顶层进程。",
    check() {
      const runner = read(BENCH_RUNNER);
      const groupKill = matches("process\\.kill\\(-|detached:\\s*true|killProcessGroup", runner);
      const evidence = groupKill ? [] : ["run.mjs 超时只 child.kill(\"SIGKILL\")，没有清理子进程组与子 Agent"];
      return { ok: groupKill, evidence };
    },
  },
  {
    id: "gate.method_provenance",
    repro: 'rg -n "workflowPackage|piCadCommit|protocol_hash" benchmarks/cadtestbench/run.mjs',
    ticket_item: 8,
    requirement: "记录实际发现/采用的 workflow、skill、方法与来源 hash",
    expected: "manifest 记录实际运行的 workflow、skills、方法与输入 hash；仓库模板不等于运行时方法。",
    check() {
      const runner = read(BENCH_RUNNER);
      const required = ["workflow_hash", "skills_hash", "input_hash", "protocol_hash", "method_source"];
      const missing = required.filter((key) => !runner.includes(key));
      return {
        ok: missing.length === 0,
        evidence: missing.length ? [`manifest 缺少字段：${missing.join(", ")}`] : [],
      };
    },
  },
];

function repoWideSearch(roots) {
  try {
    return execFileSync("rg", ["-l", "--glob", "!node_modules", "pi-cad\\.workflow-binding", ...roots], {
      cwd: REPO,
      encoding: "utf8",
    });
  } catch {
    return "";
  }
}

export function runChecks() {
  return gates.map((gate) => {
    let result;
    try {
      result = gate.check();
    } catch (error) {
      result = { ok: false, evidence: [`检查执行失败：${error instanceof Error ? error.message : String(error)}`] };
    }
    return {
      id: gate.id,
      ticket_item: gate.ticket_item,
      requirement: gate.requirement,
      expected: gate.expected,
      repro: gate.repro,
      status: result.ok ? "pass" : "fail",
      evidence: result.evidence,
    };
  });
}

export function summarize(gateResults = runChecks()) {
  const passed = gateResults.filter((gate) => gate.status === "pass").length;
  return {
    contract: loadContract(),
    total: gateResults.length,
    passed,
    failed: gateResults.length - passed,
    gates: gateResults,
  };
}

function printTable(summary) {
  process.stdout.write(`contract ${summary.contract.contract_id}@${summary.contract.version}  gates ${summary.passed}/${summary.total} pass\n`);
  for (const gate of summary.gates) {
    process.stdout.write(`${gate.status === "pass" ? "PASS" : "FAIL"}  ${gate.id}  (issue item ${gate.ticket_item})\n`);
    for (const line of gate.evidence) process.stdout.write(`      ${line}\n`);
    if (gate.status === "fail") process.stdout.write(`      复现：${gate.repro}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const summary = summarize();
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else printTable(summary);
  process.exitCode = summary.failed ? 1 : 0;
}
