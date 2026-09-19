/**
 * RES-345 显式 red suite。
 *
 * 这里放的是「合约已经冻结、实现还没修」的回归用例。它们必须真实失败，
 * 不用 skip / xfail 假装通过，也不登记进默认套件。
 *
 *   npm run test:contract-red   # 预期非 0 退出
 *
 * 修复落地后，对应门转绿，再把用例迁进绿色套件。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { runChecks } from "../../benchmarks/cadtestbench/experiment-contract/check.mjs";

const gates = Object.fromEntries(runChecks().map((gate) => [gate.id, gate]));

function requireGate(id) {
  const gate = gates[id];
  assert.ok(gate, `合约没有声明防护门 ${id}`);
  return gate;
}

// 对应问题：计划 §2 第 1 项，两并发任务与评分器互不可见。
// 旧版失败：run.mjs 用仓库级 .cache/vault 打包真值，隔离依赖全程串行，不支持并发。
// 预期行为：每题独立 staging 与独立评分素材，去掉全局 vault，可并发调度。
test("RES-345 问题1 两并发任务互不可见", () => {
  const gate = requireGate("gate.two_tasks_invisible");
  assert.equal(gate.status, "pass", gate.evidence.join("；"));
});

// 对应问题：计划 §2 第 1 项，评分源码与历史经验对 Agent 不可读。
// 旧版失败：真值靠 tar 打包/解包仓库文件隐藏，压缩包不是权限隔离。
// 预期行为：评分数据与源码对被测 Agent 不可读，不靠临时删改写仓库。
test("RES-345 问题1 评分源码与历史经验不可读", () => {
  const gate = requireGate("gate.grader_unreadable");
  assert.equal(gate.status, "pass", gate.evidence.join("；"));
});

// 对应问题：计划 §2 第 2 项，主实验经验读写均关闭。
// 旧版失败：run.mjs 给主实验设 PI_CAD_EXPERIENCE_ENABLED=1，读取侧没有开关。
// 预期行为：读取、检索、写入、自动 refine 全部关闭，不只是换经验目录名。
test("RES-345 问题2 主实验经验读写均关闭", () => {
  const gate = requireGate("gate.experience_off");
  assert.equal(gate.status, "pass", gate.evidence.join("；"));
});

// 对应问题：计划 §2 第 3 项，公共题面无旧审核与阶段暗示。
// 旧版失败：公共题面尾部拼了独立需求审核、workflow 包与阶段限制，切换 workflow 不是干净对照。
// 预期行为：公共题面只有题目本身，各组启动说明分开。
test("RES-345 问题3 公共题面无旧审核与阶段暗示", () => {
  const gate = requireGate("gate.public_prompt_clean");
  assert.equal(gate.status, "pass", gate.evidence.join("；"));
});

// 对应问题：计划 §2 第 4 项，一次 IPython 里多个 CAD 动作分别计量。
// 旧版失败：sessionMetrics 只按 toolCall 名字计数，一条 IPython 记 1 次。
// 预期行为：从真实事件数每个 CAD 动作，一次 IPython 多动作分别计入。
test("RES-345 问题4 一次 IPython 多个 CAD 动作分别计量", () => {
  const gate = requireGate("gate.ipython_action_metering");
  assert.equal(gate.status, "pass", gate.evidence.join("；"));
});

// 对应问题：计划 §2 第 4 项，子 Agent、重试与错误不漏账。
// 旧版失败：run.mjs 不统计子 Agent 与 IPython 内动作，PI_CAD_RETRIES 读了不用；分析器不记重试。
// 预期行为：子 Agent 用量、供应商重试、工具错误全部入账。
test("RES-345 问题4 子 Agent、重试与错误不漏账", () => {
  const gate = requireGate("gate.accounting_complete");
  assert.equal(gate.status, "pass", gate.evidence.join("；"));
});

// 对应问题：计划 §2 第 5 项，最终 STEP 明确提交并复验 hash。
// 旧版失败：run.mjs 用 project.head 与最近 run 的 currentArtifactPath 兜底，等于取最近修改的 STEP。
// 预期行为：由显式 submission.json 指定产物并复验 sha256。
test("RES-345 问题5 最终 STEP 显式提交并复验 hash", () => {
  const gate = requireGate("gate.explicit_step_submission");
  assert.equal(gate.status, "pass", gate.evidence.join("；"));
});

// 对应问题：计划 §2 第 6 项，仿真图像要进入模型请求，不只是磁盘有 PNG。
// 旧版失败：旧仿真入口保存 observation 但没有把图片作为附件返回。
// 预期行为：两个仿真入口都把导出的图片作为附件返回。
test("RES-345 问题6 仿真图像作为附件进入请求", () => {
  const gate = requireGate("gate.simulation_attachment");
  assert.equal(gate.status, "pass", gate.evidence.join("；"));
});

// 对应问题：计划 §2 第 7 项，三轮续作复用 RES-342/RES-343 的 session 绑定。
// 旧版失败：仓储内没有 pi-cad.workflow-binding，新会话与恢复仍可能串上一个 run。
// 预期行为：按 conversation 绑定 run；本票只冻结对齐要求，不另写第二套生命周期实现。
test("RES-345 问题7 复用 RES-342/RES-343 session 绑定", () => {
  const gate = requireGate("gate.session_binding_alignment");
  assert.equal(gate.status, "pass", gate.evidence.join("；"));
});

// 对应问题：计划 §2 第 7 项，取消要结束全部子进程与子 Agent。
// 旧版失败：超时只对顶层进程 child.kill("SIGKILL")。
// 预期行为：按进程组清理，覆盖子进程与子 Agent。
test("RES-345 问题7 取消与超时清理全部子进程", () => {
  const gate = requireGate("gate.cancel_cleanup");
  assert.equal(gate.status, "pass", gate.evidence.join("；"));
});

// 对应问题：计划 §2 第 8 项，记录实际发现与采用的方法来源 hash。
// 旧版失败：manifest 只有 workflowPackage 字符串与 commit，没有 workflow/skills/输入/协议 hash。
// 预期行为：实际运行的 workflow、skill、方法与输入都带 hash 入档，仓库模板不等于运行时方法。
test("RES-345 问题8 实际方法来源与 hash 入档", () => {
  const gate = requireGate("gate.method_provenance");
  assert.equal(gate.status, "pass", gate.evidence.join("；"));
});
