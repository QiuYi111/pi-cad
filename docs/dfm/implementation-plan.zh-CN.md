# DFM 内核实现计划：双层检查（文档 Lint + 特征识别），首个规则包为铨洲 CNC 铣削

日期：2026-10-09。读者：实现这个计划的模型（可以并行分给多个子代理）。
背景梳理：[overview.zh-CN.md](overview.zh-CN.md)。规则来源：[source/quanzhou-cnc-design-guide-v8.14.pdf](source/quanzhou-cnc-design-guide-v8.14.pdf)（铨洲智造设计建议，发布版本 8.14，2026-08-14，12 页）。

## 0. 用户已定

| 决定 | 内容 |
|---|---|
| 时间 | 现在开始。和 SaaS 并行。 |
| 第一个工艺 | 铨洲"CNC 智能制造打样"（铣削）。车铣是第二个规则包（P2）。 |
| 第二层 | 用 Analysis Situs 做特征识别。 |
| 方向（早先已定） | 自建规则引擎 + 规则包。不接外部 DFM API。CAM 是 CRO 的事。 |
| 默认建模路径 | FreeCAD `cad.part`（PR #59），导出在 PR #62。 |

## 1. 目标和非目标

**目标**

1. Agent 在建模过程中自动得到便宜的 DFM 反馈（第一层），并且可以按需得到完整的几何 DFM 报告（第二层）。
2. 每个问题指向一个语义对象（例如 `bracket/mount_hole`），并给出测量值、限值、修改建议和规则出处（PDF 页码）。
3. 问题面在图片上高亮。图片仍然每次必附。
4. 规则数值放在规则包文件里，不写死在代码里。换一家 CRO 只需要换规则包和少量检查函数。

**非目标（v1）**

- 不做 CAM、刀路、报价。
- 不保证铨洲一定接单。PDF 最后一页说明："验收一切以仿真为准，以上建议仅作为设计参考"。所以结果统一叫"预检"（precheck），不叫"通过认证"。
- 不阻止导出。v1 只在导出结果里报告 DFM 状态。
- 不做通用表达式 DSL。规则逻辑是 Python 函数，规则包只放参数和出处。

## 2. 总体结构

```text
cad.part apply/try ──► session._result ──► summary.dfm   (第一层，每次自动)
                                   │
                                   └─ 读：特征树参数 + 草图几何 + 包围盒

doc.dfm() ──► part-dfm 命令 ──► 第一层 + 第二层 ──► 报告 JSON + 高亮图片
                                   │
                                   ├─ 内置 OCCT 检查（FreeCAD worker 内）
                                   └─ reify-asi 子进程（Analysis Situs，OCCT 7.6）
                                          输入 .brep，输出 JSON（面 ID → 特征）
```

两层用同一个规则包、同一种结果格式。

### 2.1 为什么 Analysis Situs 必须是独立进程

- Analysis Situs 2024.2 用 OCCT 7.6（OCCT 7.8 只在开发分支 `occt-7_8_1_1`）。conda-forge 的 FreeCAD 用更新的 OCCT。同一进程加载两个 OCCT 会冲突。
- 所以：FreeCAD worker 把实体写成 `.brep` 文件，`reify-asi` 读文件，输出 JSON。这和"GPL/异构求解器用独立进程"的项目原则一致。
- 许可证：Analysis Situs 是 BSD-3-Clause（gitlab.com/ssv/AnalysisSitus 的 LICENSE）。可以随产品分发。issue 27 中这一项可以更新为"已确认"。

### 2.2 Analysis Situs 开源部分能做什么（已核实）

| 能力 | 开源 | 用于 |
|---|---|---|
| AAG（面邻接图，带二面角凹凸属性） | 是 | 所有识别的基础 |
| `recognize-holes`（钻孔：直径、深度、轴、通/盲） | 是 | 孔径、孔深比、螺纹底孔、孔底 |
| `recognize-cavities`（所有加工腔体及其基面，可设 `maxSize`） | 是 | 内腔、腰孔、窄槽 |
| `recognize-blends`（圆角链） | 是 | 内圆角、底部 R 角、双面 R 角 |
| `check-thickness`（厚度分布） | 是 | 薄壁、薄片 |
| 二面角 / 顶点凹凸检查 | 是 | 内尖角 |
| `recognize-shafts` | 是 | 车铣（P2） |
| CNC 铣削特征分类（槽、肩、型腔、螺纹、刻字等） | **否，商业扩展** | 不用。自己在内置检查里做需要的部分。 |

注意：官网的 CNC milling features 页面在商业扩展目录下。不要依赖它。

