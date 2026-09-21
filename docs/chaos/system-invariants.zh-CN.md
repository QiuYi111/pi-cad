# Reify 系统 invariant

这份文档回答一个问题：

> Reify 在任何复杂时序下，哪些事情绝对不能发生？

它只做两件事：把规则写清，把规则接成能自动跑的检查。
不扩大随机故障空间，不做长时间 campaign，也不改 Reify 的行为。

## 怎么用

列出所有规则：

```bash
npm run chaos:invariants:list
```

对一个真项目跑一遍：

```bash
npm run chaos:invariants -- --cwd /path/to/project
```

输出 JSON 和存成 artifact：

```bash
npm run chaos:invariants -- --cwd /path/to/project --json --artifact chaos/artifacts/invariants.json
```

退出码：没有 violation = 0，有 = 1。可以直接当门禁。

一个项目可能同时有多个 store：桌面端用的数据目录，和 headless 或旧版本留下的
本地 `.pi-cad`。读错一个就会报假警。检查默认读最新的那个，并在输出里写明读了
哪个；也可以钉住某一个：

```bash
npm run chaos:invariants -- --cwd /path/to/project --storage-root /path/to/store
```

自动测试：

```bash
node tests/run-ts-tests.mjs   # 含 tests/chaos-invariants.test.ts
```

## 规则从哪读

每条规则只读 Reify 真实落盘的状态，不读内存缓存，也不拿假系统当参照：

| 来源 | 说明 |
| --- | --- |
| `<root>/v7-project/state.json` + `HEAD` | 项目当前选哪个 run、Project Head 的 artifact |
| `<root>/runs/<runId>/state.json` | 这个 run 的 phase、status、record、evidence、artifact、authority |
| `<root>/runs/<runId>/HEAD` + `transactions/<txId>/` | 已发布的 generation：commit、manifest、每个 payload 的 hash |
| `<root>/runs/<runId>/events.jsonl` | 每一代的事件，按提交顺序 |
| `<root>/runs/<runId>/workspace/commits/` | 工作区提交，含提交人会话 |
| `<root>/runs/<runId>/recipe-runs/<id>/record/` | 每个真 runtime 的状态 |
| `<root>/**/.head.lock` | 谁有权写这个 store |
| `<root>/runs/<runId>/recipe-runs/*.staging-<pid>` | 做到一半的 recipe 准备 |
| `<project>/.pi-cad/status.json` | 界面读的状态投影 |
| `/proc`（`kill(pid, 0)`） | 锁和 staging 的 owner 进程还在不在 |

`<root>` 是 `PI_CAD_CANONICAL_PROJECT_DIR`，没设就是 `<project>/.pi-cad`。

## 优先级

| 级别 | 含义 |
| --- | --- |
| P0 | 违了就是系统错，必须当 bug 修 |
| P1 | 高风险一致性和恢复问题，可能丢状态或卡住 |
| P2 | 适合长期 campaign 的质量规则 |

## 规则总表

下表都是已经自动跑的检查。字段含义见每条规则下面的小节。

