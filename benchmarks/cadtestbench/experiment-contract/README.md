# Reify 实验合约 v1（RES-345）

这个目录是 ICLR 2027 投稿实验的可版本化合约。没有聊天上下文的 runner 只看这里，
就能知道跑什么、怎么分组、怎么计费、怎么提交、哪些行为不许被实现悄悄改掉。

来源：Linear 文档《ICLR 2027｜实验执行计划 v1（Linear执行版）》
（document `dc190e94-51f3-487b-a27e-88f4ac4571d8`，源文件 `experiment-plan-v1.md`，2026-09-19）。
总协调 [RES-344](https://linear.app/jingyi-dev/issue/RES-344/iclr-2027-投稿冲刺reify-完整系统论文919-926)，
合约票 RES-345，session 生命周期复用 [RES-342](https://linear.app/jingyi-dev/issue/RES-342/workflow-生命周期按-prime-conversation-隔离并持久化-run-绑定)/[RES-343](https://linear.app/jingyi-dev/issue/RES-343/desktop-会话生命周期新建切换恢复-conversation-不串-workflow)。

## 文件

| 文件 | 作用 |
| --- | --- |
| `experiment-contract.v1.json` | 唯一来源。组、矩阵、预算、三轮、经验开关、提交清单、计量字段、防护门 |
| `experiment-contract.v1.sha256` | 合约 hash，随 JSON 一起提交 |
| `contract.mjs` | 读取、规范化、复算 hash |
| `check.mjs` | 逐条检查仓库是否满足 pilot 防护门 |

复算 hash：

```bash
node benchmarks/cadtestbench/experiment-contract/contract.mjs --verify
```

有意改合约后重写 hash（会出现在 diff 里，必须人工复核）：

```bash
node benchmarks/cadtestbench/experiment-contract/contract.mjs --write-hash
```

## 实验组

| 组 | 定义 |
| --- | --- |
| G | 通用 Prime＋持久 IPython，工具、软件、领域资料与可读方法跟 Reify 对齐 |
| R0 | Reify 工作台/受管工具，只有通用领域知识，没有旧项目提炼的方法 |
| RT | R0＋专用 workflow 的完整文字方法，不运行阶段约束 |
| RF | 完整 Reify，题目到 default/专用 workflow 的映射预先冻结 |

G 与 RF 的可读方法内容对齐；两者差值是整体系统效果，不能单独归因 Managed Context。
模型 S 是主模型，C 是次模型；都要从环境导出精确 provider/model ID，并核验图片支持与 thinking 语义。

## 固定矩阵

| 实验 | 规模 | 次数 | 单次上限 |
| --- | --- | --- | --- |
| E1 公开 CADTestBench | 50 题 × G/RF × S/C | 200 | 20 分钟 |
| E2 连续工程项目 | 12 任务 × G/RF × S/C × 2 重复 | 96 | 3 轮各 30 分钟 |
| E3 方法复用 | 6 任务新增 R0/RT × C × 2 重复，RF 复用 E2 | 24 | 90 分钟 |
| E4a 观察 | 12 检查点 × 2 条件 × 2 重复，模型 S | 48 | 10 分钟 |
| E4b 恢复 | 6 检查点 × 2 条件 × 2 重复，模型 S | 24 | 15 分钟 |

核心 392 次，槽时上限 260.7 小时，规划按 4 并发、75% 利用率、10% 余量约 96 小时，
pilot 之后冻结实际预算。E1 扩到完整 200 题另加 300 次，只按资源决定，不按得分。

降级顺序：取消公开扩展 → 取消额外 thinking → 缩 E4b → 缩第二模型重复；
优先保留 12 个不同项目、G/RF 配对、S 模型重复。降级要事先登记。

## 主实验的三条硬规则

1. 经验读取、检索、写入、自动 refine 全部关闭；不是换一个经验目录名。
2. 隐藏检查与评分不回流，不用于返修；缺产物、超时、澄清请求都进完整分母。
3. 三轮续作与恢复按 conversation 绑定 run，复用 RES-342/RES-343，不另写第二套生命周期，
   不偷偷 reset canonical state。

## 提交

所有组用同一份 `submission.json` 结构和 hash 规则：最终 STEP、确定性源码、submission 清单与 hash；
运动题另交部件/关节，仿真题另交实际输入/网格/结果。
禁止把最近修改的 STEP 当提交，禁止要求只有 Reify 才有的私有记录作为基线条件。

## 计量字段

每条至少记录 experiment / task / family / variant / model / reasoning / repeat、
Reify 与 Prime SHA、workflow/skills/runtime/input/protocol hash、经验读写开关、
submission 与三轮结果、provider usage、现金与虚拟费用、峰值 context、compactions、
wall/queue/tool 时间、结束原因与完整性。
缺测保留 `null` 不能转 0；子 Agent、图片服务、工具等待与供应商重试都要入账；
一次 IPython 里多个 CAD 动作分别计量。

## 防护门与测试

```bash
node benchmarks/cadtestbench/experiment-contract/check.mjs   # 门状态表
npm run test:contract                                        # 绿色套件：冻结合约本身
npm run test:contract-red                                    # 显式 red suite，预期非 0
```

`check.mjs` 的每道门对应 `pilot_gates` 里的一条 pilot 要求（issue 问题项 1—8）。
当前 11 道门全部未过，说明这些行为还没实现；门过之前不放行付费批量。

红色套件是显式失败，不用 skip / xfail 假装通过，也不登记进默认套件，
所以现有通过套件不受影响：

* `tests/red/experiment-protection.red.test.mjs`：隔离、题面、经验开关、计量、提交、仿真附件、取消清理、方法来源
* `packages/prime-transcript-lab/red-tests/test_metering_gaps.py`：供应商重试与 `output-error` 漏账

绿色套件钉住今天已经正确的行为，不许被后续修复改坏：

* `tests/experiment-contract.test.mjs`：合约字段、矩阵与预算自洽、hash 可复算、防护门与合约一致
* `packages/prime-transcript-lab/tests/test_protection_contract.py`：子 Agent 用量、逐 CAD 动作计数、工具错误计数

实现修复后，先把对应 red 用例转绿再改合约版本；不放宽测试迁就实现。
