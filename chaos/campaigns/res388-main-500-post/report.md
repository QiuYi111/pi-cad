# Reify chaos campaign res388-main-500-post

跑完 500 轮真 Reify：通过 500、失败 0、harness 报错 0。失败里 unique 0 个：稳定 0、偶发 0、假阳性 0、未验 0；其中产品侧 0 个、harness 侧 0 个。

起点 commit `446da8dedcb8`（labrunner/res-388-chaos-04），node v22.23.2，package 0.9.0。

## 1. 跑了多少轮 / 多少状态组合

- 轮数 500，独立 seed 500，真实状态观测 ≥8538 次
- 常驻 runtime 轮 250，一次性控制面轮 250
- generator：maxCommands=8，runtimeRatio=0.5，concurrency=3
- profile 轮数：process=90, file-state=89, race=87, mixed=60, provider-oauth=58, kernel-lifecycle=29, runtime-recovery=29, session-isolation=29, desktop-consistency=29

## 2. 命中了哪些 action / fault / invariant

- action：startRun=685, commitPlan=647, advance=639, build=205, openConversation=139, retryBuild=109, concurrentBuild=107, multiConversationBuild=97, refresh=77, resumeRun=67, switchConversation=63, desktopRestart=58, burstRefresh=54, duplicateCommit=51, listWorkflows=44, stopRun=37, phaseContract=36, completionGate=32, authorize=28, history=24, phaseCard=21
- fault 真注入：killKernelDuringBuild=33, providerCredentialExpired=27, pauseKernelDuringBuild=21, missingRunStateFile=18, raceUserActionDuringKernelFault=17, killPrimeRuntime=17, raceLegalOrderSwap=16, killKernelChild=16, missingDesktopProjection=15, providerCredentialDropped=13, restartRuntimeDuringBuild=13, raceRepeatSubmitDuringFault=12, providerCredentialBlanked=11, pauseAuthorityDuringBuild=11, unreadableRunStateFile=11, partialStateWrite=10, killAuthorityDuringBuild=10, pauseRuntimeDuringBuild=7, killRuntimeDuringBuild=7, killIdleKernel=6, raceRestartDuringTransition=6, raceCrossConversationFault=1
- fault 不适用：raceTwoConversationsBuild=27, raceCrossConversationFault=26, killIdleKernel=22, raceRestartDuringTransition=20, killAuthorityDuringBuild=20, killRuntimeDuringBuild=17, pauseAuthorityDuringBuild=13, restartRuntimeDuringBuild=12, missingDesktopProjection=11, cpuPressure=8, pauseRuntimeDuringBuild=8, partialStateWrite=6, raceUserActionDuringKernelFault=5, missingRunStateFile=4, unreadableRunStateFile=3, killKernelDuringBuild=3, raceLegalOrderSwap=2, raceRepeatSubmitDuringFault=2, killKernelChild=2, pauseKernelDuringBuild=1
- invariant 每轮都查：no-orphan-kernel, run-ownership, terminal-state-stable, artifact-integrity, recovery-convergence, fault-outcome-honest
- 真实组件：authority=2436, kernel=661, run-store=320, runtime=84, provider-oauth=53, desktop-projection=26, prime=18

| 边界 | 轮数 | 真注入次数 | 注入/轮 |
| --- | --- | --- | --- |
| process | 100 | 141 | 28.2% |
| file-state | 49 | 54 | 10.8% |
| provider-oauth | 42 | 51 | 10.2% |
| race | 44 | 52 | 10.4% |

## 3. 发现多少 failure，多少 unique

失败轮 0 轮 → unique 0 个。归并维度：坏掉哪个 invariant + 归一化后的失败原因（pid、run id、临时目录、hash、出现次数、哪一步收场都不算身份）；每个 cluster 另外留下失败边界、出错步骤、序列形状和日志签名。

产品侧 0 个是真产品发现；harness 侧 0 个是 harness 自己的 fault 注入出问题（比如故障之间互相踩到），要修 harness，不能当产品 bug 报。

| cluster | invariant | 边界 | 哪一侧 | 出错步骤 | 次数 | 结论 | 最小复现 | 原因 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## 4. 哪些可以稳定 replay

- 没有 failure，没有 replay 结论

## 5. shrink 后最小路径

- 没有 shrink 成功的最小路径

## 6. 高频 failure 集中在哪些边界

- 没有 failure

## 7. 哪些区域探索不足

- 各边界都有真注入，暂不需要加权重

## 每个 unique failure 的序列形状


## 复现信息

- campaign id：`res388-main-500-post`，mode=nightly
- seed 基数：388000，轮数 500，maxCommands 8
- profiles：mixed, process, file-state, provider-oauth, race, kernel-lifecycle, runtime-recovery, session-isolation, desktop-consistency
- provider 传输故障：关（opt-in）
- fault 池大小：24
- 环境：全默认

重跑同一条 campaign：

```bash
npm run chaos:reify -- campaign rerun chaos/campaigns/res388-main-500-post
```

## 备注

- 本轮报告由 campaign recluster 在已落盘的轮次上重算：原始轮次跑在 446da8dedcb8，recluster / re-triage / report 用的是 b9a321d9d1ce（triage 规则 v3）；聚类口径见 chaos/campaign/signature.ts。

