# Reify chaos campaign res390-main-1000-postfix

跑完 1000 轮真 Reify：通过 1000、失败 0、harness 报错 0。失败里 unique 0 个：稳定 0、偶发 0、假阳性 0、未验 0；其中产品侧 0 个、harness 侧 0 个。

起点 commit `6518fd89c1d9`（labrunner/res-390-chaos-05），node v22.23.2，package 0.9.0。

## 1. 跑了多少轮 / 多少状态组合

- 轮数 1000，独立 seed 1000，真实状态观测 ≥17374 次
- 常驻 runtime 轮 500，一次性控制面轮 500
- generator：maxCommands=8，runtimeRatio=0.5，concurrency=3
- profile 轮数：process=168, file-state=168, race=165, mixed=112, provider-oauth=112, kernel-lifecycle=55, runtime-recovery=55, session-isolation=55, lifecycle-action-race=55, desktop-consistency=55

## 2. 命中了哪些 action / fault / invariant

- action：startRun=1393, commitPlan=1278, advance=1231, openConversation=467, build=369, refresh=204, concurrentBuild=202, multiConversationBuild=174, retryBuild=157, burstRefresh=142, duplicateCommit=131, switchConversation=129, desktopRestart=123, resumeRun=113, completionGate=70, phaseContract=64, listWorkflows=60, history=60, stopRun=54, authorize=47, phaseCard=43
- fault 真注入：killKernelDuringBuild=91, killRuntimeDuringBuild=51, killKernelChild=51, restartRuntimeDuringBuild=49, missingRunStateFile=48, raceUserActionDuringKernelFault=46, killAuthorityDuringBuild=37, raceRepeatSubmitDuringFault=34, raceLegalOrderSwap=31, providerCredentialExpired=30, providerCredentialDropped=30, raceCrossConversationFault=28, pauseKernelDuringBuild=28, raceTwoConversationsBuild=28, partialStateWrite=27, killPrimeRuntime=26, unreadableRunStateFile=25, pauseRuntimeDuringBuild=23, providerCredentialBlanked=22, raceRestartDuringTransition=17, pauseAuthorityDuringBuild=13, missingDesktopProjection=13, killIdleKernel=3
- fault 不适用：killAuthorityDuringBuild=57, raceRestartDuringTransition=51, killIdleKernel=39, missingDesktopProjection=34, pauseAuthorityDuringBuild=23, killRuntimeDuringBuild=20, raceTwoConversationsBuild=17, restartRuntimeDuringBuild=16, raceUserActionDuringKernelFault=15, cpuPressure=12, raceCrossConversationFault=11, partialStateWrite=9, pauseRuntimeDuringBuild=9, missingRunStateFile=7, killKernelDuringBuild=7, raceRepeatSubmitDuringFault=6, unreadableRunStateFile=6, raceLegalOrderSwap=5, killKernelChild=4, pauseKernelDuringBuild=1
- invariant 每轮都查：no-orphan-kernel, run-ownership, terminal-state-stable, artifact-integrity, recovery-convergence, fault-outcome-honest
- 真实组件：authority=5030, kernel=1211, run-store=704, runtime=207, provider-oauth=86, desktop-projection=48, prime=27

| 边界 | 轮数 | 真注入次数 | 注入/轮 |
| --- | --- | --- | --- |
| process | 265 | 372 | 37.2% |
| file-state | 98 | 113 | 11.3% |
| provider-oauth | 72 | 82 | 8.2% |
| race | 148 | 184 | 18.4% |

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

- campaign id：`res390-main-1000-postfix`，mode=nightly
- seed 基数：390000，轮数 1000，maxCommands 8
- profiles：mixed, process, file-state, provider-oauth, race, kernel-lifecycle, runtime-recovery, session-isolation, lifecycle-action-race, desktop-consistency
- provider 传输故障：关（opt-in）
- fault 池大小：24
- 环境：全默认

重跑同一条 campaign：

```bash
npm run chaos:reify -- campaign rerun chaos/campaigns/res390-main-1000-postfix
```

