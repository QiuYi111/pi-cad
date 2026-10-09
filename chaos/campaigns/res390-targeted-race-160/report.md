# Reify chaos campaign res390-targeted-race-160

跑完 160 轮真 Reify：通过 160、失败 0、harness 报错 0。失败里 unique 0 个：稳定 0、偶发 0、假阳性 0、未验 0；其中产品侧 0 个、harness 侧 0 个。

起点 commit `7f234667e128`（labrunner/res-390-chaos-05），node v22.23.2，package 0.9.0。

## 1. 跑了多少轮 / 多少状态组合

- 轮数 160，独立 seed 160，真实状态观测 ≥2882 次
- 常驻 runtime 轮 160，一次性控制面轮 0
- generator：maxCommands=8，runtimeRatio=1，concurrency=3
- profile 轮数：session-isolation=80, lifecycle-action-race=80

## 2. 命中了哪些 action / fault / invariant

- action：startRun=225, commitPlan=218, advance=198, openConversation=132, build=60, retryBuild=40, refresh=31, multiConversationBuild=30, concurrentBuild=27, duplicateCommit=21, resumeRun=20, desktopRestart=19, switchConversation=16, burstRefresh=13, stopRun=13, listWorkflows=11, history=11, completionGate=9, authorize=9, phaseCard=7, phaseContract=6
- fault 真注入：killKernelDuringBuild=30, raceTwoConversationsBuild=18, raceCrossConversationFault=17, restartRuntimeDuringBuild=15, raceRepeatSubmitDuringFault=10, killRuntimeDuringBuild=9, raceUserActionDuringKernelFault=8, raceRestartDuringTransition=4
- fault 不适用：killAuthorityDuringBuild=17, raceRestartDuringTransition=6, restartRuntimeDuringBuild=5, raceCrossConversationFault=5, raceUserActionDuringKernelFault=4, killKernelDuringBuild=2, raceTwoConversationsBuild=2, killRuntimeDuringBuild=1
- invariant 每轮都查：no-orphan-kernel, run-ownership, terminal-state-stable, artifact-integrity, recovery-convergence, fault-outcome-honest
- 真实组件：authority=873, kernel=206, run-store=86, runtime=30

| 边界 | 轮数 | 真注入次数 | 注入/轮 |
| --- | --- | --- | --- |
| process | 45 | 54 | 33.8% |
| file-state | 0 | 0 | 0.0% |
| provider-oauth | 0 | 0 | 0.0% |
| race | 50 | 57 | 35.6% |

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

- campaign id：`res390-targeted-race-160`，mode=targeted
- seed 基数：7000，轮数 160，maxCommands 8
- profiles：session-isolation, lifecycle-action-race
- provider 传输故障：关（opt-in）
- fault 池大小：24
- 环境：全默认

重跑同一条 campaign：

```bash
npm run chaos:reify -- campaign rerun chaos/campaigns/res390-targeted-race-160
```

