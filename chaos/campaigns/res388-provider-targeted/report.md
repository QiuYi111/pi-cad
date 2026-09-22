# Reify chaos campaign res388-provider-targeted

跑完 60 轮真 Reify：通过 60、失败 0、harness 报错 0。失败里 unique 0 个：稳定 0、偶发 0、假阳性 0、未验 0；其中产品侧 0 个、harness 侧 0 个。

起点 commit `446da8dedcb8`（labrunner/res-388-chaos-04），node v22.23.2，package 0.9.0。

## 1. 跑了多少轮 / 多少状态组合

- 轮数 60，独立 seed 60，真实状态观测 ≥1024 次
- 常驻 runtime 轮 30，一次性控制面轮 30
- generator：maxCommands=8，runtimeRatio=0.5，concurrency=2
- profile 轮数：provider-oauth=60

## 2. 命中了哪些 action / fault / invariant

- action：startRun=93, advance=78, commitPlan=76, build=18, openConversation=15, retryBuild=14, desktopRestart=13, burstRefresh=13, refresh=13, duplicateCommit=10, concurrentBuild=9, resumeRun=8, switchConversation=8, authorize=8, multiConversationBuild=5, phaseContract=5, history=4, stopRun=4, listWorkflows=2, completionGate=2, phaseCard=1
- fault 真注入：providerCredentialExpired=10, providerTimeout=10, providerReset=9, providerCredentialDropped=7, providerRateLimited=5, providerCredentialBlanked=4, providerServerError=4, providerStreamCut=3
- fault 不适用：无
- invariant 每轮都查：no-orphan-kernel, run-ownership, terminal-state-stable, artifact-integrity, recovery-convergence, fault-outcome-honest
- 真实组件：authority=313, provider-oauth=53, kernel=46, run-store=40

| 边界 | 轮数 | 真注入次数 | 注入/轮 |
| --- | --- | --- | --- |
| process | 0 | 0 | 0.0% |
| file-state | 0 | 0 | 0.0% |
| provider-oauth | 33 | 52 | 86.7% |
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

- campaign id：`res388-provider-targeted`，mode=targeted
- seed 基数：388500，轮数 60，maxCommands 8
- profiles：provider-oauth
- provider 传输故障：开
- fault 池大小：30
- 环境：CHAOS_REIFY_PROVIDER_FAULTS=1

重跑同一条 campaign：

```bash
npm run chaos:reify -- campaign rerun chaos/campaigns/res388-provider-targeted
```

