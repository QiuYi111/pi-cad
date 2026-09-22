# Reify Chaos POC

最小可用的 Chaos 测试系统，用来发现 run / worker 这类系统级问题。
只做一条真实链路：

```
生成行为 → 注入故障 → invariant 失败 → 保存证据 → replay → shrink
```

不做 instruction-level 重放，不碰 hypervisor。

`chaos:demo` / `chaos:run` 跑的是 `chaos/sut/`：形状和 Reify 一样，但代码是另写的，
只用来验证 harness。要打**真 Reify 本体**，用 `chaos reify`（见下面「真 Reify slice」）。

## 一条命令跑起来

```bash
npm install
npm run chaos:fetch-tools     # 下载真的 Toxiproxy 二进制（可选，不装就少外部故障）
npm run chaos:demo            # 看一条真实故障链
npm run chaos:run             # 随机生成 action/fault 序列并检查 invariant
```

`pnpm` 用法一样：`pnpm chaos:run`、`pnpm chaos:replay <artifact>`。

> 本地跑真 Reify slice 需要两样东西（桌面安装包和 CI 里已就绪）：`python/.venv`
> （`npm run setup:python`），以及 Prime 的 peer 依赖；桌面会把它链到 prime-agent：
> `mkdir -p node_modules/@earendil-works && ln -sfn <prime-agent>/packages/coding-agent node_modules/@earendil-works/pi-coding-agent && ln -sfn <prime-agent>/packages/ai node_modules/@earendil-works/pi-ai`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm run chaos:demo` | 跑固定故障链：建 run → 起 worker → kill worker → 系统恢复 → 注入外部 API 故障 |
| `npm run chaos:run -- --runs 20` | fast-check 随机生成序列，跑不通过就存 artifact |
| `npm run chaos:run -- --bug double-worker` | 植入已知 bug，检查 runner 能不能发现 |
| `npm run chaos:replay -- chaos/artifacts/xxx.json` | 用 artifact 里的序列重放 |
| `npm run chaos:replay -- <artifact> --seed` | 用 artifact 里的 seed 重放 |
| `npm run chaos:shrink -- <artifact>` | 重新 shrink，报告最小复现步数 |
| `npm run chaos:bugs` | 列出可植入的 bug |
| `npm run chaos:invariants` | 列出所有 invariant |

`chaos:run` 退出码：默认没发现问题 = 0，发现问题 = 1；带 `--bug` 时反过来，发现 bug = 0。

## 目录

```
chaos/
  actions/      用户/系统动作
  faults/       进程故障 + 外部依赖故障，以及注入/恢复运行时
  invariants/   不变量检查
  model/        fast-check 序列生成
  runner/       执行、artifact、replay、shrink
  sut/          被测系统（控制面 / worker / 假外部 API / Toxiproxy 客户端）
  artifacts/    失败证据（git 忽略）