| 级别 | 名字 | scope | 一句话 | grace / 预算 |
| --- | --- | --- | --- | --- |
| P0 | `run-identity-unique` | 会话 / run 隔离 | 一个 run 只有一个身份 | 0 |
| P0 | `project-run-reference-integrity` | 会话 / run 隔离 | project 指针必须指向真 run | 0 |
| P0 | `transaction-head-consistent` | 恢复 | 已发布的 generation 必须是完整可验证的链 | 未完成 generation 5 分钟 |
| P0 | `state-materialization-consistent` | 恢复 | 读到的 state 必须等于已发布的 generation | 0 |
| P0 | `terminal-state-stable` | 进程生命周期 | 终态不能回到活动态 | 0 |
| P0 | `artifact-integrity` | 副作用 / artifact | 记录的 artifact 必须存在且 hash 一致 | 0 |
| P0 | `no-duplicate-effect` | 副作用 / artifact | 同一个逻辑动作只能提交一次 | 0 |
| P0 | `single-active-runtime-per-run` | 进程生命周期 | 一个 run 最多一个活动 runtime | 终态残留 2 秒 |
| P0 | `conversation-run-binding` | 界面 / backend | 界面投影不能和 backend 矛盾 | 投影落后 30 秒 |
| P1 | `run-ownership-unique` | 会话 / run 隔离 | 一个 run 只能属于一个会话 | 0 |
| P1 | `no-orphan-owner` | 进程生命周期 | owner 死了不能留下锁或半成品目录 | 2 秒 |
| P1 | `settled-run-not-reconciled` | 恢复 | 终态 run 不能在 project 里一直挂着 | 90 秒 |
| P1 | `recovery-convergence` | 恢复 | 故障后必须在预算内收敛 | 90 秒 |
| P1 | `no-abandoned-runtime` | 恢复 | 卡住的 runtime 必须被收敛掉 | 120 秒 |
| P1 | `repeat-step-commit` | 副作用 / artifact | 同一步骤不应该反复提交 | 0 |
| P1 | `blocked-state-has-blocker` | 界面 / backend | blocked 状态必须说明卡在哪 | 0 |
| P1 | `projection-store-mismatch` | 界面 / backend | 投影和 store 必须来自同一个项目存储 | 投影落后 30 秒 |
| P1 | `authority-lifecycle-integrity` | 会话 / run 隔离 | authority 只能发一次、用一次 | 0 |
| P1 | `evidence-binding-integrity` | 副作用 / artifact | evidence 必须绑在当前的 workflow 和 obligation 上 | 0 |

## P0

### run-identity-unique

- scope：会话 / run 隔离
- why：run 目录名、project 记录、`state.runId` 必须是同一个值。对不上，后面所有归属和 artifact 检查都没有意义。
- state sources：`v7-project/state.json`、`runs/<runId>/state.json`
- check condition：project 的 run 列表没有重复 id；每个有 state 的 run 目录里 `state.runId` 等于目录名。
- grace / budget：0
- failure evidence：目录路径、目录名、state 里写的 runId、重复的 id 列表
- known exceptions：没有

### project-run-reference-integrity

- scope：会话 / run 隔离
- why：`currentRunId`、`promotedRunId`、Project Head 的 artifact 是唯一的选中依据。指向不存在的 run，界面就会显示一个已经不存在的 run。
- state sources：`v7-project/state.json`、`runs/<runId>/state.json`
- check condition：`currentRunId` 必须有 run 目录；`promotedRunId` 必须存在且是终态；`project.head.artifacts` 的 id 和 hash 必须等于被提升 run 的 `artifacts`。
- grace / budget：0
- failure evidence：指针值、存在的 run 列表、Project Head 和 run 的 artifact 对照
- known exceptions：项目还没建过 run 时不检查

### transaction-head-consistent

- scope：恢复
- why：HEAD、commit、manifest、payload 任何一环 hash 对不上，说明这一代是撕裂的，读出来的状态不可信。
- state sources：`<store>/HEAD`、`transactions/<txId>/commit.json`、`manifest.json`、每个 payload
- check condition：`sha256(commit.json) == HEAD.commitHash`；`sha256(manifest.json) == commit.manifestHash`；txId、generation 一致；每个 payload 的字节数和 hash 都对得上；parent 链能走到 generation 0；没有超过 grace 的没提交完的 generation。
- grace / budget：5 分钟
- failure evidence：store 名、第几条错、错的路径、期望和实测 hash
- known exceptions：正在写的那一代在 5 分钟内不算错

### state-materialization-consistent

- scope：恢复
- why：恢复只做一半，读到的就是旧状态。`materialize` 落后或 `events.jsonl` 行数不对，都说明这次恢复不完整。
- state sources：`<store>/state.json`、`transactions/<txId>/state.json`、`events.jsonl`、`HEAD`
- check condition：读到的 `state.json` 字节 hash 等于 HEAD 那一代发布的 `state.json`；`events.jsonl` 行数等于 HEAD.generation。
- grace / budget：0
- failure evidence：store 名、两个 hash、events 行数和 generation
- known exceptions：没有

### terminal-state-stable

- scope：进程生命周期
- why：终态回退会让 stop / cancel 失效，旧 run 继续产生副作用。
- state sources：`runs/<runId>/transactions/<txId>/state.json`（逐代）、`v7-project/state.json`
- check condition：按代读 status，出现 `done` / `aborted` / `blocked_user` / `blocked_external` / `budget_exhausted` 之后，任何一代不得再是非终态；project 也不能把终态 run 选成 `currentRunId`。
- grace / budget：0
- failure evidence：run、先到终态的那一代和 status、又变活的那一代和 status
- known exceptions：没有。要继续做就开新 run

