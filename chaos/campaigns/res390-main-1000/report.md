# Reify chaos campaign res390-main-1000

跑完 1000 轮真 Reify：通过 994、失败 6、harness 报错 0。失败里 unique 4 个：稳定 1、偶发 1、假阳性 2、未验 0；其中产品侧 4 个、harness 侧 0 个。

起点 commit `7f234667e128`（labrunner/res-390-chaos-05），node v22.23.2，package 0.9.0。

## 1. 跑了多少轮 / 多少状态组合

- 轮数 1000，独立 seed 1000，真实状态观测 ≥17374 次
- 常驻 runtime 轮 500，一次性控制面轮 500
- generator：maxCommands=8，runtimeRatio=0.5，concurrency=3
- profile 轮数：process=168, file-state=168, race=165, mixed=112, provider-oauth=112, kernel-lifecycle=55, runtime-recovery=55, session-isolation=55, lifecycle-action-race=55, desktop-consistency=55

## 2. 命中了哪些 action / fault / invariant

- action：startRun=1393, commitPlan=1278, advance=1231, openConversation=467, build=369, refresh=204, concurrentBuild=202, multiConversationBuild=174, retryBuild=157, burstRefresh=142, duplicateCommit=131, switchConversation=129, desktopRestart=123, resumeRun=113, completionGate=70, phaseContract=64, listWorkflows=60, history=60, stopRun=54, authorize=47, phaseCard=43
- fault 真注入：killKernelDuringBuild=91, killRuntimeDuringBuild=51, restartRuntimeDuringBuild=50, missingRunStateFile=48, killKernelChild=47, raceUserActionDuringKernelFault=46, killAuthorityDuringBuild=37, raceRepeatSubmitDuringFault=35, raceLegalOrderSwap=31, providerCredentialExpired=30, providerCredentialDropped=30, raceCrossConversationFault=29, pauseKernelDuringBuild=28, raceTwoConversationsBuild=28, partialStateWrite=27, killPrimeRuntime=26, unreadableRunStateFile=25, pauseRuntimeDuringBuild=23, providerCredentialBlanked=22, raceRestartDuringTransition=17, pauseAuthorityDuringBuild=13, missingDesktopProjection=13, killIdleKernel=3
- fault 不适用：killAuthorityDuringBuild=57, raceRestartDuringTransition=51, killIdleKernel=39, missingDesktopProjection=34, pauseAuthorityDuringBuild=23, killRuntimeDuringBuild=20, raceTwoConversationsBuild=17, restartRuntimeDuringBuild=15, raceUserActionDuringKernelFault=15, cpuPressure=12, raceCrossConversationFault=10, partialStateWrite=9, pauseRuntimeDuringBuild=9, killKernelChild=8, missingRunStateFile=7, killKernelDuringBuild=7, unreadableRunStateFile=6, raceRepeatSubmitDuringFault=5, raceLegalOrderSwap=5, pauseKernelDuringBuild=1
- invariant 每轮都查：no-orphan-kernel, run-ownership, terminal-state-stable, artifact-integrity, recovery-convergence, fault-outcome-honest
- 真实组件：authority=5030, kernel=1211, run-store=704, runtime=207, provider-oauth=86, desktop-projection=48, prime=27

| 边界 | 轮数 | 真注入次数 | 注入/轮 |
| --- | --- | --- | --- |
| process | 264 | 369 | 36.9% |
| file-state | 98 | 113 | 11.3% |
| provider-oauth | 72 | 82 | 8.2% |
| race | 148 | 186 | 18.6% |

## 3. 发现多少 failure，多少 unique

失败轮 6 轮 → unique 4 个。归并维度：坏掉哪个 invariant + 归一化后的失败原因（pid、run id、临时目录、hash、出现次数、哪一步收场都不算身份）；每个 cluster 另外留下失败边界、出错步骤、序列形状和日志签名。

产品侧 4 个是真产品发现；harness 侧 0 个是 harness 自己的 fault 注入出问题（比如故障之间互相踩到），要修 harness，不能当产品 bug 报。