```

## 被测系统

`chaos/sut/` 是一个真的多进程系统，形状和 Reify 的 run / worker 一致：

- `server.ts`：控制面。管 run 状态机和 worker 生命周期，有真崩溃检测和恢复。
  run 状态：`PENDING → STARTING → RUNNING → STOPPING → COMPLETED / FAILED / CANCELED`。
- `worker.ts`：真子进程。注册、心跳、调外部 API、提交副作用、正常退出或被杀。
- `upstream.ts`：假外部 API（LLM / OAuth 之类）。
- `toxiproxy.ts`：真的 Toxiproxy 客户端，外部故障走它。

worker 到外部 API 的流量走 Toxiproxy，所以外部故障是真的 TCP 层故障。

## 已实现的 invariant

| 名字 | 含义 |
| --- | --- |
| `worker-ownership` | active worker 必须是它 run 当前的 worker，归属不能串 |
| `worker-liveness` | 记录说在跑的 worker，进程必须真的活着 |
| `single-active-worker` | 同一个 run 同时最多一个 active worker |
| `terminal-state-stable` | terminal state 不能回到 RUNNING |
| `recovery-convergence` | 没有 live worker 的 run 不能一直停在 STARTING / RUNNING / STOPPING |
| `ui-backend-consistency` | UI 状态投影必须等于 backend 状态 |
| `no-duplicate-effects` | 同一个 step token 只能产生一次副作用 |
| `no-unexpected-runs` | backend 不能凭空多出 run |

## 可植入的 bug（自检用）

`--bug <name>` 会在 SUT 里打开一个已知缺陷，用来确认 runner 真的能发现它：

- `double-worker`：worker 崩了以后旧记录不清理 → `worker-ownership` / `worker-liveness`
- `stuck-recovery`：崩了以后不恢复也不收敛 → `recovery-convergence`
- `terminal-revert`：terminal run 被刷新后回到 RUNNING → `terminal-state-stable`
- `duplicate-effect`：同一个 token 重复记副作用 → `no-duplicate-effects`
- `stale-ui`：UI 状态投影不刷新 → `ui-backend-consistency`

## 失败证据（artifact）

失败时写 `chaos/artifacts/<时间>-<invariant>.json`，包含：

```
seed                          fast-check seed
replayPath                    fast-check counterexample path
originalSequence              第一次失败时的随机序列（shrink 前）
shrunkSequence                shrink 后的最小序列
replaySequence                实际复现用的序列
actionSequence / faultSequence 分开的动作和故障
apiRequests                   runner 发过的关键 API 请求
externalRequests              真打到外部 API 的请求（含 token）
ids                           project / run / worker ID
stateTimeline                 每步的 run / worker 状态变化
logs                          runner 记的备注（比如某个故障没打上）
invariant / detail            失败的 invariant 和细节
```

## 新增一个 Action

在 `chaos/actions/index.ts` 里加一个对象，然后放进 `actionDefinitions`：

```ts
export const archiveRun: ActionDefinition = {
  name: "archiveRun",
  description: "归档一个 run",
  arbitrary: runIndexParams(),                     // fast-check 生成参数
  describe: (params) => `archiveRun(run#${params.runIndex})`,
  run: async (ctx) => {
    const snapshot = await ctx.session.snapshot();
    const run = pickRun(snapshot.runs, Number(ctx.params.runIndex ?? 0));
    if (!run) return;                              // 目标不存在就跳过
    await ctx.session.client.request("POST", `/api/runs/${run.id}/archive`);
    ctx.trace.record({ kind: "command", name: "archiveRun", detail: { runId: run.id } });
  },
};
```

要求：

- 参数只能来自 `arbitrary`，必须可 JSON 序列化，不能有隐藏随机；
- 目标不存在时安静跳过，不要抛；
- 调 API 的客户端方法写进 `chaos/sut/client.ts`；
- 想影响生成权重，在 `chaos/model/commands.ts` 的 `ACTION_WEIGHTS` 里加名字。

## 新增一个 Fault

加 `inject` 和 `recover` 两个方法，放进 `chaos/faults/index.ts` 的对应数组：

```ts
export const killWorkerAfterDelay: FaultDefinition = {
  name: "killWorkerDelayed",
  description: "延迟后杀掉 worker",
  arbitrary: fc.record({ delayMs: fc.integer({ min: 100, max: 800 }) }),
  describe: (params) => `killWorkerDelayed(${params.delayMs}ms)`,
  inject: async (ctx) => { /* 现在注入 */ },
  recover: async (ctx) => { /* 恢复，必须幂等 */ },
};
```

- 进程故障放进 `processFaultDefinitions`（kill / pause / resume 这类信号）；
- 外部依赖故障放进 `externalFaultDefinitions`（走 Toxiproxy），
  没装 Toxiproxy 时这些不会参与生成；
- 加进 `allFaultDefinitions` 才会被 runner 认识；
- `recover` 必须幂等，`chaos:run` 每轮结束都会调一次。

## 新增一个 Invariant

加一个对象放进 `chaos/invariants/index.ts` 的 `invariantDefinitions`：

```ts
const noOrphanWorker: InvariantDefinition = {
  name: "no-orphan-worker",
  description: "worker 不能指向不存在的 run",
  async check({ snapshot }) {
    const runIds = new Set(snapshot.runs.map((run) => run.id));
    for (const worker of snapshot.workers) {
      if (worker.status === "exited") continue;
      if (!runIds.has(worker.runId)) {
        throw new InvariantViolation("no-orphan-worker", `worker ${worker.id} 指向 ${worker.runId}`);
      }
    }
  },
};
```

`check` 在每条命令之后和稳定的过程中反复调用，每次拿到一份 `snapshot`。
需要跨时间判断（比如“卡了多久”）时，用 `session.history` 存时间戳。
顺序有意义：越靠前的 invariant 越先报错。

## 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `CHAOS_WORKER_STEPS` | 8 | worker 跑多少步 |
| `CHAOS_WORKER_STEP_MS` | 250 | 每步间隔 |
| `CHAOS_RECOVERY_DELAY_MS` | 120 | 崩溃后多久起新 worker |
| `CHAOS_STOP_GRACE_MS` | 300 | 正常停止多久后升级成 SIGKILL |
| `CHAOS_DEAD_WORKER_GRACE_MS` | 400 | worker 记录和进程状态允许的漂移 |
| `CHAOS_STALLED_RUN_BUDGET_MS` | 2500 | run 没有 live worker 的容忍时间 |
| `CHAOS_TOXIPROXY_BIN` | `.chaos-cache/bin/toxiproxy-server` | Toxiproxy 二进制位置 |

## 边界

- 只保证一条链路成立，不覆盖所有组件；
- worker 是本地进程，不是容器。想换成 Pumba 的容器 kill / pause，
  换掉进程故障实现即可，Action / Fault / Invariant 接口不用动；
- 外部故障依赖 Toxiproxy 二进制，没装就自动只跑进程故障。

## 真 Reify slice：`chaos reify`

上面那套打的是 `chaos/sut/`（自写的假系统）。这一段打的是 Reify 本体，代码在 `chaos/reify/`。

### 打的是真东西

- 真控制面：每条请求起一个真 `scripts/pi-cad-agent-api.mjs` 进程，跑生产代码。
- 真 run：真 `workflow-start` / `commit` / `workflow-advance`，状态落真 run store（`v7-project/state.json` + `runs/<id>/state.json`）。
- 真 kernel：`model-build` 让控制面起它自己的真 `cadctl.worker` 进程（build123d），真出 STEP。
- 真故障：对上面这些真进程发 SIGKILL / SIGSTOP / SIGCONT。
- 真状态：invariant 全部从真 run store 和 `/proc` 读，不读假内存。

### 命令

| 命令 | 作用 |
| --- | --- |
| `npm run chaos:reify -- demo` | 一条真链路：真 run → 真 build → kill 真 kernel → kill 真控制面 |
| `npm run chaos:reify -- run --runs 6` | fast-check 生成真 action/fault 序列，发现失败就存 artifact |
| `npm run chaos:reify -- replay <artifact.json>` | 用 artifact 里存的序列重放 |
| `npm run chaos:reify -- replay <artifact.json> --seed` | 用 artifact 里的 seed + path 精确重放原路径（不重新搜索） |
| `npm run chaos:reify -- shrink <artifact.json>` | 沿记录的 seed + path 复现原失败，再继续 shrink |
| `npm run chaos:reify -- invariants` | 列出这一段用的 invariant |

`chaos:reify run` 发现问题退出码 1，没发现问题 0。

### Action / Fault

Action / Fault 空间现在很大，用一条命令看全：

```bash
npm run chaos:reify -- space          # 读得懂的清单
npm run chaos:reify -- space --json   # 机器可读
```

Action（真用户 / 系统操作，21 个）：`startRun`、`openConversation`、`switchConversation`、
`resumeRun`、`listWorkflows`、`history`、`commitPlan`、`duplicateCommit`、`advance`、`stopRun`、
`build`、`retryBuild`、`concurrentBuild`、`multiConversationBuild`、`refresh`、`burstRefresh`、
`phaseCard`、`phaseContract`、`completionGate`、`authorize`、`desktopRestart`。
每条序列前面固定有 `REIFY_SETUP`（startRun → commitPlan → advance(plan_ready)），保证故障有真 run 可打。

`phaseCard` / `phaseContract` / `completionGate` / `authorize` 是常驻 sidecar 面上的操作
（Desktop 和 Prime 走的就是它），所以只在一轮挂了 `--runtime` 的时候才真的发；没挂就记一条
「跳过：这是 sidecar 面操作」——一次性 CLI authority 本来就不暴露这几个 op。

Fault（30 个，按它真正打的边界分组）：

| 边界 | 名字 |
| --- | --- |
| 进程 / 资源 | `killKernelDuringBuild`、`pauseKernelDuringBuild`、`killAuthorityDuringBuild`、`pauseAuthorityDuringBuild`、`killIdleKernel`、`killKernelChild`、`killRuntimeDuringBuild`、`pauseRuntimeDuringBuild`、`restartRuntimeDuringBuild`、`killPrimeRuntime`、`cpuPressure` |
| 文件 / 状态 | `missingRunStateFile`、`unreadableRunStateFile`、`partialStateWrite`、`missingDesktopProjection` |
| provider / OAuth | `providerCredentialExpired`、`providerCredentialDropped`、`providerCredentialBlanked`、`providerTimeout`、`providerReset`、`providerLatency`、`providerStreamCut`、`providerRateLimited`、`providerServerError` |
| race / 时序 | `raceUserActionDuringKernelFault`、`raceTwoConversationsBuild`、`raceRestartDuringTransition`、`raceLegalOrderSwap`、`raceRepeatSubmitDuringFault`、`raceCrossConversationFault` |

race 那一组不是单步 fault：它在一个 `inject` 里真的同时或交错跑多步
（用户操作 + 故障、两个会话同时 build、transition 跑着的时候重启 runtime、两个合法操作换顺序、故障挂着时重复提交）。

其中两组的判定要更严：

- `raceRestartDuringTransition` 先读真 `workflow-current` 的 transitions，事件在当前阶段不合法就不适用；
  inject 里真发 transition 和真重启重叠，产品在重启生效前按 `illegal workflow transition` 一类理由拒绝，
  就报不适用，不记成一次注入。
- `raceLegalOrderSwap` 的 `first` 真的决定顺序：先跑完 A 再跑 B，所以 `build→commit` 和 `commit→build`
  是两条不同的真序列；precondition 先确认 build 和 commit 在当前阶段都真合法。

### Invariant

| 名字 | 含义 |
| --- | --- |
| `no-orphan-kernel` | 控制面进程死了，它起的 kernel 不能继续跑 |
| `run-ownership` | 会话绑的 run 必须真存在，一个 run 只能属于一个会话 |
| `terminal-state-stable` | terminal run 不能回到非 terminal |
| `artifact-integrity` | run 记的 artifact 必须真在盘上、hash 一致，且候选件只有一份 |
| `recovery-convergence` | 注入故障后必须在预算内由真 build 恢复 |

### artifact

`chaos:reify run` 失败时写 `chaos/artifacts/<时间>-reify-<invariant>.json`。
除了 POC 那套 seed / path / 序列，还多出真身份：真 run / 会话 / kernel pid、
真状态时间线、真请求日志、真恢复证据。可以直接 `replay` 和 `shrink`。

`seed` / `replayPath` / `maxCommands` 三个字段是一组：fast-check 的 path 只在
同一个生成器形状下才解得开，所以重放和 shrink 都用存下来的 `maxCommands`
重建生成器，按 path 精确复现原来的那条序列，不是拿同一个 seed 重新搜。
demo 那条链是手写的，没有 fast-check path，只能按序列 replay。

### 可信度上的两个坑（都已修）

- recover 抛错（不是 invariant 失败那种）原来只记一条 note 就过去了，故障还
  挂着也算这轮通过。现在一律转成 `recovery-convergence` violation。
- recover 完之后原来直接 return。现在会再取一次真 snapshot、重查一遍 invariant，
  避免「recover 之后状态其实不满足 invariant」被漏掉。

### 已经抓到的真问题（已修，RES-389）

真 build 途中 SIGKILL 控制面进程，控制面死了，它起的真 kernel 还在跑 → 孤儿进程，
触发 `no-orphan-kernel`。原因是 kernel 的清理只在正常关停时走
（`WarmCadctlWorker.stop()` 里 `process.kill(-pid)`），被 SIGKILL 时不会跑。
失败证据留在 `tests/fixtures/chaos/2026-09-21T15-49-19-348Z-reify-no-orphan-kernel.json`
（`chaos/artifacts/` 是生成物目录，不提交），
`chaos reify replay <artifact>` 可以重放同一段序列；修好之后同一段序列跑完不再复现。

修法（`python/cadctl/owner.py`）：spawn kernel 时把 owner 的 pid 和它当时的启动
时间放进环境（`PI_CAD_OWNER_PID` / `PI_CAD_OWNER_START`），kernel 自己盯着 owner。
owner 一没就先杀掉 fork 出来的 build 子树，再自己退出；fork 出来的 build 子进程
另外挂 `PR_SET_PDEATHSIG`，parent 被强杀也不会留下。被复用的 pid、僵尸进程都按死
处理。手工起的 cadctl 没有这份身份，行为不变；每个 kernel 只认自己的 owner，不会
碰别的 run 的进程。

`tests/chaos-reify.test.ts` 覆盖：owner 被 SIGKILL、正常 stop、runtime 重启、
两个 run 只清自己的 kernel，以及原失败 artifact 重放不再复现。

反过来，build 途中 SIGKILL / SIGSTOP kernel 都能正确恢复：控制面报
`cadctl worker exited with SIGKILL`，下一次真 build 成功。

### 被 SIGSTOP 的 warm kernel（已修，RES-394）

真 build 途中先把 warm kernel 整棵树 SIGSTOP，再 SIGKILL 它的 owner（一次性控制面
或常驻 runtime），kernel 会一直停在 `T` 状态，只有 `SIGCONT` 才退 →
`no-orphan-kernel`。RES-389 那套看门狗是 kernel 里的 Python 线程，进程被停住线程也
不跑；而且 warm kernel 的父进程本来是 `uv run`，owner 死了 uv 不死，kernel 连
「父进程没了」都等不到。

失败证据：`tests/fixtures/chaos/2026-09-22T05-24-59-068Z-reify-no-orphan-kernel.json`
（RES-390 主 soak round #92，seed 1959249991，`startRun → commitPlan → advance →
pauseKernelDuringBuild → restartRuntimeDuringBuild`）。

修法：kernel 改成由托管解释器直接 spawn（`python/.venv/bin/python -m cadctl.worker`，
`uv run` 只在环境还没装好时兜底），kernel 就是 owner 的直接子进程；worker 在 import
重活之前 arm `PR_SET_PDEATHSIG`，owner 一死由内核送 SIGKILL，进程停在 `T` 也照杀。
没有 owner 身份、或 owner 不是父进程（中间还夹着 launcher）时不 arm，行为照旧。

`tests/chaos-reify.test.ts` 覆盖：被 SIGSTOP 的 warm kernel 在 owner 被 SIGKILL 后不用
SIGCONT 也自己退，以及上面那条 artifact 重放不再复现。

顺带修正：`*DuringBuild` 这类故障现在会等到真 build 子进程（kernel fork 出来、
`setsid()` 过）出现才注入，否则可能停在一个还在 import build123d 的 kernel 上——那不
是这些故障声称的形态，worker 那时也还没绑好 owner。

### 这一段的环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `CHAOS_REIFY_RECOVERY_BUDGET_MS` | 90000 | 故障后要求恢复的预算 |
| `CHAOS_REIFY_ORPHAN_GRACE_MS` | 2000 | 控制面死后多久才把 kernel 算孤儿 |
| `CHAOS_REIFY_PAUSE_MS` | 3000 | pause 故障观察窗口 |
| `CHAOS_REIFY_FINAL_SETTLE_MS` | 1200 | 一轮结束前的稳定观察窗口 |
| `CHAOS_REIFY_KEEP` | - | `1` 时保留真项目目录，方便手查 |

## 接更多真组件：`chaos reify inspect`

上面那套只打 agent-api（每条请求一个进程）+ kernel。`inspect` 把同一套接驳到 Reify 的
主要运行面，本单只负责「接得上、看得见」，不新增 fault。

| 组件 | 打的是真东西 |
| --- | --- |
| runtime | 真 Reify authority sidecar **常驻进程**（Desktop 和 Prime 都连的那个真后端），走真 Unix socket 发真请求；能 start / stop / restart，pid 真会变 |
| Prime | 真 `prime-cad-sidecar.mjs --mode rpc` 进程，真 RPC `get_state` 握手（不发 provider turn）；另外从 `/proc` 看当前真在跑的 Prime 进程 |
| provider / OAuth | 真凭证库 `~/.prime/agent/auth.json`（只读 id / 类型 / 过期，不读 token 值）+ 真 `settings.json` 里的选择 + 真 Prime 模型注册表里的 baseUrl。默认只读，不发请求；要看真状态才显式开 `--provider-probe` |
| Desktop ↔ backend | 真 `.pi-cad/status.json` 投影 vs 真 run store，给一组对照 |
| Windows ↔ WSL | 真探针：在 WSL 里通过真 `wsl.exe` 看 Windows 侧（发行版、WSL 版本），同时探 Linux 侧 node / uv / python / bwrap |

```bash
npm run chaos:reify -- inspect                       # 读得懂的输出
npm run chaos:reify -- inspect --json                # 机器可读
npm run chaos:reify -- inspect --prime               # 额外起真 Prime runtime
npm run chaos:reify -- inspect --provider-probe      # 才真发一次 provider 请求（默认不发）
```

provider 网络 probe 是**显式 opt-in**：默认只读本地凭证元数据 / 选择 / 注册表 endpoint，
不动外部世界。失败 artifact 收集固定不发 provider 请求。凭证类型按 Prime 真 schema 认：
`api_key` 读 `key`，`oauth` 读 `access`；显式 probe 时才拿真凭证带认证 header 发请求。

统一 identity：`project / conversation / run / runtime / kernel / provider`。
`inspect` 输出和 failure artifact 里都有这份归属图，每条边都带证据来源
（run store 绑定、`/proc` ppid、真 runtime pid 等）。

failure artifact 新增 `components`：runtime 的 pid 序列 / 真请求 / 日志尾巴、
provider 边界、Desktop 投影对照、WSL 边界、Prime 进程，以及 identity 图。

### 这一段新增的环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `CHAOS_REIFY_PROVIDER_PROBE` | - | 设 `1` 才真发 provider 请求；否则只读边界状态 |
| `CHAOS_REIFY_PROVIDER` / `CHAOS_REIFY_MODEL` | - | 覆盖 provider 选择（默认读 `~/.prime/agent/settings.json`） |

## 扩大真实 action / fault 空间：`chaos reify run`

这一段把可探索的行为 / 故障空间从「少量 kernel、进程 fault」扩到 Reify 的主要运行边界。

```bash
npm run chaos:reify -- run --runs 8 --max-commands 8            # 一次性控制面（每条请求一个进程）
npm run chaos:reify -- run --runs 8 --max-commands 8 --runtime  # 请求真的走常驻 runtime
npm run chaos:reify -- space                                    # 看空间有多大、各打哪条边界
```

`--runtime` 不是换一套假系统：它把每条请求送到真 `authority sidecar` 常驻进程
（Desktop 和 Prime 连的那个真后端）的 Unix socket 上，所以 `killRuntimeDuringBuild`
杀的是真后端，不是一次性的包装进程。

### fault 语义：不适用要明说，真异常不能被吞

每个 fault 步骤都留下一条明确结果，写进 trace 和 artifact 的 `faultOutcomes`：

```
NotApplicable    真的没有可打的目标（带原因）
Injected         真的注入了
InjectionFailed  前置检查通过，注入却抛了真异常 —— 这是失败，不是「不适用」
Recovered        恢复跑了，而且证明了系统还能干活
RecoveryFailed   恢复没成 —— 也是失败
```

判定顺序是刻意设计的：先跑 `precondition()` 读真状态；只有 precondition 说不适用，
或者 fault 自己显式抛 `FaultNotApplicable`，才算 `NotApplicable`。其它任何异常一律
`InjectionFailed`，并由 `fault-outcome-honest` invariant 兜底，不可能被记成「这轮跳过」。

这条规则对 precondition 自己读真状态同样成立：`workflow-current` 读失败不会被当成
「没有 active run / 当前阶段不允许」，而是直接抛出去，变成 `InjectionFailed`。

带 `conversationIndex` 的 fault，precondition、真 build、recover 全程用同一个 index，
记录里也直接写明真被打的会话和 run（`conv=… run=…`），artifact 的参数和真被打对象一致。

暂停类 fault（`pauseRuntimeDuringBuild`）的冻结时间窗收在 `inject` 里：SIGSTOP 到
`CHAOS_REIFY_PAUSE_MS` 之后自己 SIGCONT。否则请求会打在 harness 自己冻住的后端上，
每个后续请求都卡到 harness 自己的 socket 超时，再被记成「产品没恢复」——那是 harness
自己造的失败，不是产品问题；收在 inject 里之后，故障时长也不再随生成序列长短变化。

不适用是常态而不是噪音，例如：

- `cpuPressure` 在本机没有 `stress-ng` 时直接不适用（不自研压测工具）；
- `unreadableRunStateFile` 在 root 下不适用（root 无视文件权限，`chmod` 造不出「读不到」）；
- provider 传输故障默认不适用（`CHAOS_REIFY_PROVIDER_FAULTS=1` 才真打网络）；
- `killRuntimeDuringBuild` 在一轮没有挂常驻 runtime 时不适用（用 `--runtime`）。

### provider / OAuth 边界

两种真故障：

- 凭证侧：改的是**真 schema 的副本**（`<project>/prime-agent/auth.json`，从真
  `~/.prime/agent` 拷来），所以永远不会动本机真登录。过期 / 删除 / 清空 secret 之后，
  用真读取代码看它是不是真的判成不可用。
- 传输侧：真 `fault proxy`（`chaos/reify/provider-proxy.ts`）挡在真 provider endpoint
  前面，上游那一跳是真 TLS 连接、带真凭证 header，故障真的打在线上：
  `hang`（客户端自己的超时才是失败）、`reset`（真 RST）、`latency`、`truncate`
  （真响应的前缀之后断流）、`status`（429 / 5xx）。

传输侧是显式 opt-in：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `CHAOS_REIFY_PROVIDER_FAULTS` | - | 设 `1` 才真发 provider 请求做传输故障 |
| `CHAOS_REIFY_PROVIDER_TIMEOUT_MS` | 2500 | 传输故障里客户端自己的超时 |

这一段不发真 LLM turn：真端点、真凭证、真字节在线上都是真的，只有 agent 回合本身没跑。

### 文件 / 状态故障与「harness 自己弄坏的东西」

`missingRunStateFile`、`unreadableRunStateFile`、`partialStateWrite` 会真的动
`runs/<id>/state.json`，`missingDesktopProjection` 会真的删 `.pi-cad/status.json`。
动过的东西登记在 `session.harnessDamage` 里，`run-ownership` / `artifact-integrity`
在这些对象上不判产品，免得分不清「产品坏了」和「是我们刚弄坏的」。
每个 fault 的 `recover()` 必须把原件放回去，否则那一轮算失败。

### 多 conversation / 多 run

`openConversation` 起第二个真会话，`multiConversationBuild` 两个会话同时真 build，
`raceTwoConversationsBuild` 在两边都 build 的时候杀其中一个 kernel，
`raceCrossConversationFault` 一边被打故障、另一边继续做真操作。
`run-ownership` 盯着归属不串。

### replay / shrink 跟着一起对

artifact 现在记了 `runtimeMode`：runtime 生命周期故障只在同样的模式下才复现，
所以 `replay` / `replay --seed` / `shrink` 会自动按 artifact 记的模式起 runtime。

### 已经抓到的真问题（`--runtime`）

build 途中 SIGKILL 常驻 runtime，runtime 死了但它起的真 cadctl kernel 还在跑，
触发 `no-orphan-kernel`。路径：

```
startRun → commitPlan → advance(plan_ready) → killRuntimeDuringBuild → commitPlan
```

seed=5、path=2，原始 5 步、shrink 后仍是 5 步。`replay`、`replay --seed`、`shrink`
都能复现。和 RES-384 抓到的一次性控制面孤儿是同一类：kernel 的清理只在正常关停路径上走。

### 这一段新增的环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `CHAOS_REIFY_PROVIDER_FAULTS` | - | 设 `1` 才做 provider 传输故障（真联网） |
| `CHAOS_REIFY_PROVIDER_TIMEOUT_MS` | 2500 | provider 传输故障里客户端自己的超时 |
| `CHAOS_REIFY_CPU_WORKERS` | 2 | `cpuPressure` 用几个 CPU worker（上限 4） |

`recovery-convergence` 的预算、`CHAOS_REIFY_PAUSE_MS` 等沿用上面那张表。

## 大规模 campaign：`chaos reify campaign`

`chaos reify run` 是单次 fast-check：撞上第一个失败就停，一轮最多产出一个 artifact。
`campaign` 是它的外层，把"偶尔发现一个 bug"变成一份能查的数据集：

```
多轮独立采样 → 每轮落 artifact → 去重聚类 → replay / shrink → 报告
```

### 一条命令

```bash
npm run chaos:campaign -- run --mode nightly                       # 500 轮，全边界
npm run chaos:campaign -- run --mode short                         # 几分钟级，PR / CI 用
npm run chaos:campaign -- run --mode targeted --profiles kernel-lifecycle,runtime-recovery
npm run chaos:campaign -- rerun chaos/campaigns/<id>               # 用 manifest 原样重跑
npm run chaos:campaign -- report chaos/campaigns/<id>              # 重出 report.md
npm run chaos:campaign -- profiles                                 # 看 profile 和权重
npm run chaos:campaign -- list                                     # 看本地所有 campaign
```

常用参数：

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `--mode` | `short` | `short`（6 轮）/ `nightly`（500 轮）/ `targeted`（必须给 profile） |
| `--rounds` | 按 mode | 覆盖轮数 |
| `--seed` | 7000 | seed 基数；每轮 seed 由它确定性推出来 |
| `--max-commands` | 按 mode | 每轮 fast-check 的序列长度上限 |
| `--profiles` | 全部 | 只跑这些 profile，顺序即权重槽位 |
| `--runtime-ratio` | 0.5 | 多少比例的轮次把请求打到常驻 runtime |
| `--provider-faults` | 关 | 真的开 provider 传输故障（联网），显式 opt-in |
| `--concurrency` | 1 | 同时跑几轮；每轮自己一个 session |
| `--triage-replays` | 2 | 每个 unique failure 按序列 replay 几次 |
| `--skip-triage` | 关 | 跳过 replay / shrink，只出统计 |

### 轮次怎么排

轮数不是"跑 N 次同一个 seed"。第 i 轮的 seed 由 `(seed 基数, i)` 确定性散列出来，
profile 按权重铺成一个固定循环（`mixed` 2 槽、`process` 3 槽、`file-state` 3 槽、
`provider-oauth` 2 槽、`race` 3 槽，加 4 个定向 profile 各 1 槽），
runtime 模式按 `--runtime-ratio` 隔轮切换。所以"覆盖了哪些边界"是排出来的，不是碰运气：
500 轮的 nightly 里每个 profile 至少几十轮。

profile 决定这一轮的 fault 池。fault 池是生成器形状的一部分，所以它跟 seed、path、
`maxCommands` 一起写进 artifact —— `replay --seed` 和 `shrink` 会按同一份池重建生成器。

注意 profile 只换 fault 池，不动 action 的权重。池子越窄，序列里出现 fault 的比例越低：
跑满整个空间时大约 55% 的生成步骤是 fault，只留 3 个凭证 fault 时只有 9%。
所以定向 campaign 要多给轮数（`--profiles provider-oauth --rounds 50`），
不能指望几轮就打到。

### 一轮打什么

每轮独立 session，一轮最多一个 artifact，跑完立刻收掉自己的进程和 kernel。

轮内不做 shrink，也不做组件探测：shrink 一次要跑很多条真序列，把它放在 triage 上、
只对 unique failure 做。这样 500 轮才跑得完，invariant 一条都没放松。

### 去重：一次随机失败 ≠ 一个 issue

失败先算签名，签名相同的算同一个 unique failure：

```
invariant + 失败边界 + 出错的那一步 + 归一化后的原因 + 日志签名
```

归一化会把 pid / 端口 / 毫秒 / hash 抹成 `#`，所以"控制面死了、kernel 还在"这种
同一个 bug 不论换哪个 pid 都落在同一个 cluster。不同边界、出错步骤不同则分成两个。
cluster 里保留所有出现过的序列形状，供人确认是不是同一个根因。

