# Reify chaos campaign res409-targeted-20260923

跑完 50 轮真 Reify：通过 50、失败 0、harness 报错 0。失败里 unique 0 个：稳定 0、偶发 0、假阳性 0、未验 0；其中产品侧 0 个、harness 侧 0 个。

起点 commit `8aa12102e39d`（codex/res-409-chaos），node v22.23.2，package 0.9.0。

## 1. 跑了多少轮 / 多少状态组合

- 轮数 50，独立 seed 50，真实状态观测 ≥1112 次
- 常驻 runtime 轮 50，一次性控制面轮 0
- generator：maxCommands=14，runtimeRatio=1，concurrency=1
- profile 轮数：provider-oauth=20, runtime-recovery=10, session-isolation=10, lifecycle-action-race=10

## 2. 命中了哪些 action / fault / invariant

- action：commitPlan=80, advance=76, startRun=71, build=32, openConversation=25, retryBuild=17, multiConversationBuild=16, refresh=13, concurrentBuild=13, switchConversation=12, desktopRestart=10, burstRefresh=9, duplicateCommit=7, stopRun=7, resumeRun=7, completionGate=6, authorize=6, history=4, phaseCard=4, phaseContract=4, listWorkflows=4
- fault 真注入：restartRuntimeDuringBuild=8, providerCredentialExpired=7, providerStreamCut=5, killRuntimeDuringBuild=5, killPrimeRuntime=5, providerReset=4, providerCredentialDropped=4, killKernelDuringBuild=4, providerCredentialBlanked=3, pauseRuntimeDuringBuild=3, providerServerError=3, providerTimeout=2, raceRepeatSubmitDuringFault=2, raceTwoConversationsBuild=2, raceCrossConversationFault=2, raceUserActionDuringKernelFault=2, raceRestartDuringTransition=1, providerRateLimited=1
- fault 不适用：raceRestartDuringTransition=3, raceUserActionDuringKernelFault=3, restartRuntimeDuringBuild=2, killAuthorityDuringBuild=2, raceTwoConversationsBuild=1
- fault 注入失败（InjectionFailed，前置成立却抛了真异常）：无
- fault 恢复失败（RecoveryFailed）：无
- invariant 每轮都查：no-orphan-kernel, run-ownership, terminal-state-stable, artifact-integrity, recovery-convergence, fault-outcome-honest
- 真实组件：authority=308, kernel=87, run-store=37, provider-oauth=34, runtime=27, prime=5

### 每个 fault 的注入结果

| fault | Injected | NotApplicable | InjectionFailed | RecoveryFailed |
| --- | --- | --- | --- | --- |
| restartRuntimeDuringBuild | 8 | 2 | 0 | 0 |
| providerCredentialExpired | 7 | 0 | 0 | 0 |
| killPrimeRuntime | 5 | 0 | 0 | 0 |
| killRuntimeDuringBuild | 5 | 0 | 0 | 0 |
| providerStreamCut | 5 | 0 | 0 | 0 |
| killKernelDuringBuild | 4 | 0 | 0 | 0 |
| providerCredentialDropped | 4 | 0 | 0 | 0 |
| providerReset | 4 | 0 | 0 | 0 |
| pauseRuntimeDuringBuild | 3 | 0 | 0 | 0 |
| providerCredentialBlanked | 3 | 0 | 0 | 0 |
| providerServerError | 3 | 0 | 0 | 0 |
| providerTimeout | 2 | 0 | 0 | 0 |
| raceCrossConversationFault | 2 | 0 | 0 | 0 |
| raceRepeatSubmitDuringFault | 2 | 0 | 0 | 0 |
| raceTwoConversationsBuild | 2 | 1 | 0 | 0 |
| raceUserActionDuringKernelFault | 2 | 3 | 0 | 0 |
| providerRateLimited | 1 | 0 | 0 | 0 |
| raceRestartDuringTransition | 1 | 3 | 0 | 0 |
| killAuthorityDuringBuild | 0 | 2 | 0 | 0 |

| 边界 | 轮数 | 真注入次数 | 注入/轮 |
| --- | --- | --- | --- |
| process | 14 | 25 | 50.0% |
| file-state | 0 | 0 | 0.0% |
| provider-oauth | 17 | 29 | 58.0% |
| race | 6 | 9 | 18.0% |

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

- campaign id：`res409-targeted-20260923`，mode=targeted
- seed 基数：4092026，轮数 50，maxCommands 14
- profiles：provider-oauth, runtime-recovery, session-isolation, lifecycle-action-race
- provider 传输故障：开
- fault 池大小：30
- 环境：CHAOS_REIFY_PROVIDER_FAULTS=1

重跑同一条 campaign：

```bash
npm run chaos:reify -- campaign rerun chaos/campaigns/res409-targeted-20260923
```