## 3. WP0：前置实验（先做，结果决定后面细节）

一个子代理做。结果写入 `docs/dfm/spike-results.md`（仓库内）。三项都必须有结论后才开始 WP3/WP4。WP1、WP2 可以同时开始。

| 编号 | 实验 | 通过条件 | 不通过时 |
|---|---|---|---|
| E0-a | 在 Linux（SaaS 工作区镜像同一发行版）无 GUI 构建 Analysis Situs 的 `asiAlgo` 库（tag `v2024.2`，OCCT 7.6），写一个最小 C++ 程序 `reify-asi`，读 `.brep`，运行孔识别，输出 JSON。 | 能构建，不需要 Qt/VTK；对测试板（40×30×5，4 个 φ3 通孔）识别出 4 个孔。 | 改用 Analysis Situs 的 Tcl 批处理方式（`asiExe` 运行脚本，解析输出）。仍不行：第二层只用内置检查，Analysis Situs 推到 P2，并告诉用户。 |
| E0-b | 面 ID 对应：FreeCAD 中 `shape.exportBrep()` 的面顺序，与 `reify-asi` 读同一文件后的面 ID 是否一致（两者都用 `TopExp::MapShapes` 顺序，1 起始）。另测 OCCT 7.6 能否读 FreeCAD 写的 `.brep`（必要时用 `BRepTools::Write` 的旧格式版本）。 | 10 个测试零件全部一一对应。 | 用面的质心 + 法向 + 面积做匹配（容差 1e-6 × 对角线）。 |
| E0-c | FreeCAD `PartDesign::Hole` 设 `Threaded=True`、`ModelThread=False` 时，实际切出的孔径是多少（M2–M12）。 | 记录每个规格的实际孔径，与铨洲底孔表（§5 表 H3）比较。 | 不需要"不通过"处理：结果决定 Q-H3 的建议文字（见 §5）。 |

E0-a 还要记录：构建时间、二进制大小、依赖库列表、冷启动时间、对 200 面零件的识别耗时。

## 4. 规则包格式

### 4.1 文件位置和格式

- 位置：`python/reify_freecad/dfm/rulepacks/quanzhou.cnc_mill.yaml`（随 worker 打包）。
- 格式：YAML。加载后用 JSON Schema（`python/reify_freecad/dfm/rulepack.schema.json`）校验。不合格时 worker 启动 DFM 命令就报 `DFM_RULEPACK_INVALID`。
- 依赖：conda 环境已有 `pyyaml` 时直接用；没有则加到 `python/runtimes/freecad/environment.yml` 并更新两个 lock 文件（用仓库现有的 lock 工具，不手改）。

### 4.2 结构

```yaml
schema: reify.dfm.rulepack/1
id: quanzhou.cnc_mill
title: 铨洲智造 CNC 智能制造打样（铣削）
vendor: 铨洲智造
source: {doc: quanzhou-cnc-design-guide-v8.14.pdf, version: "8.14", date: 2026-08-14}
process: {type: cnc_mill, setup: "3-axis, top and bottom setups"}
materials:
  al6061: {density_g_cm3: 2.70, size_limited: false}
  al7075: {density_g_cm3: 2.81, size_limited: true}
  steel_45: {density_g_cm3: 7.85, size_limited: true}
defaults: {material: al6061}
tables:
  tap_drill_mm: {M2: 1.6, M2.5: 2.05, M3: 2.5, M4: 3.3, M5: 4.2, M6: 5.0, M8: 6.8, M10: 8.5, M12: 10.2,
                 "UNC1/4-20": 5.105, "UNC3/8-16": 7.937}
  tool_diameters_mm: [1, 1.5, 2, 3, 4, 6, 8, 10, 12]   # 推断值，见 §5 注
rules:
  - id: hole.min_diameter
    check: hole_min_diameter        # Python 检查函数名
    layers: [lint, geometry]
    severity: error
    params: {min_mm: 1.2}
    source: {page: 1, quote: "孔 Φ1.2mm 以上"}
    hint: "孔径增大到 ≥ 1.2 mm"
```

字段规则：

- `layers`：`lint`、`geometry` 或两者。
- `severity`：`error`（大概率 NG 或违规）、`warn`（可能 NG、加工不完全或精度下降）、`info`（加工会改变几何或有外观影响，Agent 需要知道）。
- `source.page` 必填。`source.inferred: true` 表示数值是我们从 PDF 推断的，不是 PDF 原文。推断规则的 severity 最高为 `warn`。
- `hint`：英文或中文均可，可带 `{measured}`、`{limit}` 占位符。