### 三类结论

triage 会真的再跑一遍，不靠第一轮自己声称：

| 结论 | 判定 |
| --- | --- |
| `reproducible` | 按序列 replay 每次都复现，且按 seed+path 也能复现同一个 invariant |
| `flaky` | 有的复现有的没复现 |
| `false-positive` | 一次都没复现 |

结论只看 replay，不看 shrink：后面那趟开了 shrink 的重跑本身也算一次 replay，
所以它只能让结论更保守，不会把已经判成 `flaky` 的失败升成 `reproducible`。
（预审抓到过旧的写法：shrink 单次成功会无条件返回 `reproducible`。）

复现过的会被重新 `shrink`，最小序列和完整组件证据落在
`chaos/campaigns/<id>/regressions/` 下，可以直接当回归输入；偶发失败的 shrink
结果只当最小证据，报告里会标出来。

### 落盘的东西

```
chaos/campaigns/<id>/
  manifest.json     seed / profile / maxCommands / runtimeRatio / commit / 环境变量
  rounds.jsonl      每轮：seed / profile / 状态 / 真注入的 fault / 边界 / 组件 / 耗时
  artifacts/        每轮失败的原始 artifact
  clusters.json     unique failure 和各自证据
  regressions/      验证过、shrink 过的最小复现 artifact
  report.md         人看的报告
  report.json       机器读的同一份报告
  status.json       长跑期间的实时进度（progress-sync.mjs 读它）
```

