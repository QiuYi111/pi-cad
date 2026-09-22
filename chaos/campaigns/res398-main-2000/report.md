# Reify chaos campaign res398-main-2000

跑完 2000 轮真 Reify：通过 1996、失败 4、harness 报错 0。失败里 unique 1 个：稳定 0、偶发 0、假阳性 1、未验 0；其中产品侧 1 个、harness 侧 0 个。

起点 commit `e184332ef9b1`（labrunner/res-398-chaos-06），node v22.23.2，package 0.9.0。

## 1. 跑了多少轮 / 多少状态组合

- 轮数 2000，独立 seed 2000，真实状态观测 ≥38862 次
- 常驻 runtime 轮 1000，一次性控制面轮 1000
- generator：maxCommands=10，runtimeRatio=0.5，concurrency=4
- profile 轮数：process=333, file-state=333, race=333, mixed=224, provider-oauth=222, kernel-lifecycle=111, runtime-recovery=111, session-isolation=111, lifecycle-action-race=111, desktop-consistency=111

## 2. 命中了哪些 action / fault / invariant

- action：startRun=2880, commitPlan=2770, advance=2632, openConversation=1031, build=895, retryBuild=464, refresh=456, multiConversationBuild=445, concurrentBuild=431, resumeRun=321, duplicateCommit=305, desktopRestart=305, burstRefresh=295, switchConversation=287, listWorkflows=161, authorize=160, stopRun=158, phaseContract=152, history=150, phaseCard=129, completionGate=129
- fault 真注入：killKernelDuringBuild=208, killKernelChild=113, pauseKernelDuringBuild=109, killRuntimeDuringBuild=108, raceUserActionDuringKernelFault=106, restartRuntimeDuringBuild=99, missingRunStateFile=89, raceCrossConversationFault=87, killPrimeRuntime=83, providerCredentialExpired=80, killAuthorityDuringBuild=79, raceTwoConversationsBuild=77, raceRepeatSubmitDuringFault=75, unreadableRunStateFile=63, partialStateWrite=61, providerCredentialDropped=59, raceLegalOrderSwap=53, pauseRuntimeDuringBuild=47, providerCredentialBlanked=44, missingDesktopProjection=36, raceRestartDuringTransition=33, pauseAuthorityDuringBuild=29, killIdleKernel=22
- fault 不适用：killAuthorityDuringBuild=123, raceRestartDuringTransition=103, killIdleKernel=83, killRuntimeDuringBuild=79, restartRuntimeDuringBuild=60, missingDesktopProjection=60, raceUserActionDuringKernelFault=52, pauseAuthorityDuringBuild=50, raceTwoConversationsBuild=45, cpuPressure=35, pauseRuntimeDuringBuild=29, raceCrossConversationFault=28, killKernelDuringBuild=26, partialStateWrite=18, raceRepeatSubmitDuringFault=18, missingRunStateFile=15, killKernelChild=14, pauseKernelDuringBuild=14, unreadableRunStateFile=6, raceLegalOrderSwap=3
- fault 注入失败（InjectionFailed，前置成立却抛了真异常）：无
- fault 恢复失败（RecoveryFailed）：missingDesktopProjection=4
- invariant 每轮都查：no-orphan-kernel, run-ownership, terminal-state-stable, artifact-integrity, recovery-convergence, fault-outcome-honest
- 真实组件：authority=10938, kernel=3060, run-store=1649, runtime=549, provider-oauth=200, desktop-projection=102, prime=89

### 每个 fault 的注入结果

| fault | Injected | NotApplicable | InjectionFailed | RecoveryFailed |
| --- | --- | --- | --- | --- |
| killKernelDuringBuild | 208 | 26 | 0 | 0 |
| killKernelChild | 113 | 14 | 0 | 0 |
| pauseKernelDuringBuild | 109 | 14 | 0 | 0 |
| killRuntimeDuringBuild | 108 | 79 | 0 | 0 |
| raceUserActionDuringKernelFault | 106 | 52 | 0 | 0 |
| restartRuntimeDuringBuild | 99 | 60 | 0 | 0 |
| missingRunStateFile | 89 | 15 | 0 | 0 |
| raceCrossConversationFault | 87 | 28 | 0 | 0 |
| killPrimeRuntime | 83 | 0 | 0 | 0 |
| providerCredentialExpired | 80 | 0 | 0 | 0 |
| killAuthorityDuringBuild | 79 | 123 | 0 | 0 |
| raceTwoConversationsBuild | 77 | 45 | 0 | 0 |
| raceRepeatSubmitDuringFault | 75 | 18 | 0 | 0 |
| unreadableRunStateFile | 63 | 6 | 0 | 0 |
| partialStateWrite | 61 | 18 | 0 | 0 |
| providerCredentialDropped | 59 | 0 | 0 | 0 |
| raceLegalOrderSwap | 53 | 3 | 0 | 0 |
| pauseRuntimeDuringBuild | 47 | 29 | 0 | 0 |
| providerCredentialBlanked | 44 | 0 | 0 | 0 |
| missingDesktopProjection | 36 | 60 | 0 | 4 |
| raceRestartDuringTransition | 33 | 103 | 0 | 0 |
| pauseAuthorityDuringBuild | 29 | 50 | 0 | 0 |
| killIdleKernel | 22 | 83 | 0 | 0 |
| cpuPressure | 0 | 35 | 0 | 0 |

