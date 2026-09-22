# Reify chaos campaign res388-main-500

跑完 500 轮真 Reify：通过 472、失败 28、harness 报错 0。失败里 unique 2 个：稳定 0、偶发 0、假阳性 2、未验 0；其中产品侧 1 个、harness 侧 1 个。

起点 commit `6381490317e9`（labrunner/res-388-chaos-04），node v22.23.2，package 0.9.0。

## 1. 跑了多少轮 / 多少状态组合

- 轮数 500，独立 seed 500，真实状态观测 ≥8440 次
- 常驻 runtime 轮 250，一次性控制面轮 250
- generator：maxCommands=8，runtimeRatio=0.5，concurrency=3
- profile 轮数：process=90, file-state=89, race=87, mixed=60, provider-oauth=58, kernel-lifecycle=29, runtime-recovery=29, session-isolation=29, desktop-consistency=29

## 2. 命中了哪些 action / fault / invariant

- action：startRun=682, commitPlan=644, advance=634, build=205, openConversation=136, concurrentBuild=107, retryBuild=106, multiConversationBuild=97, refresh=75, resumeRun=65, switchConversation=62, desktopRestart=58, burstRefresh=53, duplicateCommit=50, listWorkflows=40, stopRun=36, phaseContract=35, completionGate=31, authorize=27, history=24, phaseCard=21
- fault 真注入：killKernelDuringBuild=31, providerCredentialExpired=26, pauseKernelDuringBuild=20, missingRunStateFile=18, raceLegalOrderSwap=16, killKernelChild=16, killPrimeRuntime=16, missingDesktopProjection=15, raceUserActionDuringKernelFault=14, restartRuntimeDuringBuild=13, providerCredentialDropped=12, raceRepeatSubmitDuringFault=12, providerCredentialBlanked=11, pauseAuthorityDuringBuild=11, unreadableRunStateFile=11, partialStateWrite=10, killAuthorityDuringBuild=10, pauseRuntimeDuringBuild=7, killRuntimeDuringBuild=7, killIdleKernel=6, raceRestartDuringTransition=6, raceCrossConversationFault=1
- fault 不适用：raceTwoConversationsBuild=27, raceCrossConversationFault=26, killIdleKernel=21, raceRestartDuringTransition=20, killAuthorityDuringBuild=20, killRuntimeDuringBuild=15, pauseAuthorityDuringBuild=12, restartRuntimeDuringBuild=11, missingDesktopProjection=10, cpuPressure=8, pauseRuntimeDuringBuild=8, partialStateWrite=6, raceUserActionDuringKernelFault=6, missingRunStateFile=4, unreadableRunStateFile=3, killKernelDuringBuild=3, killKernelChild=2, raceLegalOrderSwap=2, raceRepeatSubmitDuringFault=2, pauseKernelDuringBuild=1
- invariant 每轮都查：no-orphan-kernel, run-ownership, terminal-state-stable, artifact-integrity, recovery-convergence, fault-outcome-honest
- 真实组件：authority=2416, kernel=652, run-store=311, runtime=80, provider-oauth=51, desktop-projection=25, prime=17

| 边界 | 轮数 | 真注入次数 | 注入/轮 |
| --- | --- | --- | --- |
| process | 99 | 137 | 27.4% |
| file-state | 49 | 54 | 10.8% |
| provider-oauth | 40 | 49 | 9.8% |
| race | 42 | 49 | 9.8% |

## 3. 发现多少 failure，多少 unique

失败轮 28 轮 → unique 2 个。归并维度：坏掉哪个 invariant + 归一化后的失败原因（pid、run id、临时目录、hash、出现次数、哪一步收场都不算身份）；每个 cluster 另外留下失败边界、出错步骤、序列形状和日志签名。

产品侧 1 个是真产品发现；harness 侧 1 个是 harness 自己的 fault 注入出问题（比如故障之间互相踩到），要修 harness，不能当产品 bug 报。