`report.md` 直接回答七个问题：跑了多少轮 / 命中哪些 action、fault、invariant /
多少失败多少 unique / 哪些能稳定 replay / 最小路径是什么 / 高频失败集中在哪个边界 /
哪些区域探索不足该加权重。

### 长跑期间的进度同步

超过 5 分钟的 campaign 先用 `chaos/campaigns/progress-sync.mjs` 起一个后台同步，
每 5 分钟把 `status.json` 写进 Linear 的 Codex Workpad；阶段边界、阻塞和交付前停掉：

```bash
setsid nohup node chaos/campaigns/progress-sync.mjs --dir chaos/campaigns/<id> \
  > /tmp/campaign-sync.log 2>&1 < /dev/null &
```

### 已经跑过的 campaign

`chaos/campaigns/<id>/` 里提交了三样东西：`manifest.json`（跑法）、
`clusters.json`（unique failure 和证据）、`report.md` / `report.json`（结论），
以及验证过的 `regressions/` 最小复现（可以直接当回归输入）。原始
`rounds.jsonl` / `status.json` / `artifacts/` 不进 git。

改了去重口径或 product/harness 判定，不用重跑 500 轮：

```bash
npm run chaos:reify -- campaign recluster chaos/campaigns/<id>
```

recluster 只复用同一版 triage 规则算出来的旧结论；规则版本变了（改了三类判定
口径）就自动重判，report 里同时写明原始轮次跑在哪个 commit、post-processing
用的是哪个 commit。要强制全部重判加 `--retriage`。

