# Reify chaos campaign res398-targeted-lowhit

跑完 200 轮真 Reify：通过 199、失败 1、harness 报错 0。失败里 unique 1 个：稳定 1、偶发 0、假阳性 0、未验 0；其中产品侧 1 个、harness 侧 0 个。

起点 commit `e184332ef9b1`（labrunner/res-398-chaos-06，工作区脏），node v22.23.2，package 0.9.0。

## 1. 跑了多少轮 / 多少状态组合

- 轮数 200，独立 seed 200，真实状态观测 ≥4202 次
- 常驻 runtime 轮 100，一次性控制面轮 100
- generator：maxCommands=12，runtimeRatio=0.5，concurrency=2
- profile 轮数：session-isolation=50, lifecycle-action-race=50, desktop-consistency=50, runtime-recovery=50

## 2. 命中了哪些 action / fault / invariant

- action：startRun=321, commitPlan=305, advance=271, openConversation=127, build=94, refresh=66, multiConversationBuild=61, concurrentBuild=57, retryBuild=54, switchConversation=44, desktopRestart=37, duplicateCommit=36, resumeRun=34, burstRefresh=32, stopRun=29, listWorkflows=24, history=21, completionGate=18, phaseCard=17, authorize=17, phaseContract=10
- fault 真注入：killKernelDuringBuild=15, raceUserActionDuringKernelFault=15, killAuthorityDuringBuild=14, missingDesktopProjection=12, raceTwoConversationsBuild=10, killPrimeRuntime=10, raceRestartDuringTransition=9, raceRepeatSubmitDuringFault=7, raceCrossConversationFault=4
- fault 不适用：killRuntimeDuringBuild=31, restartRuntimeDuringBuild=30, raceRestartDuringTransition=19, pauseRuntimeDuringBuild=6, raceCrossConversationFault=4, raceTwoConversationsBuild=3, killAuthorityDuringBuild=3, killKernelDuringBuild=3, raceUserActionDuringKernelFault=2, raceRepeatSubmitDuringFault=1
- fault 注入失败（InjectionFailed，前置成立却抛了真异常）：无
- fault 恢复失败（RecoveryFailed）：missingDesktopProjection=1
- invariant 每轮都查：no-orphan-kernel, run-ownership, terminal-state-stable, artifact-integrity, recovery-convergence, fault-outcome-honest
- 真实组件：authority=1232, kernel=308, run-store=177, runtime=88, desktop-projection=13, prime=10

### 每个 fault 的注入结果

| fault | Injected | NotApplicable | InjectionFailed | RecoveryFailed |
| --- | --- | --- | --- | --- |
| killKernelDuringBuild | 15 | 3 | 0 | 0 |
| raceUserActionDuringKernelFault | 15 | 2 | 0 | 0 |
| killAuthorityDuringBuild | 14 | 3 | 0 | 0 |
| missingDesktopProjection | 12 | 0 | 0 | 1 |
| killPrimeRuntime | 10 | 0 | 0 | 0 |
| raceTwoConversationsBuild | 10 | 3 | 0 | 0 |
| raceRestartDuringTransition | 9 | 19 | 0 | 0 |
| raceRepeatSubmitDuringFault | 7 | 1 | 0 | 0 |
| raceCrossConversationFault | 4 | 4 | 0 | 0 |
| killRuntimeDuringBuild | 0 | 31 | 0 | 0 |
| pauseRuntimeDuringBuild | 0 | 6 | 0 | 0 |
| restartRuntimeDuringBuild | 0 | 30 | 0 | 0 |

| 边界 | 轮数 | 真注入次数 | 注入/轮 |
| --- | --- | --- | --- |
| process | 34 | 39 | 19.5% |
| file-state | 12 | 12 | 6.0% |
| provider-oauth | 0 | 0 | 0.0% |
| race | 41 | 45 | 22.5% |

## 3. 发现多少 failure，多少 unique

失败轮 1 轮 → unique 1 个。归并维度：坏掉哪个 invariant + 归一化后的失败原因（pid、run id、临时目录、hash、出现次数、哪一步收场都不算身份）；每个 cluster 另外留下失败边界、出错步骤、序列形状和日志签名。

产品侧 1 个是真产品发现；harness 侧 0 个是 harness 自己的 fault 注入出问题（比如故障之间互相踩到），要修 harness，不能当产品 bug 报。

| cluster | invariant | 边界 | 哪一侧 | 出错步骤 | 次数 | 结论 | 最小复现 | 原因 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cc1cac0ed | recovery-convergence | file-state | product | action:multiConversationBuild | 1 | reproducible | 7 步 | 真 authority 没有把 .pi-cad/status.json 写回来 |

## 4. 哪些可以稳定 replay

- cc1cac0ed `recovery-convergence`：reproducible（按序列 replay 3/3，seed+path 复现）
  - 最小复现 7 步（原始 15 步，numShrinks=5），commit=1be42b538647
  - artifact：/home/jingyi/symphony-workspaces/oh-my/reify/RES-398/chaos/campaigns/res398-targeted-lowhit/regressions/cc1cac0ed-recovery-convergence.json

## 5. shrink 后最小路径

- cc1cac0ed（15 步 → 7 步）
  `action:startRun → action:commitPlan → action:advance → fault:missingDesktopProjection → fault:missingDesktopProjection → action:openConversation → action:multiConversationBuild`

## 6. 高频 failure 集中在哪些边界

- file-state：1 个 unique，共 1 次

## 7. 哪些区域探索不足

- provider-oauth：0 次真注入

## 每个 unique failure 的序列形状

- cc1cac0ed `recovery-convergence`（1 次，seed 1147211961）
  - `action:startRun → action:commitPlan → action:advance → action:commitPlan → action:build → action:multiConversationBuild → fault:missingDesktopProjection → fault:raceRestartDuringTransition → action:startRun → fault:missingDesktopProjection → action:build → action:build → action:retryBuild → action:openConversation → action:multiConversationBuild`

## 复现信息

- campaign id：`res398-targeted-lowhit`，mode=targeted
- seed 基数：398700，轮数 200，maxCommands 12
- profiles：session-isolation, lifecycle-action-race, desktop-consistency, runtime-recovery
- provider 传输故障：关（opt-in）
- fault 池大小：24
- 环境：全默认

重跑同一条 campaign：

```bash
npm run chaos:reify -- campaign rerun chaos/campaigns/res398-targeted-lowhit
```

## 备注

- 本轮报告由 campaign recluster 在已落盘的轮次上重算：原始轮次跑在 e184332ef9b1，recluster / re-triage / report 用的是 1be42b538647（triage 规则 v3）；聚类口径见 chaos/campaign/signature.ts。
- campaign 起点工作区不干净，结论要对着 gitCommit 看

