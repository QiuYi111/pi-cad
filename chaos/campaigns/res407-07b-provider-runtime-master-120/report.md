# Reify chaos campaign res407-07b-provider-runtime-master-120

跑完 120 轮真 Reify：通过 120、失败 0、harness 报错 0。失败里 unique 0 个：稳定 0、偶发 0、假阳性 0、未验 0；其中产品侧 0 个、harness 侧 0 个。

起点 commit `8aa12102e39d`（codex/desktop-app），node v22.23.2，package 0.9.0。

## 1. 跑了多少轮 / 多少状态组合

- 轮数 120，独立 seed 120，真实状态观测 ≥2680 次
- 常驻 runtime 轮 120，一次性控制面轮 0
- generator：maxCommands=14，runtimeRatio=1，concurrency=1
- profile 轮数：provider-oauth=48, session-isolation=24, runtime-recovery=24, lifecycle-action-race=24

## 2. 命中了哪些 action / fault / invariant

- action：startRun=195, commitPlan=177, advance=163, build=70, openConversation=66, multiConversationBuild=46, concurrentBuild=43, retryBuild=35, refresh=32, desktopRestart=26, switchConversation=25, burstRefresh=24, resumeRun=23, duplicateCommit=22, history=15, authorize=14, stopRun=14, phaseContract=12, phaseCard=11, listWorkflows=10, completionGate=9
- fault 真注入：providerTimeout=16, providerCredentialExpired=15, killRuntimeDuringBuild=14, restartRuntimeDuringBuild=12, killKernelDuringBuild=9, providerCredentialDropped=9, raceTwoConversationsBuild=7, providerCredentialBlanked=6, providerRateLimited=6, raceRepeatSubmitDuringFault=5, providerReset=5, providerLatency=5, providerStreamCut=5, killPrimeRuntime=5, raceCrossConversationFault=5, providerServerError=4, pauseRuntimeDuringBuild=4, raceUserActionDuringKernelFault=4, raceRestartDuringTransition=3
- fault 不适用：killAuthorityDuringBuild=8, killRuntimeDuringBuild=7, raceUserActionDuringKernelFault=3, raceTwoConversationsBuild=2, raceCrossConversationFault=2, restartRuntimeDuringBuild=2, killKernelDuringBuild=1
- fault 注入失败（InjectionFailed，前置成立却抛了真异常）：无
- fault 恢复失败（RecoveryFailed）：无
- invariant 每轮都查：no-orphan-kernel, run-ownership, terminal-state-stable, artifact-integrity, recovery-convergence, fault-outcome-honest
- 真实组件：authority=734, kernel=215, run-store=104, provider-oauth=81, runtime=50, prime=6

### 每个 fault 的注入结果

| fault | Injected | NotApplicable | InjectionFailed | RecoveryFailed |
| --- | --- | --- | --- | --- |
| providerTimeout | 16 | 0 | 0 | 0 |
| providerCredentialExpired | 15 | 0 | 0 | 0 |
| killRuntimeDuringBuild | 14 | 7 | 0 | 0 |
| restartRuntimeDuringBuild | 12 | 2 | 0 | 0 |
| killKernelDuringBuild | 9 | 1 | 0 | 0 |
| providerCredentialDropped | 9 | 0 | 0 | 0 |
| raceTwoConversationsBuild | 7 | 2 | 0 | 0 |
| providerCredentialBlanked | 6 | 0 | 0 | 0 |
| providerRateLimited | 6 | 0 | 0 | 0 |
| killPrimeRuntime | 5 | 0 | 0 | 0 |
| providerLatency | 5 | 0 | 0 | 0 |
| providerReset | 5 | 0 | 0 | 0 |
| providerStreamCut | 5 | 0 | 0 | 0 |
| raceCrossConversationFault | 5 | 2 | 0 | 0 |
| raceRepeatSubmitDuringFault | 5 | 0 | 0 | 0 |
| pauseRuntimeDuringBuild | 4 | 0 | 0 | 0 |
| providerServerError | 4 | 0 | 0 | 0 |
| raceUserActionDuringKernelFault | 4 | 3 | 0 | 0 |
| raceRestartDuringTransition | 3 | 0 | 0 | 0 |
| killAuthorityDuringBuild | 0 | 8 | 0 | 0 |

| 边界 | 轮数 | 真注入次数 | 注入/轮 |
| --- | --- | --- | --- |
| process | 33 | 44 | 36.7% |
| file-state | 0 | 0 | 0.0% |
| provider-oauth | 40 | 71 | 59.2% |
| race | 19 | 24 | 20.0% |

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

## 每个 unique failure 的序列形状


## 复现信息

- campaign id：`res407-07b-provider-runtime-master-120`，mode=targeted
- seed 基数：409700，轮数 120，maxCommands 14
- profiles：provider-oauth, session-isolation, runtime-recovery, lifecycle-action-race
- provider 传输故障：开
- fault 池大小：30
- 环境：CHAOS_REIFY_PROVIDER_FAULTS=1

重跑同一条 campaign：

```bash
npm run chaos:reify -- campaign rerun chaos/campaigns/res407-07b-provider-runtime-master-120
```