## 5. 铨洲 CNC 铣削规则表（v1 全部要实现）

层：L = 第一层 Lint，G = 第二层几何。页码指 PDF 页。

### 5.1 毛坯、尺寸、材料

| ID | 规则 | 层 | 级别 | 页 |
|---|---|---|---|---|
| stock.size_range | 包围盒最小 10×10×1，最大 650×440×30 mm（按排序后的三边比较）。 | L | error | 1 |
| stock.size_limited_material | 材料是 7075 或 45# 钢时：尺寸范围以平台为准。 | L | info | 1 |
| stock.thickness_range | Z 向厚度 1–30 mm。 | L | error | 1 |
| stock.side_height | 侧面高度 > 200 mm 时，侧面只能有圆孔。 | G | error | 1 |
| stock.standard_thickness | Z 厚度不是常见标准板厚时报 info（有双面特征时在 message 中说明风险）。用户确认没有铨洲标准板厚表（2026-10-09），`params.standard_mm` 用常见铝板厚度，标 `inferred: true`，级别始终为 info。 | L+G | info | 2 |
| stock.thin_plate_large | Z 厚度 < 10 mm 且为大尺寸薄板时，必须是标准厚度；厚度 < 4 mm 时不允许大面积切除平面。"大尺寸"阈值 PDF 没给，先用最长边 > 200 mm 并标推断。 | L+G | warn | 7 |
| stock.removal_ratio | 去除率（1 − 体积 / 包围盒体积）过高会有应力变形。阈值推断 0.8。 | L | warn | 7 |
| stock.surface_treatment | 7075、45# 钢建议选表面处理。 | L | info | 11 |
| tol.general | 默认精度 GB/T 1804-m。`dimension` 意图的公差严于 m 级时报 info：需要精孔补偿或另行沟通。 | L | info | 1 |
| tol.precision_hole | 精孔实际精度 0–0.02。有配合要求的孔建议建模放大 0.02–0.03。当孔有 `dimension` 意图且公差 < 0.03 时提示。 | L | info | 8 |

### 5.2 孔

| ID | 规则 | 层 | 级别 | 页 |
|---|---|---|---|---|
| hole.min_diameter | 孔径 ≥ 1.2 mm。 | L+G | error | 1 |
| hole.depth_ratio | 孔深 / 孔径：≤ 3 无问题；3–5 报 info（钻头加工，精度稍低）；5–8 报 warn（超过 p.1 表格的 5 倍径）；> 8 报 error（p.8 最大 8 倍径）。PDF 两处数值不同（p.1 "<5 倍径"，p.8 "最大 8 倍"），按这个分级处理。 | L+G | info/warn/error | 1, 8 |
| hole.thread_tap_drill | 螺纹孔底孔直径必须等于底孔表（`tables.tap_drill_mm`），容差 ±0.05。平台靠底孔直径识别螺纹。 | L+G | error | 1 |
| hole.thread_modeled | `ModelThread=True`（建模真实螺纹）时报 warn：平台按底孔识别，真实螺纹几何会破坏识别。（推断） | L | warn | 1 |
| hole.thread_length | 螺纹有效长度 ≤ 5 × 公称直径。 | L | error | 1 |
| hole.thread_min_depth | 螺纹最小牙深：≥ M3 时 ≥ 0.6 × D；< M3 时 ≥ 0.8 × D。建议锁紧长度 1–2 × D（info）。 | L | warn | 1 |
| hole.thread_blind_extra | 盲孔攻牙有约 1 倍径深度公差：盲孔底孔深度应 ≥ 螺纹深度 + 1 × D。（由 p.1 例子推断：M3 底孔 7.5，有效 5–6） | L | warn | 1 |
| hole.thread_side_wall | 螺纹孔到外壁的余量 ≥ 1 mm，否则攻牙后可能破壁。 | G | error | 1 |
| hole.blind_bottom_wall | 盲孔孔底到对面的壁厚 ≥ 孔径 / 2；小孔 ≥ 1 mm。 | G | warn | 8 |
| hole.bottom_shape | 盲孔底部：球形 / 圆弧底不支持（error）；锥形钻尖底（FreeCAD 默认 `DrillPoint=Angled`）建议改平底（info，推断：铨洲盲孔用铣刀螺旋铣平底）。 | L+G | error/info | 5, 8 |
| hole.internal_chamfer | 孔内倒角（台阶孔中间的倒角）不支持。 | G | warn | 5 |
| hole.ring_groove | 孔内环槽、T 槽不支持。 | G | warn | 5 |
| hole.countersink | 沉头孔（锥形）可能 NG 或加工不完全，建议改杯头孔（`Counterbore`）。 | L+G | warn | 6 |
| hole.countersink_to_bottom | 沉头锥面不能画到底，底部必须留圆柱底孔。 | L+G | error | 6 |
| hole.side_support_face | 侧孔：与孔轴垂直的对面必须有平面作为加工支撑面，不能是曲面或斜面。 | G | error | 4 |
| hole.waist_slot_depth | 腰孔深度 ≤ 3 × 宽度；长宽比 > 2:1 时可放宽（报 info 而不是 warn）。 | L+G | warn | 10 |

