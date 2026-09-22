# Reify chaos campaign res398-runtime-press

跑完 200 轮真 Reify：通过 200、失败 0、harness 报错 0。失败里 unique 0 个：稳定 0、偶发 0、假阳性 0、未验 0；其中产品侧 0 个、harness 侧 0 个。

起点 commit `1be42b538647`（labrunner/res-398-chaos-06），node v22.23.2，package 0.9.0。

## 1. 跑了多少轮 / 多少状态组合

- 轮数 200，独立 seed 200，真实状态观测 ≥4184 次
- 常驻 runtime 轮 200，一次性控制面轮 0
- generator：maxCommands=12，runtimeRatio=1，concurrency=2
- profile 轮数：race=99, runtime-recovery=34, desktop-consistency=34, lifecycle-action-race=33

## 2. 命中了哪些 action / fault / invariant

- action：startRun=318, commitPlan=281, advance=265, openConversation=176, build=92, retryBuild=50, refresh=49, resumeRun=47, multiConversationBuild=45, concurrentBuild=42, duplicateCommit=41, switchConversation=39, burstRefresh=34, desktopRestart=34, authorize=20, phaseCard=18, stopRun=17, phaseContract=17, completionGate=15, listWorkflows=15, history=15
- fault 真注入：raceRestartDuringTransition=24, raceUserActionDuringKernelFault=24, killRuntimeDuringBuild=20, raceRepeatSubmitDuringFault=16, raceTwoConversationsBuild=16, raceCrossConversationFault=15, restartRuntimeDuringBuild=12, raceLegalOrderSwap=12, killKernelDuringBuild=10, killPrimeRuntime=8, missingDesktopProjection=7, pauseRuntimeDuringBuild=4
- fault 不适用：raceRestartDuringTransition=19, raceUserActionDuringKernelFault=15, killAuthorityDuringBuild=13, killRuntimeDuringBuild=7, raceCrossConversationFault=5, raceTwoConversationsBuild=5, raceRepeatSubmitDuringFault=4, killKernelDuringBuild=4, pauseRuntimeDuringBuild=1, restartRuntimeDuringBuild=1
- fault 注入失败（InjectionFailed，前置成立却抛了真异常）：无
- fault 恢复失败（RecoveryFailed）：无
- invariant 每轮都查：no-orphan-kernel, run-ownership, terminal-state-stable, artifact-integrity, recovery-convergence, fault-outcome-honest
- 真实组件：authority=1241, kernel=289, run-store=160, runtime=54, prime=8, desktop-projection=7

### 每个 fault 的注入结果

| fault | Injected | NotApplicable | InjectionFailed | RecoveryFailed |
| --- | --- | --- | --- | --- |
| raceRestartDuringTransition | 24 | 19 | 0 | 0 |
| raceUserActionDuringKernelFault | 24 | 15 | 0 | 0 |
| killRuntimeDuringBuild | 20 | 7 | 0 | 0 |
| raceRepeatSubmitDuringFault | 16 | 4 | 0 | 0 |
| raceTwoConversationsBuild | 16 | 5 | 0 | 0 |
| raceCrossConversationFault | 15 | 5 | 0 | 0 |
| raceLegalOrderSwap | 12 | 0 | 0 | 0 |
| restartRuntimeDuringBuild | 12 | 1 | 0 | 0 |
| killKernelDuringBuild | 10 | 4 | 0 | 0 |
| killPrimeRuntime | 8 | 0 | 0 | 0 |
| missingDesktopProjection | 7 | 0 | 0 | 0 |
| pauseRuntimeDuringBuild | 4 | 1 | 0 | 0 |
| killAuthorityDuringBuild | 0 | 13 | 0 | 0 |

| 边界 | 轮数 | 真注入次数 | 注入/轮 |
| --- | --- | --- | --- |
| process | 37 | 54 | 27.0% |
| file-state | 7 | 7 | 3.5% |
| provider-oauth | 0 | 0 | 0.0% |
| race | 80 | 107 | 53.5% |

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

- file-state：只有 7 次真注入（3.5%）
- provider-oauth：0 次真注入

## 每个 unique failure 的序列形状


## 复现信息

- campaign id：`res398-runtime-press`，mode=targeted
- seed 基数：398900，轮数 200，maxCommands 12
- profiles：runtime-recovery, desktop-consistency, lifecycle-action-race, race
- provider 传输故障：关（opt-in）
- fault 池大小：24
- 环境：全默认

重跑同一条 campaign：

```bash
npm run chaos:reify -- campaign rerun chaos/campaigns/res398-runtime-press
```

