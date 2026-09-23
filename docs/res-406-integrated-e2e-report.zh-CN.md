# RES-406 集成端到端验证报告

## 本次基线与场景

验证分支基于已合并的 Pi-CAD `master`：`306a7f1544ba8052690927fa3bba5985c6f86ead`（RES-420 PR #56）。Prime 源码固定为 `dfaee8067c5def339d1ca0d7b9f3573bc86c948c`。inline 路径使用 Prime 的真实 faux provider 与独立子代理；Desktop 路径通过生产 RPC sidecar 启动 Prime。两条路径均要求父代理和子代理调用 Prime typed image 通道。

集成夹具要求两个子代理各自先构造错误尺寸的模型、Probe、修正并再次 Probe。子代理 A 构造嵌套装配，改变销参数、插入无语义名称的 spacer 并逆序输出；验证器按 `arm/pin_a`、`arm/pin_b`、`arm/pin_a/hole_axis`、`arm/bracket_left/rib_face`、`arm/bracket_left`、`arm/bracket_right` 语义路径解析实例、孔轴与面组，确认重新排序后位置和实例数量保持，销体积从约 125.664 mm³ 变为 282.743 mm³。另验证旧实体引用失效、将 v1 清单错配至 v2 STEP 时拒绝 Probe、删除命名特征时构建失败。

同一轮还运行了 21 个离散运动姿态的真实干涉 Probe：两端无碰撞，首个碰撞样本位于归一化位置 0.3，最大交叠体积约 8000 mm³；结果明确标记样本之间的区间未验证。碰撞 pose 上注入 Boolean common 失败，集成 Probe 取得 `interference facts are unresolved` 错误；故障没有被分类为 clearance/contact，也没有返回零碰撞。另由真实 probe worker 抛出异常并核实错误显式返回。10 姿态批处理读取一次目标 STEP，完成 10 项、0 跳过、0 错误。inline 运行中，10 次独立 STEP 导入耗时 0.0697 秒，一次导入加批处理耗时 0.0324 秒；Desktop RPC 分别为 0.0815 秒和 0.0348 秒，返回 7621 字节 JSON。这是两次单机同轮微基准，不是旧版本对合并版本的端到端 Agent 对比，不据此宣称跨版本收益。

子代理在完成态 `done` 后读取工作流状态并使用显式、哈希绑定的 v2 `ArtifactRef` 执行 Probe；状态仍为 `done`。命名 commit `named-assembly-evidence` 仅包含 v2 ArtifactRef。inline STEP SHA-256 为 `e3c4b04fd60d224d36b2b09e0f374046a1ee6bb3067dadb17b3cbc76f4167fec`，manifest SHA-256 为 `42c5de608a5138e6c91e7e01266cc292b81e2b0cfa7778fa54cf6a8974700cf8`。Desktop RPC STEP SHA-256 为 `6395f22afa212d4a77167130508dc1d7c4b9876803db163273a784aa712c6694`，manifest SHA-256 为 `91f0f3f845e46775b384dd622a0ebc775417650cea1458caf5d5e5d2c2f98044`。两者的 Blender bridge 均对同一个文件返回相同 STEP hash，且四个语义 occurrence 均可见。

## 固定种子 Chaos

`node scripts/chaos.mjs reify run --runs 1 --seed 406 --max-commands 8 --json` 通过。生成并执行 8 项序列：`startRun → commitPlan → advance(plan_ready) → killKernelChild → raceLegalOrderSwap → missingDesktopProjection → concurrentBuild → history`。`concurrentBuild` 同时生成两个真实 STEP 输出，形成 build/export 交错。`killKernelChild` 与 `raceLegalOrderSwap` 注入并恢复。`missingDesktopProjection` 标记为 `NotApplicable`，原因是该轮未附加 Desktop runtime。验证的不变量包括无孤儿 kernel、run 所有权、终态稳定、artifact 完整性、恢复收敛和故障结果如实记录。此单轮不代表所有故障种类或并发压力均已覆盖。尤其尚未从生产 Desktop/daemon 控制面取消并重启一个 RLM 子代理、同时证明兄弟 kernel 保持存活；当前 provider failure 隔离不能替代这一验收。

## 运行命令与状态

- `PRIME_AGENT_REPO=.scratch/res406/prime-agent-main PRIME_AGENT_KERNEL_VENV=.scratch/res406/prime-kernel-venv node tests/prime-subagent-smoke.mjs`：通过，包含 Blender bridge 同件校验。
- `PRIME_AGENT_REPO=.scratch/res406/prime-agent-main PRIME_AGENT_KERNEL_VENV=.scratch/res406/prime-kernel-venv RES406_KEEP_SMOKE=1 node tests/prime-desktop-rpc-subagent-smoke.mjs`：通过；隔离 parent/child/grandchild run、child 故障恢复、adoption 与 Blender bridge 同件 hash 检查通过。
- `node scripts/chaos.mjs reify run --runs 1 --seed 406 --max-commands 8 --json`：通过。
- `npm run check:agent-contract`：通过。TypeScript harness：417 项，416 通过、1 跳过、0 失败（Toxiproxy 未安装）。Desktop Vitest：28 文件、217 项通过。Python unittest：214 项通过、7 项跳过、0 失败（385.183 秒）。两条 Prime smoke 也在更新后的 fixture 上通过，含孔轴/面组语义解析、Boolean fail-closed 注入和 probe worker 异常。

完整 Agent 级基线与合并版本的配对 KPI 尚未取得，因此不报告端到端时延或成功率差异。PR #56 合并记录中 Desktop CI 有独立失败（既有 Desktop TypeScript 类型错误及环境问题）；本 issue 将记录本分支实际 CI 结果，不把旧日志当作当前验证。
