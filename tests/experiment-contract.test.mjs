/**
 * RES-345 绿色保护套件：冻结实验合约本身。
 *
 * 对应问题：实验组、矩阵、预算、三轮请求、经验开关、提交清单、usage/完整性
 * 字段此前散在计划文档和聊天里，实现可以悄悄改掉而不被发现。
 * 旧版行为：没有可版本化的合约，也没有 hash；数值只存在于文档。
 * 预期行为：合约 JSON 是唯一来源，hash 可复算；矩阵、预算与防护门和合约一致。
 *
 * 运行：node --test tests/experiment-contract.test.mjs
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { CONTRACT_PATH, loadContract, verifyContract } from "../benchmarks/cadtestbench/experiment-contract/contract.mjs";
import { runChecks } from "../benchmarks/cadtestbench/experiment-contract/check.mjs";

const REPO = resolve(import.meta.dirname, "..");
const contract = loadContract();

test("合约 hash 可复算，且与记录一致", () => {
  const result = verifyContract();
  assert.match(result.actual, /^[a-f0-9]{64}$/);
  assert.equal(result.ok, true, `记录 hash ${result.recorded} 与复算 ${result.actual} 不一致，需重跑 contract.mjs --write-hash`);
});

test("合约覆盖所需的实验组、矩阵、预算与三轮请求", () => {
  assert.deepEqual(Object.keys(contract.groups).sort(), ["G", "R0", "RF", "RT"]);
  assert.deepEqual(contract.matrix.map((entry) => entry.id), ["E1", "E2", "E3", "E4a", "E4b"]);
  assert.equal(contract.rounds.count, 3);
  assert.equal(contract.budget.core_runs, 392);
  assert.equal(contract.budget.concurrency, 4);
  assert.equal(contract.budget.optional_extension.runs, 300);
  assert.deepEqual(contract.degradation.order.slice(0, 2), ["取消公开 200 题扩展", "取消额外 thinking 扫描"]);
});

test("矩阵次数与预算自洽", () => {
  const byId = Object.fromEntries(contract.matrix.map((entry) => [entry.id, entry]));
  const combinations = (entry) => {
    const units = entry.tasks ?? entry.checkpoints;
    const arms = (entry.groups ?? entry.conditions).length;
    const models = (entry.models ?? ["S"]).length;
    return units * arms * models * entry.repeats;
  };
  for (const entry of contract.matrix) {
    assert.equal(combinations(entry), entry.runs, `${entry.id} 次数与 run 数不一致`);
  }
  const total = contract.matrix.reduce((sum, entry) => sum + entry.runs, 0);
  assert.equal(total, contract.budget.core_runs);
  assert.equal(byId.E3.base_group_reuse, "复用 E2 两次重复的 RF 结果，不重跑");
  assert.equal(byId.E2.rounds, 3);
  assert.equal(byId.E2.cap_minutes_per_run, byId.E2.cap_minutes_per_round * 3);
});

test("主实验经验开关、提交清单与计量字段齐全", () => {
  assert.equal(contract.experience.main_experiment.read, false);
  assert.equal(contract.experience.main_experiment.search, false);
  assert.equal(contract.experience.main_experiment.write, false);
  assert.equal(contract.experience.main_experiment.auto_refine, false);

  const checklist = contract.submission.checklist.map((item) => item.id);
  for (const id of ["step_explicit", "source_deterministic", "submission_manifest", "submission_hash", "motion_bundle", "simulation_bundle", "no_group_private_record"]) {
    assert.ok(checklist.includes(id), `提交清单缺少 ${id}`);
  }

  const measured = new Set(contract.metering.required_fields);
  for (const field of ["experience_read", "experience_write", "submission", "round_results", "provider_usage", "integrity", "end_reason"]) {
    assert.ok(measured.has(field), `计量字段缺少 ${field}`);
  }
  const integrity = new Set(contract.metering.integrity_fields);
  for (const field of ["artifact_sha256", "submission_sha256", "leakage_tier", "method_provenance", "cancel_cleanup"]) {
    assert.ok(integrity.has(field), `完整性字段缺少 ${field}`);
  }
  assert.ok(contract.metering.rules.some((rule) => rule.includes("不能转 0")), "缺测必须保留 null");
});

test("防护门与合约 pilot_gates 一一对应", () => {
  const declared = contract.pilot_gates.map((gate) => gate.id).sort();
  const implemented = runChecks().map((gate) => gate.id).sort();
  assert.deepEqual(implemented, declared, "check.mjs 的防护门必须与合约 pilot_gates 完全一致");
  const items = new Set(contract.pilot_gates.map((gate) => gate.issue_item));
  for (const item of [1, 2, 3, 4, 5, 6, 7, 8]) assert.ok(items.has(item), `问题项 ${item} 没有防护门`);
  assert.equal(new Set(declared).size, declared.length, "防护门 id 不能重复");
});

test("session 生命周期只指向 RES-342/RES-343", () => {
  assert.deepEqual(contract.issues.lifecycle, ["RES-342", "RES-343"]);
  assert.match(contract.rounds.continuation, /RES-342/);
  assert.match(contract.rounds.continuation, /RES-343/);
  assert.ok(
    contract.prohibited.some((rule) => rule.includes("不重做全项目测试框架")),
    "合约必须声明不另起第二套生命周期/测试框架",
  );
  const binding = contract.pilot_gates.find((gate) => gate.id === "gate.session_binding_alignment");
  assert.ok(binding, "缺 session 绑定防护门");
  assert.equal(binding.issue_item, 7);
});

test("防护门报告结构完整，失败门带证据", () => {
  const gates = runChecks();
  assert.equal(gates.length, contract.pilot_gates.length);
  for (const gate of gates) {
    assert.match(gate.status, /^(pass|fail)$/);
    assert.ok(gate.expected.length > 0, `${gate.id} 缺少预期行为`);
    assert.ok(gate.repro.length > 0, `${gate.id} 缺少复现命令`);
    assert.match(gate.repro, /^(rg|node|npm|bash) /, `${gate.id} 复现命令要能直接跑`);
    assert.ok(
      !gate.evidence.some((line) => line.startsWith("检查执行失败")),
      `${gate.id} 的检查本身报错，说明 check.mjs 有 bug`,
    );
    if (gate.status === "fail") assert.ok(gate.evidence.length > 0, `${gate.id} 失败但没有证据`);
  }
  const red = contract.protection_tests.red;
  assert.ok(red.length > 0);
  for (const path of [...contract.protection_tests.green, ...red]) {
    assert.ok(existsSync(join(REPO, path)), `登记的测试文件不存在：${path}`);
  }
});

test("red suite 不进默认套件，现有套件保持通过", () => {
  const runner = readFileSync(join(REPO, "tests", "run-ts-tests.mjs"), "utf8");
  assert.ok(runner.includes("experiment-contract.test.mjs"), "绿色合约套件必须登记进默认 TS 套件");
  assert.ok(!runner.includes("tests/red/"), "red suite 不能登记进默认套件，否则现有套件会变红");

  const redFile = readFileSync(join(REPO, "tests", "red", "experiment-protection.red.test.mjs"), "utf8");
  const markers = redFile.match(/对应问题/g) ?? [];
  assert.ok(markers.length >= contract.pilot_gates.length, "每个 red 用例都要注明对应问题");
  assert.ok(!/(?:test|it)\.(?:skip|todo)\(/.test(redFile), "red suite 不能用 skip 假装通过");
  assert.ok(!/\.skip\(|xit\(/.test(redFile), "red suite 不能用 xfail/skip 假装通过");
});