### 5.3 内腔、槽、内角

| ID | 规则 | 层 | 级别 | 页 |
|---|---|---|---|---|
| cavity.min_width | 内腔 / 内槽宽度 ≥ 1.25 mm（最小刀具 φ1；p.1 表格写 1.2，以 p.8 的 1.25 为准）。刻字最小间隙也 ≥ 1.25。 | L+G | error | 1, 8 |
| cavity.depth_tool_ratio | 槽深 ≤ 5 × 刀具直径。刀具直径 = `tool_diameters_mm` 中小于槽宽的最大值（例：槽宽 2.5 → φ2 → 深 ≤ 10）。 | L+G | error | 8 |
| corner.inner_auto_radius | 内竖直角半径 < 深度 / 5 时：平台会自动加工出 R = 深度 / 5 的圆角（例：深 10 → R2，深 20 → R4）。报 info，给出实际会出现的 R。若该角有配合（相邻面在某个 `min_clearance`/`dimension` 意图中），升为 warn。 | L+G | info/warn | 9 |
| corner.relief_size | 设计了清根避空时：避空半径必须 > 刀具半径，不能相等。推荐避空 φ1.2 / 1.7 / 2.2 / 3.2 / 4.2。 | G | warn | 9 |
| floor.chamfer | 底部（腔底与侧壁之间）倒 C 角不建议：会残留台阶或 NG。 | L+G | warn | 10 |
| floor.fillet_radius | 底部 R 角需要 > R2。 | L+G | warn | 10 |
| outer.concave_narrow | 外形内凹区域（开口窄槽）宽度小于最小刀具时，无法生成刀路。 | G | error | 5 |
| wall.min_thickness | 薄壁 / 薄片 ≥ 1 mm。 | G | error | 3 |
| wall.slender_suspended | 内部悬空细长结构：建议留 ≥ 0.5 mm 底面或加筋。识别为：长宽比高的薄壁且四周无底。 | G | warn | 7 |

### 5.4 双面特征和外形

| ID | 规则 | 层 | 级别 | 页 |
|---|---|---|---|---|
| edge.default_chamfer | 未倒角或 < C0.5 的锐边：平台默认 C0.1–0.5。 | L | info | 1 |
| edge.double_side_chamfer | 上下两面外形都有 > C0.5 倒角时可能 NG；标准厚度下双面 > C1 也可能 NG。建议外形不倒角。 | L+G | warn | 1, 2 |
| edge.double_side_fillet | 锐边 R 角只支持单面。上下两面都有 R 角会漏切或 NG。 | L+G | error | 2 |
| twoside.back_notch_ratio | 标准厚度可以有双面特征，但反面缺口尺寸不能超过该面外形尺寸的 30%。 | G | warn | 2 |
| twoside.nonstandard_back | 非标准厚度时，反面只能有圆形沉头孔台阶。 | G | warn | 2 |
| twoside.max_outline_top | 至少一面的最大外形必须在零件 Z 最高处。双面凸台结构（最大外形在中间）会 NG。 | G | error | 3 |
| surface.double_side_curved | 曲面（非平面、非竖直圆柱）只允许在一个方向（上或下）出现；两面都有曲面不支持。球刀最小 D4。 | G | error | 10 |
| surface.multi_face | 多面特征（侧面特征）会有接刀痕，不作为客诉标准。 | G | info | 4 |
| ganging.forbidden | 禁止拼板：多个零件用细小连接筋连成一体。有侧孔的零件绝对不能拼板。识别为：一个实体里有截面很小的连接段把两大块连起来。这是违规，会封号。 | G | error | 3, 5, 11 |

注：`tool_diameters_mm` 只有 φ1、φ2、φ4（D4 球刀）在 PDF 中出现。其余为常见刀具，标 `inferred: true`。

### 5.5 车铣（P2，第二个规则包 `quanzhou.cnc_turn`）

