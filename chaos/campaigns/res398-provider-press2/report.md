# Reify chaos campaign res398-provider-press2

跑完 100 轮真 Reify：通过 100、失败 0、harness 报错 0。失败里 unique 0 个：稳定 0、偶发 0、假阳性 0、未验 0；其中产品侧 0 个、harness 侧 0 个。

起点 commit `5e191b9894bc`（labrunner/res-398-chaos-06），node v22.23.2，package 0.9.0。

## 1. 跑了多少轮 / 多少状态组合

- 轮数 100，独立 seed 100，真实状态观测 ≥1730 次
- 常驻 runtime 轮 50，一次性控制面轮 50
- generator：maxCommands=10，runtimeRatio=0.5，concurrency=2
- profile 轮数：provider-oauth=100

## 2. 命中了哪些 action / fault / invariant

- action：startRun=134, commitPlan=127, advance=126, build=45, retryBuild=27, openConversation=23, refresh=23, duplicateCommit=20, concurrentBuild=19, multiConversationBuild=18, resumeRun=17, desktopRestart=15, burstRefresh=14, history=11, switchConversation=9, listWorkflows=8, phaseCard=7, phaseContract=6, stopRun=5, authorize=4, completionGate=3
- fault 真注入：providerCredentialExpired=20, providerTimeout=15, providerCredentialBlanked=13, providerRateLimited=13, providerCredentialDropped=12, providerStreamCut=8, providerReset=7, providerServerError=6, providerLatency=2
- fault 不适用：providerLatency=2
- fault 注入失败（InjectionFailed，前置成立却抛了真异常）：无
- fault 恢复失败（RecoveryFailed）：无
- invariant 每轮都查：no-orphan-kernel, run-ownership, terminal-state-stable, artifact-integrity, recovery-convergence, fault-outcome-honest
- 真实组件：authority=479, kernel=109, provider-oauth=104, run-store=73

### 每个 fault 的注入结果

| fault | Injected | NotApplicable | InjectionFailed | RecoveryFailed |
| --- | --- | --- | --- | --- |
| providerCredentialExpired | 20 | 0 | 0 | 0 |
| providerTimeout | 15 | 0 | 0 | 0 |
| providerCredentialBlanked | 13 | 0 | 0 | 0 |
| providerRateLimited | 13 | 0 | 0 | 0 |
| providerCredentialDropped | 12 | 0 | 0 | 0 |
| providerStreamCut | 8 | 0 | 0 | 0 |
| providerReset | 7 | 0 | 0 | 0 |
| providerServerError | 6 | 0 | 0 | 0 |
| providerLatency | 2 | 2 | 0 | 0 |

| 边界 | 轮数 | 真注入次数 | 注入/轮 |
| --- | --- | --- | --- |
| process | 0 | 0 | 0.0% |
| file-state | 0 | 0 | 0.0% |
| provider-oauth | 62 | 96 | 96.0% |
| race | 0 | 0 | 0.0% |

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

- process：0 次真注入
- file-state：0 次真注入
- race：0 次真注入

## 每个 unique failure 的序列形状


## 复现信息

- campaign id：`res398-provider-press2`，mode=targeted
- seed 基数：399100，轮数 100，maxCommands 10
- profiles：provider-oauth
- provider 传输故障：开
- fault 池大小：30
- 环境：CHAOS_REIFY_PROVIDER_FAULTS=1

重跑同一条 campaign：

```bash
npm run chaos:reify -- campaign rerun chaos/campaigns/res398-provider-press2
```