| 边界 | 轮数 | 真注入次数 | 注入/轮 |
| --- | --- | --- | --- |
| process | 574 | 897 | 44.9% |
| file-state | 215 | 249 | 12.4% |
| provider-oauth | 160 | 183 | 9.2% |
| race | 339 | 431 | 21.6% |

## 3. 发现多少 failure，多少 unique

失败轮 4 轮 → unique 1 个。归并维度：坏掉哪个 invariant + 归一化后的失败原因（pid、run id、临时目录、hash、出现次数、哪一步收场都不算身份）；每个 cluster 另外留下失败边界、出错步骤、序列形状和日志签名。

产品侧 1 个是真产品发现；harness 侧 0 个是 harness 自己的 fault 注入出问题（比如故障之间互相踩到），要修 harness，不能当产品 bug 报。

| cluster | invariant | 边界 | 哪一侧 | 出错步骤 | 次数 | 结论 | 最小复现 | 原因 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cc1cac0ed | recovery-convergence | process/file-state | product | fault:pauseAuthorityDuringBuild, action:multiConversationBuild, action:concurrentBuild, action:commitPlan | 4 | false-positive | - | 真 authority 没有把 .pi-cad/status.json 写回来 |

## 4. 哪些可以稳定 replay

- cc1cac0ed `recovery-convergence`：false-positive（按序列 replay 0/2，seed+path 未复现）
  - 第 1 次按序列 replay 没复现：序列跑完但没有复现失败
  - 第 2 次按序列 replay 没复现：序列跑完但没有复现失败
  - 按 seed+path 没复现：seed=742519939 path=0 没有复现失败

## 5. shrink 后最小路径

- 没有 shrink 成功的最小路径

## 6. 高频 failure 集中在哪些边界

- process：1 个 unique，共 4 次
- file-state：0 个 unique，共 4 次

## 7. 哪些区域探索不足

- 各边界都有真注入，暂不需要加权重

## 每个 unique failure 的序列形状

- cc1cac0ed `recovery-convergence`（4 次，seed 634439893, 742519939, 1996207347, 3361425121）
  - `action:startRun → action:commitPlan → action:advance → fault:raceUserActionDuringKernelFault → action:concurrentBuild → action:history → fault:restartRuntimeDuringBuild → action:advance → fault:missingDesktopProjection → fault:missingDesktopProjection → action:multiConversationBuild → fault:pauseAuthorityDuringBuild`
  - `action:startRun → action:commitPlan → action:advance → fault:missingDesktopProjection → fault:missingDesktopProjection → action:startRun → action:listWorkflows → action:multiConversationBuild`
  - `action:startRun → action:commitPlan → action:advance → fault:missingDesktopProjection → fault:missingDesktopProjection → action:switchConversation → action:stopRun → action:burstRefresh → action:concurrentBuild → action:commitPlan → action:concurrentBuild`
  - `action:startRun → action:commitPlan → action:advance → action:commitPlan → fault:missingRunStateFile → action:build → fault:missingDesktopProjection → action:startRun → fault:missingDesktopProjection → action:authorize → action:retryBuild → action:build → action:commitPlan`

## 复现信息

- campaign id：`res398-main-2000`，mode=nightly
- seed 基数：398000，轮数 2000，maxCommands 10
- profiles：mixed, process, file-state, provider-oauth, race, kernel-lifecycle, runtime-recovery, session-isolation, lifecycle-action-race, desktop-consistency
- provider 传输故障：关（opt-in）
- fault 池大小：24
- 环境：全默认

重跑同一条 campaign：

```bash
npm run chaos:reify -- campaign rerun chaos/campaigns/res398-main-2000
```

## 备注

- 本轮报告由 campaign recluster 在已落盘的轮次上重算：原始轮次跑在 e184332ef9b1，recluster / re-triage / report 用的是 1188beb8b241（triage 规则 v3）；聚类口径见 chaos/campaign/signature.ts。