v1 不实现，只建空文件说明。内容（p.12）：材料 303/304 不锈钢；直径 ≤ 17.9 mm（棒料 18），长度 ≤ 50 mm 且 ≤ 3 × 直径；只加工外圆，不支持端面、孔、车铣复合；精度 ±0.03；外螺纹大径表 M2 1.9 … M12 11.8；螺纹必须有退刀槽和 C 角，槽深和 C 角 ≥ 螺距。第二层用 `recognize-shafts`。

## 6. 第一层 Lint（WP2）

### 6.1 输入

全部来自 worker 内存中已重算的文档。不解析 `ops.jsonl` 文本（表达式、单位、`undo`、默认值会导致不一致；cad.transfer 因同样原因禁止重放 ops）。

| 数据 | 来源 |
|---|---|
| 孔：`Diameter`、`Depth`、`DepthType`、`Threaded`、`ModelThread`、`ThreadSize`、`ThreadDepth`、`HoleCutType`、`HoleCut*`、`DrillPoint`、孔位置（草图圆心） | `PartDesign::Hole` 属性。复用 `transfer.py` 的 `_hole`、`_sketch_entry` 提取逻辑（把共用部分提到 `dfm/extract.py`，`transfer.py` 改为调用它，避免两份代码）。 |
| Pocket / Pad：深度、方向、草图闭合环 | `transfer.py` 的 `_pad_or_pocket`、`_geometry`。 |
| 草图环的最小宽度、内角 | 新函数 `dfm/sketch_metrics.py`：对每个闭合环求最小对边距离（平行线段间距、圆直径、腰孔宽 = 两端圆弧直径）和每个凹角是否有圆弧过渡及其半径。 |
| Fillet `Radius`、Chamfer `Size` 及其边属于上面 / 下面 / 竖直边 | dressup 的边引用 + `roles.py` 的面角色（`top`/`bottom`/`side`）。分不清时不报 L 层，交给 G 层。 |
| 包围盒、体积 | 摘要里已有。 |
| `dimension` / `min_clearance` 意图 | `Requirements` 组。 |
| DFM 配置（规则包、材料） | §6.3 的 `dfm_profile` 对象。 |

### 6.2 运行

- `session._result()` 中，`intent_module.evaluate_all(ctx)` 之后调用 `dfm.lint.evaluate(ctx)`。
- 只在文档设了 DFM 配置时运行。没设时摘要中 `dfm` 为 `null`，不报任何东西（不默认套用铨洲规则）。
- 预算：整个 lint ≤ 50 ms（200 个特征的零件）。超时就停止，结果 `"truncated": true`。
- `try`（试算）同样运行。
- 可选前置检查：`add`/`set` op 中的字面数值（例如 `hole` 的 `diameter: 1.0`）在重算前用同一组 L 规则检查，只产生 `warn`，不拒绝 op。实现简单时做，否则推迟。

### 6.3 新 op：`dfm_profile`

```json
{"op": "dfm_profile", "rulepack": "quanzhou.cnc_mill", "material": "al6061"}
{"op": "dfm_profile", "rulepack": null}
```

- 保存为 `Requirements` 组旁边的一个 `App::VarSet`（名 `DfmProfile`，属性 `Rulepack`、`Material`、`Overrides` JSON）。原生类型，存进 `.FCStd`。
- 未知规则包：`DFM_RULEPACK_UNKNOWN`，`hints` 列出可用规则包。未知材料：`DFM_MATERIAL_UNKNOWN`。
- 设置材料后，`mass` 的默认密度改用规则包中的材料密度（目前默认 2.7 并警告）。
- 在 `ops/schema.py` 中登记 op；在 `skills/parametric-cad-modeling/references/freecad-part-ops.md` 中写文档。

### 6.4 摘要格式（每次 apply）

```json
"dfm": {
  "rulepack": "quanzhou.cnc_mill", "material": "al6061", "layer": "lint",
  "counts": {"error": 1, "warn": 2, "info": 3, "pass": 14},
  "issues": [
    {"rule": "hole.thread_tap_drill", "severity": "error", "target": "bracket/m3_holes",
     "measured": 2.46, "limit": 2.5, "unit": "mm",
     "message": "M3 螺纹底孔应为 φ2.5", "hints": ["set diameter 2.5"],
     "source": "铨洲 v8.14 p.1"}
  ],
  "geometry": {"state": "stale", "last_rev": 38}
}
```

- 摘要中只放 `error` 和 `warn`，最多 8 条；`info` 只计数。完整列表通过 `doc.dfm()` 拿。
- 同一规则对同一目标只报一次。
- `geometry.state`：`none`（从未运行第二层）、`fresh`（上次第二层在当前 rev）、`stale`。
- `PartResult` 增加属性 `dfm`；`__repr__` 增加一行：`DFM (quanzhou.cnc_mill, lint): 1 error, 2 warn — run doc.dfm() for geometry check`。