| cluster | invariant | 边界 | 哪一侧 | 出错步骤 | 次数 | 结论 | 最小复现 | 原因 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| c41b23f2c | no-orphan-kernel | process | product | action:advance, fault:restartRuntimeDuringBuild | 3 | reproducible | 5 步 | N 个 kernel 的父控制面已经死了，进程还在：#(owner=#) |
| c61f9d95e | recovery-convergence | process | product | fault:pauseAuthorityDuringBuild | 1 | false-positive | - | pauseAuthorityDuringBuild 之后系统没能恢复：model-build: authority exited with SIGKILL: ( |
| c0c99ebdb | recovery-convergence | process | product | action:build | 1 | false-positive | - | pauseRuntimeDuringBuild 之后系统没能恢复：model-build: authority exited with SIGKILL: (no |
| ca17c3c29 | recovery-convergence | process | product | fault:pauseAuthorityDuringBuild | 1 | flaky | 7 步 | restartRuntimeDuringBuild 之后系统没能恢复：Reify runtime socket timed out |

## 4. 哪些可以稳定 replay

- c41b23f2c `no-orphan-kernel`：reproducible（按序列 replay 3/3，seed+path 复现）
  - 最小复现 5 步（原始 5 步，numShrinks=0），commit=7f234667e128
  - artifact：/home/jingyi/symphony-workspaces/oh-my/reify/RES-390/chaos/campaigns/res390-main-1000/regressions/c41b23f2c-no-orphan-kernel.json
- c61f9d95e `recovery-convergence`：false-positive（按序列 replay 0/2，seed+path 未复现）
  - 第 1 次按序列 replay 没复现：序列跑完但没有复现失败
  - 第 2 次按序列 replay 没复现：序列跑完但没有复现失败
  - 按 seed+path 没复现：seed=1088643780 path=0 没有复现失败
- c0c99ebdb `recovery-convergence`：false-positive（按序列 replay 0/2，seed+path 未复现）
  - 第 1 次按序列 replay 没复现：序列跑完但没有复现失败
  - 第 2 次按序列 replay 没复现：序列跑完但没有复现失败
  - 按 seed+path 没复现：seed=-1415795833 path=0 没有复现失败
- ca17c3c29 `recovery-convergence`：flaky（按序列 replay 1/3，seed+path 复现）
  - 第 1 次按序列 replay 没复现：序列跑完但没有复现失败
  - 第 2 次按序列 replay 没复现：序列跑完但没有复现失败
  - 最小复现 7 步（原始 11 步，numShrinks=6），commit=7f234667e128
  - 这是偶发失败的 shrink 结果，只作最小证据，不代表稳定复现
  - artifact：/home/jingyi/symphony-workspaces/oh-my/reify/RES-390/chaos/campaigns/res390-main-1000/regressions/ca17c3c29-recovery-convergence.json

## 5. shrink 后最小路径

- c41b23f2c（5 步 → 5 步）
  `action:startRun → action:commitPlan → action:advance → fault:pauseKernelDuringBuild → fault:restartRuntimeDuringBuild`
- ca17c3c29（11 步 → 7 步）
  `action:startRun → action:commitPlan → action:advance → fault:missingDesktopProjection → fault:missingDesktopProjection → action:advance → fault:missingRunStateFile`

## 6. 高频 failure 集中在哪些边界

- process：4 个 unique，共 6 次

## 7. 哪些区域探索不足

- 各边界都有真注入，暂不需要加权重

## 每个 unique failure 的序列形状

- c41b23f2c `no-orphan-kernel`（3 次，seed 2095886532, 1959249991, 28520918）
  - `action:startRun → action:commitPlan → action:advance → fault:restartRuntimeDuringBuild → action:advance → fault:pauseRuntimeDuringBuild → fault:pauseRuntimeDuringBuild → action:refresh → fault:killKernelDuringBuild → fault:killRuntimeDuringBuild → action:advance`
  - `action:startRun → action:commitPlan → action:advance → fault:pauseKernelDuringBuild → fault:restartRuntimeDuringBuild`
  - `action:startRun → action:commitPlan → action:advance → fault:pauseAuthorityDuringBuild → action:resumeRun → action:refresh → action:refresh → fault:pauseKernelDuringBuild → action:retryBuild → action:desktopRestart → fault:restartRuntimeDuringBuild`
- c61f9d95e `recovery-convergence`（1 次，seed 1088643780）
  - `action:startRun → action:commitPlan → action:advance → action:advance → fault:pauseAuthorityDuringBuild`
- c0c99ebdb `recovery-convergence`（1 次，seed 2879171463）
  - `action:startRun → action:commitPlan → action:advance → action:startRun → action:refresh → fault:killRuntimeDuringBuild → fault:pauseRuntimeDuringBuild → action:phaseCard → action:build`
- ca17c3c29 `recovery-convergence`（1 次，seed 624507661）
  - `action:startRun → action:commitPlan → action:advance → fault:killAuthorityDuringBuild → fault:killRuntimeDuringBuild → action:build → fault:raceTwoConversationsBuild → fault:pauseKernelDuringBuild → fault:restartRuntimeDuringBuild → fault:pauseAuthorityDuringBuild`

## 复现信息

- campaign id：`res390-main-1000`，mode=nightly
- seed 基数：390000，轮数 1000，maxCommands 8
- profiles：mixed, process, file-state, provider-oauth, race, kernel-lifecycle, runtime-recovery, session-isolation, lifecycle-action-race, desktop-consistency
- provider 传输故障：关（opt-in）
- fault 池大小：24
- 环境：全默认

重跑同一条 campaign：

```bash
npm run chaos:reify -- campaign rerun chaos/campaigns/res390-main-1000
```