### artifact-integrity

- scope：副作用 / artifact
- why：state 记了 artifact 但盘上没有或 hash 变了，后面所有 review、交付都建立在假事实上。
- state sources：`runs/<runId>/state.json`、项目工作区文件、`transactions/<txId>/evidence/**`、`records/**`、`v7-project/state.json`
- check condition：每个 artifact、evidence、record 的文件都在，identity 等于记录值；Project Head 的 artifact 同样；一个 run 只有一份 `candidate:authoritative`。
- grace / budget：0
- failure evidence：run、对象 id、位置（工作区 / run store）、路径、记录 hash、实测 hash（缺失时为 null）
- identity 怎么算（跟 Reify 自己的定义一致，不能一律按文件字节算）：
  - artifact：文件字节的 sha256
  - record：payload 的 canonical digest
  - candidate evidence：payload 里 `envelope` 的 canonical digest
  - 图片类 evidence：payload 指的项目文件按 `payload.path` 找，比该文件字节的 sha256
- known exceptions：没有

### no-duplicate-effect

- scope：副作用 / artifact
- why：同一步骤重复 commit，会让一次设计动作产生两个 effect，历史和 artifact 都对不上。
- state sources：`runs/<runId>/workspace/commits/index.json`、`workspace/commits/<id>.json`
- check condition：index 里 id 不重复；每个 index 项都有 manifest，manifest 的 id 等于文件名。
- grace / budget：0
- failure evidence：run、重复的 id、对不上的 manifest
- known exceptions：同名但不同 phase 的提交由代码定义成不同 identity，放到 `repeat-step-commit` 里看

### single-active-runtime-per-run

- scope：进程生命周期
- why：两个 runtime 同时跑同一个 run，会各写一份 artifact、互相覆盖，也说不清谁的副作用算数。
- state sources：`runs/<runId>/recipe-runs/<id>/record/run.json`
- check condition：一个 run 里 `running` 的 runtime 记录最多一条；run 到终态后不得再留 `running` 记录超过 grace。
- grace / budget：终态残留 2 秒
- failure evidence：run、runtime id 列表、status、已静默时长
- known exceptions：刚启动、还没写进记录的 runtime

### conversation-run-binding

- scope：界面 / backend
- why：投影显示另一个 run 的阶段或终态，用户会以为自己的设计变了。
- state sources：`<project>/.pi-cad/status.json`、`v7-project/state.json`、`runs/<runId>/state.json`
- check condition：投影的 `project.id` 等于 backend；`currentRunId` 一致；投影里的 run 必须是本项目 `currentRunId` 或 `promotedRunId`；该 run 的 status、phase、workflowHash 和 backend 一致。投影比 backend 新时按 grace 放宽。
- grace / budget：投影落后 30 秒
- failure evidence：投影路径、投影值、backend 值、投影年龄
- known exceptions：投影写入发生在状态变更之后，30 秒内的落后不算错

## P1

### run-ownership-unique

- scope：会话 / run 隔离
- why：两个会话共用一个 run，会让一个会话的设计动作出现在另一个会话里。
- state sources：`runs/<runId>/workspace/commits/<id>.json`、`state.json`、`recipe-runs/<id>/record/run.json`
- check condition：一个 run 的提交里最多一个会话名；`state.projectId` 等于项目的 `projectId`；runtime 记录里的 `workflowRunId` 等于它所在的 run。
- grace / budget：0
- failure evidence：run、会话列表、两边 projectId、runtime 和它声称的 owner
- known exceptions：`producer.session` 没写的历史提交不参与统计

### no-orphan-owner

- scope：进程生命周期
- why：死进程留下的锁和 staging 目录会挡住下一次写入，也让半成品看起来像真状态。
- state sources：`<store>/.head.lock`、`runs/<runId>/recipe-runs/*.staging-<pid>`
- check condition：锁记录的 pid 已经不存在、且锁存在超过 grace 时报警；staging 目录同理，pid 从目录名读。
- grace / budget：2 秒
- failure evidence：路径、pid、存在时长
- known exceptions：owner 存活，或者存活状态读不出来时不算错

### recovery-convergence