## 7. 第二层特征识别（WP3 + WP4）

### 7.1 `reify-asi`（WP3）

- 源码：`native/reify-asi/`（C++17，CMake）。只链接 `asiAlgo` 和 OCCT 7.6。
- 命令行：`reify-asi analyze --in part.brep --out result.json --checks holes,cavities,blends,thickness,dihedral --thickness-samples 400`。
- 输出 JSON（面 ID 为 1 起始，`TopExp::MapShapes` 顺序）：

```json
{"version": 1, "asi": "2024.2", "faces": 128,
 "holes": [{"faces": [12, 13], "diameter": 2.5, "depth": 7.5, "axis": [0,0,-1], "through": false, "bottom": "flat|cone|sphere"}],
 "cavities": [{"faces": [20, 21, 22], "base_faces": [5]}],
 "blends": [{"faces": [30], "radius": 1.0, "kind": "concave|convex"}],
 "thickness": [{"face": 7, "min": 0.8, "at": [1.0, 2.0, 3.0]}],
 "dihedral": [{"edge_faces": [3, 9], "angle_deg": 90, "convex": false, "edge_dir": [0,0,1]}],
 "timing_ms": {"load": 12, "holes": 30}}
```

- 构建和分发：
  - `scripts/bootstrap-asi.sh`：在 Linux 下拉取 Analysis Situs `v2024.2` 和 OCCT 7.6（版本固定、校验 sha256），构建 `reify-asi`，安装到 `~/.reify/runtimes/asi/<version>/`。conda-forge 有 `occt=7.6` 时优先用 micromamba 建独立环境（和 FreeCAD 环境分开）。
  - SaaS：工作区镜像中预装（加到工作区 Dockerfile；如果 SaaS 镜像还在另一个线程开发，在本 PR 中只提供脚本，并在 PR 描述中写明需要加入镜像的一行）。
  - 桌面本地模式：Windows 有官方安装包但不含我们的 CLI。v1 桌面只支持 Linux/WSL；macOS、Windows 原生没有 `reify-asi` 时第二层降级（见 7.4）。
- 每次调用一个进程。超时 = 剩余预算。进程崩溃 → 结果中该分析器 `status: "failed"`，带 stderr 末尾 2000 字符。

### 7.2 Worker 侧（WP4）：`dfm/geometry.py`

步骤：

1. 对每个 Body 的结果实体：`shape.exportBrep(tmp)`（按 E0-b 结论选格式）。
2. 运行 `reify-asi`。
3. 面 ID → FreeCAD `Face<n>` → 特征 + 角色：用 `naming.py` / `roles.py` 已有映射（`TopoShape.getElementHistory` / ElementMap）。映射不到时，目标写为 `{"body": "...", "face": 12, "centre": [...]}`。
4. 运行内置 OCCT 检查（在 worker 内，FreeCAD `Part` API）：
   - 加工方向分类：每个面按法向分为 `top`（朝 +Z 可达）、`bottom`（−Z）、`side`、`both`、`none`。用法向和沿 ±Z 的射线遮挡测试（复用 `queries._inward_length` 的射线方法）。
   - 由方向分类得出：双面特征、反面缺口占比、双面曲面、侧面高度、侧孔、外形 R 角/倒角在哪一面。
   - 最大外形截面所在 Z（`twoside.max_outline_top`）：在 Z 方向取 N 个截面（`shape.slice`），比较截面面积和外轮廓包围盒。
   - 侧孔支撑面：对每个轴线水平的孔，在孔轴反方向找一个法向平行于孔轴的平面。
   - 拼板：沿最长轴取截面，找截面面积 < 最大截面 5% 且两侧体积都 > 总体积 20% 的位置（阈值标推断）。
5. 用 Analysis Situs 结果 + 内置检查结果运行所有 `layers` 含 `geometry` 的规则。
6. 同一规则同一目标，G 层结果覆盖 L 层结果。两层结论不同（例如 L 层认为是通孔，G 层识别为盲孔）时，额外报一条 `dfm.layer_mismatch`（warn），两个值都写出。

### 7.3 新命令和 API