`res388-main-500` 这一条的唯一产品发现是 `no-orphan-kernel`（26 次，最小复现
`startRun → commitPlan → advance → killAuthorityDuringBuild`）。它跑在 `63814903`
（base `5ff3dbbb`）上；RES-389 的修法合进 master（`d40b2e82`）之后，同一份
`regressions/c41b23f2c-no-orphan-kernel.json` 按序列和按 seed+path 都不再复现：
这是「campaign 报的问题是真问题、上游修法真的解决它」这两件事的同一个证据。
它入库的 `clusters.json` 也是在当前 head 上 recluster 过的，所以那 26 次
`no-orphan-kernel` 现在的结论是 `false-positive`（当前 head 0/2 不复现）；
原始跑法（`63814903`）和最小复现 artifact 都留着，对照的是轮次和注入分布。

`res388-main-500-post` 是它的同 seed 对照：同样 500 个 seed、同样的 profile 循环、
同样的 `maxCommands` 和 runtime 比例，跑在 `446da8de`（含 RES-389 `d40b2e82` 和
RES-383 `6b944fc6`）上。两边逐轮计划完全一致，真注入次数也基本一样
（process 141 / file-state 54 / provider-oauth 51 / race 52），结果从 28 轮失败 /
2 个 unique 变成 0 失败 —— 差别来自修好的产品行为，不是探索强度变了。

`res388-provider-targeted` 是显式开传输故障的定向 campaign（`--provider-faults`）：
60 轮全过，provider-oauth 边界真注入 52 次，凭证侧（expired / dropped / blanked）
和传输侧（timeout / reset / rateLimited / serverError / streamCut）8 个 fault 都真的
`Injected` 过，没有「只排进计划没真打」的轮次。

多 sandbox 共用凭证 / refresh 这条路不在这套 fault 里 —— campaign 打的是真
agent-api，不起 bwrap 沙箱。它由 `tests/prime-credentials.test.ts` 覆盖：两个真
bwrap 沙箱抢同一把 AuthStorage 锁，谁的写都不丢。