- scope：恢复
- why：没人推进、又没进终态的 run 会一直挂着，恢复要靠人推就不是恢复。
- state sources：`runs/<runId>/HEAD`、`state.json`、`<store>/.head.lock`
- check condition：status 是 `active` 或 `ready` 的 run，HEAD 超过预算没前进，且没有任何活着的 owner 时报警。
- grace / budget：90 秒
- failure evidence：run、status、phase、已静默时长、预算
- known exceptions：`waiting_user`、`blocked_user`、`blocked_external`、`budget_exhausted` 是在等人或等外部，不算不收敛
- 为什么重要：这种 run 会让 `cad_start` 拒绝开新 run，表现成「项目打不开新设计」

### settled-run-not-reconciled

- scope：恢复
- why：run 走到终态以后，要靠下一次 `cad_start` 的 reconcile 才会取消选中。超过预算还占着，说明 reconcile 从来没跑。
- state sources：`v7-project/state.json`、`runs/<runId>/state.json`、`runs/<runId>/HEAD`
- check condition：`currentRunId` 指向终态 run，且这个 run 的 HEAD 超过预算没动。
- grace / budget：90 秒
- failure evidence：run、status、已静默时长、预算
- known exceptions：`cad_start` 的 `reconcileCompletedRun` 会修；读取当前状态不受影响，所以不算 P0

### no-abandoned-runtime

- scope：恢复
- why：`running` 记录一直不动，说明进程已经死了但记录还装活着，下一次操作会以它为真。
- state sources：`runs/<runId>/recipe-runs/<id>/record/run.json`
- check condition：runtime 记录超过预算还停在 `running` 时报警。
- grace / budget：120 秒
- failure evidence：run、runtime id、静默时长、预算
- known exceptions：长任务要把预算调大，不能把规则删掉

### blocked-state-has-blocker

- scope：界面 / backend
- why：只显示 blocked 不说要什么，人和 agent 都没法解；done 还挂着 blocker 说明状态是假的。
- state sources：`runs/<runId>/state.json`
- check condition：`blocked_user` / `blocked_external` 必须有 `blocker`；`done` 不得还挂着 `blocker`。
- grace / budget：0
- failure evidence：run、status、blocker
- known exceptions：`waiting_user` 允许没有 blocker

### repeat-step-commit

- scope：副作用 / artifact
- why：名字、parent 都一样的提交出现两次，往往是一次动作写了两遍，后面查历史会分不清哪次算数。
- state sources：`runs/<runId>/workspace/commits/index.json`、`workspace/commits/<id>.json`
- check condition：同一个 `name + parent + workflowHash` 出现两个不同 commit 时报警。
- grace / budget：0
- failure evidence：run、步骤名、parent、两个 commit id
- known exceptions：Reify 的 commit identity 含 phase，所以同名不同 phase 的提交不算 corruption；这条只是质量信号，定在 P1

### projection-store-mismatch

- scope：界面 / backend
- why：投影指向本 store 没有的 run，说明读的是别的 store 或旧 store，再看下去只会报假警。
- state sources：`<project>/.pi-cad/status.json`、本 store 的 `v7-project/state.json`，以及所有候选 store
- check condition：投影里的 `currentRunId` / `promotedRunId` / run id 有一个不在本 store 的 run 列表里时报警，并把候选 store 和它们的 `updatedAt` 一起给出。
- grace / budget：投影落后 30 秒
- failure evidence：本 store、怎么选出来的、候选 store 列表、投影引用的 run、本 store 已知的 run
- known exceptions：没有

### authority-lifecycle-integrity

- scope：会话 / run 隔离
- why：authority id 重复，或者消费时间早于签发时间，等于一个许可被用成两个。
- state sources：`runs/<runId>/state.json`
- check condition：一个 run 里 authority id 不重复；`consumedAt` 不早于 `issuedAt`。
- grace / budget：0
- failure evidence：run、authority id、签发和消费时间、重复的 id
- known exceptions：没有

### evidence-binding-integrity

- scope：副作用 / artifact
- why：旧 workflow 的 evidence 留在当前集合里，会让已经过期的检查看起来还成立。
- state sources：`runs/<runId>/state.json`、`runs/<runId>/workflow.json`
- check condition：`evidence` 和 `records` 的 `workflowHash` 等于 run 当前 workflow；evidence 的 `obligationRef` 在 workflow 里有定义；同一条 evidence 不能同时在当前集合和过期集合里。
- grace / budget：0
- failure evidence：run、evidence / record id、绑的 workflow 或 obligation、当前值
- known exceptions：已经移进 `staleEvidence` 的旧 evidence