- worker 命令 `dfm`（`cmd_dfm(doc, args, budget_s)`，结构同 `cmd_check`），sidecar 名 `part-dfm`，在 `src/shared/freecad-worker.ts` 中登记，默认预算 30 s。
- Python API：`await doc.dfm(budget_s=None, layers=("lint", "geometry"))` → `DfmReport`：
  - `issues`（全部，含 info）、`counts`、`coverage`（每条规则：`ran` / `skipped` 及原因）、`report_path`（`<output>/dfm/rev-<n>.json`）、`image`。
  - 图片：用现有高亮和标注机制，把 error 面标红、warn 面标橙，标注规则 ID 简称。图片必附（和 apply 一致）。
- 导出：`cad.transfer.export` 和 STEP 导出结果中增加 `dfm` 字段（`geometry.state` 和 error 数）。v1 不阻止导出。

### 7.4 降级

- 没有 `reify-asi`、构建失败或超时：只跑内置 OCCT 检查。结果 `analyzer: "builtin"`，`coverage` 中依赖 Analysis Situs 的规则标 `skipped: "analysis_situs_unavailable"`。不能把未运行的规则算作通过。
- 内置检查也要能给出孔的最小集合：圆柱面 + 凹二面角 → 孔径、轴、深度。这样 Analysis Situs 不可用时 `hole.*` 的 G 层仍可用。

## 8. Agent 面（WP5）

1. `skills/design-for-manufacturing`（SaaS 计划中提到的现有技能）改写为：
   - 有制造目标时，第一批 op 中设 `dfm_profile`。
   - 每次 apply 后读 `dfm`。error 必须修，warn 要么修要么在交付说明中写理由。
   - 交付前运行 `doc.dfm()`，`geometry.state` 必须是 `fresh` 且 0 error。
   - 不要为了绕过规则加薄片、小凸台或拼板（铨洲视为违规并封号，p.3、p.11）。
2. 新参考文件 `skills/design-for-manufacturing/references/quanzhou-cnc-mill.md`：由规则包生成（`python -m reify_freecad.dfm.render_reference quanzhou.cnc_mill`），不手写，避免和 YAML 不一致。CI 检查生成结果与仓库内文件一致。
3. `parametric-cad-modeling` 技能里 FreeCAD 例子增加一个带 `dfm_profile` 的例子（M3 螺纹孔用 φ2.5 底孔）。
4. 提示 Agent 的建模习惯（写进技能）：螺纹孔用普通孔 + 底孔直径，螺纹规格写进特征名或参数（例如 `bracket/m3_tap`）；盲孔用平底；外形不倒角；内腔竖直角按深度 / 5 设圆角。

## 9. 测试（WP6）：以端到端为主

用户偏好：尽量少写单元测试，多写端到端测试。

### 9.1 端到端（主体）

- 位置：`tests/dfm/e2e/test_dfm_e2e.py`，走真实 FreeCAD worker（和现有 `tests/freecad-part/e2e/test_part_backend.py` 一样的方式），通过 `part-dfm` 和 `apply` 的完整路径。
- 夹具：`tests/fixtures/dfm/<case>/part.ops.json` + `expect.json`（期望出现的规则 ID 和级别，以及必须不出现的规则 ID）。至少以下零件：

| 夹具 | 期望 |
|---|---|
| good_plate（40×30×5，4 个 φ2.5 M3 螺纹孔深 7.5，R2 内腔深 8） | 0 error，0 warn |
| tiny_hole（φ1.0） | hole.min_diameter error（L 和 G） |
| deep_hole（φ2 深 18） | hole.depth_ratio error |
| wrong_tap（M3 用 φ2.4） | hole.thread_tap_drill error |
| countersink_through（锥面到底） | hole.countersink_to_bottom error |
| narrow_slot（宽 1.0） | cavity.min_width error |
| deep_slot（宽 2.5 深 12） | cavity.depth_tool_ratio error |
| sharp_pocket（内腔深 10，无圆角） | corner.inner_auto_radius info，measured 0，"实际 R2" |
| double_fillet（上下外形都 R1） | edge.double_side_fillet error |
| double_boss（中间法兰最大） | twoside.max_outline_top error |
| thin_wall（0.6 mm 壁） | wall.min_thickness error |
| side_hole_curved_back（侧孔对面是圆弧） | hole.side_support_face error |
| ganged（两块用 0.8×0.8 筋相连） | ganging.forbidden error |
| oversize（700×100×10） | stock.size_range error |
| import_step_part（导入的 STEP，无特征树） | 只有 G 层结果；L 层 `coverage` 标 `no_feature_tree` |

