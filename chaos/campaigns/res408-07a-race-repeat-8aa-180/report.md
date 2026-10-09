# Reify chaos campaign res408-07a-race-repeat-8aa-180

跑完 180 轮真 Reify：通过 180、失败 0、harness 报错 0。失败里 unique 0 个：稳定 0、偶发 0、假阳性 0、未验 0；其中产品侧 0 个、harness 侧 0 个。

起点 commit `8aa12102e39d`（HEAD），node v22.23.2，package 0.9.0。

## 1. 跑了多少轮 / 多少状态组合

- 轮数 180，独立 seed 180，真实状态观测 ≥4202 次
- 常驻 runtime 轮 180，一次性控制面轮 0
- generator：maxCommands=14，runtimeRatio=1，concurrency=3
- profile 轮数：race=108, session-isolation=36, lifecycle-action-race=36

## 2. 命中了哪些 action / fault / invariant

- action：startRun=281, commitPlan=256, advance=249, openConversation=219, build=106, refresh=69, multiConversationBuild=55, retryBuild=51, resumeRun=46, concurrentBuild=39, desktopRestart=38, burstRefresh=34, duplicateCommit=34, switchConversation=27, phaseContract=22, listWorkflows=21, completionGate=21, history=19, authorize=16, phaseCard=16, stopRun=14
- fault 真注入：raceCrossConversationFault=28, raceTwoConversationsBuild=27, raceUserActionDuringKernelFault=24, raceRestartDuringTransition=19, raceLegalOrderSwap=17, raceRepeatSubmitDuringFault=16, killKernelDuringBuild=14, restartRuntimeDuringBuild=8, killRuntimeDuringBuild=7
- fault 不适用：raceRestartDuringTransition=23, raceUserActionDuringKernelFault=20, killAuthorityDuringBuild=11, raceTwoConversationsBuild=10, raceCrossConversationFault=9, raceRepeatSubmitDuringFault=8, killRuntimeDuringBuild=5, killKernelDuringBuild=3, restartRuntimeDuringBuild=1
- fault 注入失败（InjectionFailed，前置成立却抛了真异常）：无
- fault 恢复失败（RecoveryFailed）：无
- invariant 每轮都查：no-orphan-kernel, run-ownership, terminal-state-stable, artifact-integrity, recovery-convergence, fault-outcome-honest
- 真实组件：authority=1193, kernel=322, run-store=189, runtime=23

### 每个 fault 的注入结果

| fault | Injected | NotApplicable | InjectionFailed | RecoveryFailed |
| --- | --- | --- | --- | --- |
| raceCrossConversationFault | 28 | 9 | 0 | 0 |
| raceTwoConversationsBuild | 27 | 10 | 0 | 0 |
| raceUserActionDuringKernelFault | 24 | 20 | 0 | 0 |
| raceRestartDuringTransition | 19 | 23 | 0 | 0 |
| raceLegalOrderSwap | 17 | 0 | 0 | 0 |
| raceRepeatSubmitDuringFault | 16 | 8 | 0 | 0 |
| killKernelDuringBuild | 14 | 3 | 0 | 0 |
| restartRuntimeDuringBuild | 8 | 1 | 0 | 0 |
| killRuntimeDuringBuild | 7 | 5 | 0 | 0 |
| killAuthorityDuringBuild | 0 | 11 | 0 | 0 |

| 边界 | 轮数 | 真注入次数 | 注入/轮 |
| --- | --- | --- | --- |
| process | 21 | 29 | 16.1% |
| file-state | 0 | 0 | 0.0% |
| provider-oauth | 0 | 0 | 0.0% |
| race | 99 | 131 | 72.8% |

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

- file-state：0 次真注入
- provider-oauth：0 次真注入

## 每个 unique failure 的序列形状


## 复现信息

- campaign id：`res408-07a-race-repeat-8aa-180`，mode=targeted
- seed 基数：408700，轮数 180，maxCommands 14
- profiles：race, session-isolation, lifecycle-action-race
- provider 传输故障：关（opt-in）
- fault 池大小：24
- 环境：全默认

重跑同一条 campaign：

```bash
npm run chaos:reify -- campaign rerun chaos/campaigns/res408-07a-race-repeat-8aa-180
```