## 已写进 catalog，还没接 checker

这些规则同样重要，但需要新的状态来源，留到扩大真实接入面时做。

### provider-transient-not-permanent

- scope：provider / OAuth
- why：临时 timeout、429、断连不能变成永久卡死。
- state sources：provider 调用记录、run 的 `blocked_external` 和重试记录
- check condition：外因失败后必须在预算内重试或进明确的 blocked 状态。
- grace / budget：按 provider 预算
- failure evidence：失败次数、最后一次失败时间、当前 status
- known exceptions：用户明确取消
- 状态：未接 checker。当前没有 provider 调用记录这一状态来源

### oauth-expiry-visible

- scope：provider / OAuth
- why：OAuth 失效必须进明确可恢复或需用户动作的状态，不能静默失败。
- state sources：授权状态、run 的 blocker
- check condition：授权失效时必须有 `blocked_user` 加 blocker，或重新授权成功。
- grace / budget：授权检查周期
- failure evidence：授权状态、blocker
- known exceptions：没有
- 状态：未接 checker。授权状态由桌面端持有，还没落到可读状态

### token-session-isolation

- scope：provider / OAuth
- why：token / session 恢复不能串到另一个会话。
- state sources：会话与 token 的绑定
- check condition：一个 token 只服务一个会话。
- grace / budget：0
- failure evidence：token id、两个会话
- known exceptions：同一个用户显式共享
- 状态：未接 checker

### retry-bounded

- scope：恢复
- why：重试必须有界，否则恢复变成无限循环。
- state sources：run 事件里的重试记录
- check condition：同一个动作的重试次数不超过声明上限。
- grace / budget：按动作预算
- failure evidence：动作、次数、上限
- known exceptions：声明为长任务的 recipe
- 状态：未接 checker。事件里有动作，但还没有重试计数字段

### ui-terminal-from-runtime

- scope：界面 / backend
- why：terminal / retry / error 这些语义必须来自真 runtime 状态，不能由界面自己推断。
- state sources：runtime 状态、界面投影
- check condition：投影里的终态、错误、重试必须能在 runtime 记录里找到对应。
- grace / budget：投影落后 30 秒
- failure evidence：投影值、runtime 记录
- known exceptions：没有
- 状态：未接 checker。`conversation-run-binding` 先覆盖了 phase / status / workflowHash

### conversation-never-cross-bound

- scope：会话 / run 隔离
- why：一个会话不能静默绑到别的会话的 run。
- state sources：每个会话的 run 绑定
- check condition：会话的 run 一定属于该会话，且一个 run 只被一个会话使用。
- grace / budget：0
- failure evidence：会话、run、两边 owner
- known exceptions：没有
- 状态：部分接入。`run-ownership-unique` 覆盖了「一个 run 只属于一个会话」；会话侧的绑定表还没落盘

## 和 RES-384 的关系

RES-384 的 POC 已经证明这套手段能抓真问题：control plane 被 SIGKILL 后它起的 kernel 还在跑，`no-orphan-kernel` 抓到孤儿进程。

本单接着做系统化：

- 把规则从 5 条扩到 19 条自动检查，覆盖面加上隔离、恢复、投影、authority、evidence。
- 规则和 checker 都读 Reify 真实落盘状态，不读内存，也不拿假系统当参照。
- 每条规则都写清 grace 和预算，避免把瞬时中间态当 bug。
- 每条 violation 都带 evidence，直接能进 artifact。

本单不改 Reify 行为，也不为了过测试放宽规则。

## 拿真项目跑出来的结果

用本机几个真项目跑过。去掉「读错 store」和「把 evidence 当文件 hash」两个假警
之后，剩下的都是真问题，例如：

- 某个 run 记的 `artifacts/*.step` 和盘上文件 hash 不一致（文件在记录之后被重写）。
- 某个 run 停在 `active` 很久、也没有活着 owner，会让 `cad_start` 再也开不了新 run。
- 某个 run 走到 `done` 之后一直占着 `currentRunId`，说明 reconcile 没跑。
