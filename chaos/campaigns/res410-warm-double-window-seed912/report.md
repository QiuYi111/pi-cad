# Reify chaos campaign res410-warm-double-window-seed912

跑完 1 轮真 Reify：通过 1、失败 0、harness 报错 0。失败里 unique 0 个：稳定 0、偶发 0、假阳性 0、未验 0；其中产品侧 0 个、harness 侧 0 个。

起点 commit `8aa12102e39d`（codex/desktop-app），node v22.23.2，package 0.9.0。

## 1. 跑了多少轮 / 多少状态组合

- 轮数 1，独立 seed 1，真实状态观测 ≥14 次
- 常驻 runtime 轮 1，一次性控制面轮 0
- generator：maxCommands=12，runtimeRatio=1，concurrency=1
- profile 轮数：idle-kernel=1

## 2. 命中了哪些 action / fault / invariant

- action：startRun=1, commitPlan=1, advance=1, build=1, refresh=1
- fault 真注入：killIdleKernel=1
- fault 不适用：无
- fault 注入失败（InjectionFailed，前置成立却抛了真异常）：无
- fault 恢复失败（RecoveryFailed）：无
- invariant 每轮都查：no-orphan-kernel, run-ownership, terminal-state-stable, artifact-integrity, recovery-convergence, fault-outcome-honest
- 真实组件：authority=3, kernel=2, run-store=1

### 每个 fault 的注入结果

| fault | Injected | NotApplicable | InjectionFailed | RecoveryFailed |
| --- | --- | --- | --- | --- |
| killIdleKernel | 1 | 0 | 0 | 0 |

| 边界 | 轮数 | 真注入次数 | 注入/轮 |
| --- | --- | --- | --- |
| process | 1 | 1 | 100.0% |
| file-state | 0 | 0 | 0.0% |
| provider-oauth | 0 | 0 | 0.0% |
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

- file-state：0 次真注入
- provider-oauth：0 次真注入
- race：0 次真注入

## 每个 unique failure 的序列形状


## 复现信息

- campaign id：`res410-warm-double-window-seed912`，mode=targeted
- seed 基数：912，轮数 1，maxCommands 12
- profiles：idle-kernel
- provider 传输故障：关（opt-in）
- fault 池大小：24
- 环境：全默认

重跑同一条 campaign：

```bash
npm run chaos:reify -- campaign rerun chaos/campaigns/res410-warm-double-window-seed912
```