| cluster | invariant | 边界 | 哪一侧 | 出错步骤 | 次数 | 结论 | 最小复现 | 原因 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| c41b23f2c | no-orphan-kernel | process/provider-oauth | product | fault:killAuthorityDuringBuild, fault:providerCredentialExpired, fault:killKernelDuringBuild, fault:killPrimeRuntime, fault:pauseKernelDuringBuild, action:concurrentBuild, action:listWorkflows, action:retryBuild, action:build, fault:killRuntimeDuringBuild, action:startRun | 26 | false-positive | - | N 个 kernel 的父控制面已经死了，进程还在：#(owner=#) |
| c3ea4e272 | fault-outcome-honest | race | harness | fault:raceUserActionDuringKernelFault | 2 | false-positive | - | fault raceUserActionDuringKernelFault 注入失败：author endpoint does not expose opera |

## 4. 哪些可以稳定 replay

- c41b23f2c `no-orphan-kernel`：false-positive（按序列 replay 0/2，seed+path 未复现）
  - 第 1 次按序列 replay 没复现：序列跑完但没有复现失败
  - 第 2 次按序列 replay 没复现：序列跑完但没有复现失败
  - 按 seed+path 没复现：seed=-1090223884 path=0 没有复现失败
- c3ea4e272 `fault-outcome-honest`：false-positive（按序列 replay 0/2，seed+path 未复现）
  - 第 1 次按序列 replay 没复现：序列跑完但没有复现失败
  - 第 2 次按序列 replay 没复现：序列跑完但没有复现失败
  - 按 seed+path 没复现：seed=1552637229 path=0 没有复现失败

## 5. shrink 后最小路径

- 没有 shrink 成功的最小路径

## 6. 高频 failure 集中在哪些边界

- process：1 个 unique，共 26 次
- provider-oauth：0 个 unique，共 26 次
- race：1 个 unique，共 2 次

## 7. 哪些区域探索不足

- 各边界都有真注入，暂不需要加权重

## 每个 unique failure 的序列形状

- c41b23f2c `no-orphan-kernel`（26 次，seed 3204743412, 2792227583, 254731161, 3277605890, 1587490910…）
  - `action:startRun → action:commitPlan → action:advance → fault:killAuthorityDuringBuild`
  - `action:startRun → action:commitPlan → action:advance → action:commitPlan → fault:killAuthorityDuringBuild`
  - `action:startRun → action:commitPlan → action:advance → fault:restartRuntimeDuringBuild → action:advance → fault:providerCredentialExpired`
  - `action:startRun → action:commitPlan → action:advance → fault:pauseRuntimeDuringBuild → fault:raceRepeatSubmitDuringFault → fault:killKernelDuringBuild`
  - `action:startRun → action:commitPlan → action:advance → fault:killRuntimeDuringBuild → fault:killPrimeRuntime`
  - …另外 19 种形状
- c3ea4e272 `fault-outcome-honest`（2 次，seed 1552637229, 1927515275）
  - `action:startRun → action:commitPlan → action:advance → fault:raceUserActionDuringKernelFault`
  - `action:startRun → action:commitPlan → action:advance → fault:raceTwoConversationsBuild → fault:raceLegalOrderSwap → action:retryBuild → fault:raceUserActionDuringKernelFault`

## 复现信息

- campaign id：`res388-main-500`，mode=nightly
- seed 基数：388000，轮数 500，maxCommands 8
- profiles：mixed, process, file-state, provider-oauth, race, kernel-lifecycle, runtime-recovery, session-isolation, desktop-consistency
- provider 传输故障：关（opt-in）
- fault 池大小：24
- 环境：全默认

重跑同一条 campaign：

```bash
npm run chaos:reify -- campaign rerun chaos/campaigns/res388-main-500
```

## 备注

- 本轮报告由 campaign recluster 在已落盘的轮次上重算：原始轮次跑在 6381490317e9，recluster / re-triage / report 用的是 b9a321d9d1ce（triage 规则 v3）；聚类口径见 chaos/campaign/signature.ts。
- 1 个 unique failure 是 harness 侧（c3ea4e272）：那是 campaign 自己的 fault 注入打错了，不是产品发现；修在 harness 里，回归用例进 tests/chaos-reify.test.ts。