- 每个夹具同时在"有 `reify-asi`"和"降级"两种模式下跑。降级模式下期望写在 `expect.builtin.json`（允许少报，但不允许误报 error）。
- 没装 Analysis Situs 的 CI 上，有 `reify-asi` 的那一组跳过并打印原因（参考现有 FreeCAD CI 任务的写法）；在 FreeCAD CI 任务中加一个步骤运行 `scripts/bootstrap-asi.sh`（带缓存）。
- 一个 Agent 级端到端：用 `skills/cad` 的 Python API 跑 good_plate 和 wrong_tap 的 apply → 读 `PartResult.dfm` → `doc.dfm()` → 检查报告文件和图片存在。
- 性能断言：good_plate 的 lint ≤ 50 ms；`doc.dfm()` ≤ 10 s。

### 9.2 单元测试（最少）

只测两处：规则包 YAML 通过 Schema 校验；`render_reference` 输出与仓库文件一致。

## 10. 工作包与并行方式

| WP | 内容 | 依赖 | 可并行 |
|---|---|---|---|
| WP0 | E0-a/b/c 实验 | 无 | 和 WP1、WP2 并行 |
| WP1 | 规则包 Schema + 铨洲 YAML（§5 全部 ID）+ 加载器 + `render_reference` | 无 | 是 |
| WP2 | 提取代码（从 transfer.py 抽出）+ 草图度量 + L 层检查函数 + `dfm_profile` op + 摘要集成 | WP1 的 Schema | 是 |
| WP3 | `reify-asi` C++ CLI + `bootstrap-asi.sh` + CI 缓存 | WP0 E0-a | 是（和 WP2） |
| WP4 | G 层：brep 导出、面映射、内置 OCCT 检查、G 层检查函数、`part-dfm` 命令、报告与图片 | WP0、WP3 输出格式（可先用假 JSON 开发） | 部分 |
| WP5 | `doc.dfm()` API、TS 登记、技能改写、参考文件生成 | WP2、WP4 接口 | 后期 |
| WP6 | 端到端夹具和测试 | 夹具可以从第一天开始写；断言等 WP2/WP4 | 是 |

分支：基于 `claude/cad-transfer`（PR #62，含 #59）。一个 PR 交付全部 v1（用户偏好"一个可安装的完整变更"）。如果 #62 先合并，改为基于 main。

## 11. 验收场景

1. 新文档设 `dfm_profile quanzhou.cnc_mill al6061`，建 good_plate：每次 apply 的摘要有 `dfm`，0 error 0 warn。
2. 把一个孔改成 φ1.0：下一次 apply 摘要立即出现 `hole.min_diameter`，目标是那个孔的语义路径，带页码。
3. `doc.dfm()` 返回报告文件、带红色高亮的图片和完整 `coverage`。
4. M3 孔用 FreeCAD 螺纹孔（`Threaded=True`）建模：若 E0-c 显示切出孔径 ≠ 2.5，报 `hole.thread_tap_drill` 并建议用 φ2.5 普通孔。
5. 内腔深 10 无圆角：报 info "平台会加工出 R2"。
6. 上下都有外形 R 角：报 error。
7. 双面凸台：报 error，图片上标出最大截面所在高度。
8. 导入一个外部 STEP（无特征树）：L 层报 `no_feature_tree`，G 层正常给结果。
9. 删除 `reify-asi`：`doc.dfm()` 仍然返回结果，`analyzer: "builtin"`，依赖 Analysis Situs 的规则标 `skipped`，没有一条被算作通过。
10. 修改 YAML 中 `hole.min_diameter` 为 1.5：不改代码，φ1.2 孔开始报错。
11. 不设 `dfm_profile` 的文档：摘要 `dfm: null`，行为与现在完全相同（回归）。
12. Agent 按技能工作，交付前 `geometry.state = fresh` 且 0 error。

## 12. 风险与未决

| 风险 | 处理 |
|---|---|
| Analysis Situs 无头构建可能需要改 CMake 或依赖 Qt | E0-a 决定；失败走 Tcl 批处理；再失败走内置检查并通知用户。 |
| OCCT 7.6 读不了 FreeCAD 写的 `.brep` | E0-b；改用 STEP + 几何匹配。 |
| PDF 是建议，不是平台的判定代码；部分阈值是推断 | 推断规则标 `inferred`，级别最高 warn。以后用真实下单结果校准（记录被 NG 的零件和原因，作为新夹具）。 |
| PDF 内部数值不一致（孔深 5 倍 vs 8 倍；内腔宽 1.2 vs 1.25） | 按 §5 的分级和取严处理，并在规则 `source` 中写两处页码。 |
| 标准板厚列表缺失 | 用户确认没有这张表。用推断列表，规则只报 info。 |
| `EngineeringIssue` 规格（issue 04） | 本计划的 issue 格式就是第一个实例。实现后再抽象，不在本 PR 中写通用规格。 |
