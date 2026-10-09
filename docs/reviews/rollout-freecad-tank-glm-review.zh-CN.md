# Rollout 审阅：freecad-tank-glm（玩具四驱车，仅 FreeCAD）

2026-10-08。数据：用户上传的项目目录（`.prime-sessions/*.jsonl`、`parts/*.ops.jsonl`、`assembly/*.ops.jsonl`、`.pi-cad/desktop-runtime.jsonl`）。

## 概况

| 项 | 值 |
|---|---|
| 模型 | glm-5.3-flash（zai），thinking medium |
| 时间 | 第 1 轮 09:35–11:04（1.5 h）；第 2 轮 15:21–16:30（1.1 h） |
| 工具调用 | 160 次 ipython |
| Token | 共 38.0M：cacheRead 36.5M，input 1.27M，output 0.19M |
| 图像 | 623 张（每次 `apply` 7 张；一次并行 6 个文档 = 42 张） |
| 产物 | 21 个零件文档，1 个装配（34 个实例），STEP 全部导出 |
| 用户反馈 | 第 1 轮结束后："看上去还是无法真实制作和装配哦"。第 2 轮补了紧固件、轴向限位、触片、开关 |

## A. FreeCAD 后端（PR #59）的问题，按严重程度

1. **并行 `apply` 会串文档（数据错误）。** 智能体对 6 个文档用 `asyncio.gather(d.apply(...))`。结果：`motor.FCStd` 里是电池门板（52×31×1.6），`roller_screw` 名字不存在。智能体删掉全部文件重建。
   要求：worker 必须按文档隔离。不能隔离时，客户端要串行化请求，或者拒绝并发并给出错误码。不能静默写错文档。
2. **同一个圆柱面有两个相同名字。** OCC 在缝线处把圆柱侧面分成两片，两片都叫 `shaft/side.0`。后果：`link` 同一个零件两次时，面选择器报"找到 2 个"。智能体因此**放弃 `link`，整个装配改用 `import_step`**（78 次 import_step，0 次 link/joint）。装配因此没有语义面绑定。
   要求：缝线分片的面要有不同的稳定名字（如 `side.0`、`side.1`），或者合并为一个逻辑面。
3. **失败的 apply 已回滚，但智能体又调用了 `undo`，把整个零件清空（2 次）。** 原因：整个零件在一次 apply（rev 1）里建好；失败的 apply 自动回滚后，`undo` 回到 rev 0（空文档）。
   要求：错误信息直接写"已回滚，文档在 rev N，不要 undo"；`undo` 到 rev 0 时需要明确参数。
4. **不能删除中间特征。** `delete axle/groove_top` 报"is used by 1 other object(s)"。被引用的是后续特征的 BaseFeature 链。FreeCAD 的 `Body.removeObject()` 会自动重新连接链。
   要求：`delete` 对 PartDesign 特征用 `Body.removeObject`；只有真正被别的特征引用（草图、阵列）时才报错，并列出引用者。
5. **Pocket 方向错时静默无效（至少 4 次）。** 草图在实体底面，pocket 朝外切，体积不变，没有警告。智能体每次都靠体积对比才发现。
   要求：pocket/hole 去除体积为 0 时报 `FEATURE_NO_EFFECT`（带提示"试 reversed=true"）。pad 不增加体积时同理。
6. **超时和性能。** `apply` 30 s/60 s 超时 6 次；`open` 30 s 超时 5 次（齿轮、底盘文档）；`tree` 超时 2 次；底盘在圆角超时后变慢，需要回退。`import_step` 装配一次 57.9 s。
   要求：查明 `open` 为什么超过 30 s（可能是打开时重算 + 7 张图 + STEP 导出）；`open` 不应该重算已保存的文档；超时后 worker 状态要恢复。
7. **装配干涉检查误报多。** 第一次 22/561 对重叠，其中约 16 对是网格相切（0.05–0.2 mm 间隙处），智能体逐对手动分类。
   要求：干涉用 B-Rep `common` 体积 + 公差，不用网格；或者把"接触（体积 < 阈值）"和"干涉"分开报告。
8. **小问题。**
   - `floor` 是保留角色名，不能作为特征路径结尾。错误清楚，但这个名字很常见；建议改名为 `body/floor_pan` 之类的提示。
   - 面选择器歧义（轮胎倒角内外两条边）：错误信息好；但 `between side/top` 对环形零件天然有两条边，选择器需要支持 `which: "outer"`/半径。
   - 六角柱上倒角失败（`BRep_API: command not done`），圆角/倒角失败只给 OCC 原文，没有提示。

## B. 工作流 / 技能问题

- 工作流迁移试错：`plan.concept_ready`、`plan.concept` 都是非法迁移；obligation 名字必须精确（`mechanism-definition`）。智能体用了 3 次调用才找到。
- verify 阶段 `model.build` 不可用、release 后 `review.submit` 和 `workspace.commit` 不可用。错误信息没说下一步做什么。
- probe 沙箱不允许写导出目录（STL 导出失败）。
- **最重要的质量问题：** 第 1 轮通过了全部检查，但用户认为不能真实制造和装配（电机只用绑带、轴承无轴向限位、轮子会滑出、无电池触片/开关、导轮无螺母）。检查只看几何干涉，不看"每个零件是否有约束、每个紧固件是否建模"。
  建议：`assembly-design` 技能加一条可装配性检查表（每个零件 6 自由度如何约束；每个运动副的轴向限位；电气通路；紧固件建模）。verify 阶段要求逐零件回答。

## C. 对 `cad.transfer` 的意义

本次 21 个零件使用的 op：

| op | 次数 |
|---|---|
| sketch（XY 90，XZ 14；51 个带 offset） | 104 |
| pad（全部 `length`；有 midplane、reversed） | 59 |
| pocket（全部 `length`；有 reversed） | 41 |
| set（全部 `Reversed`） | 10 |
| hole（全部 `through_all`） | 4 |
| polar_pattern（轴 Z） | 2 |
| fillet / chamfer | 1 / 1 |
| param（只有 density）/ require | 26 / 1 |

草图形状只有 rect 39、circle 93、polyline 16，没有圆弧。**所有 992 个数值都是常数，没有一个表达式。**

按 issue 的阶段：

| 阶段 | 能导出的零件 | 数量 |
|---|---|---|
| P0 | axle_shaft、axle_shaft_r、battery_aa、battery_door、bearing、body_shell、chassis、contact_front、contact_rear、motor、motor_clamp_a、motor_clamp_b、roller_screw、screw_m2x8、switch_block、tire | 16 / 21 |
| P1 | + pinion_gear、spur_gear（polar_pattern + 贯穿孔）、roller_nut（贯穿孔） | 19 / 21 |
| P3 | + roller（fillet）、wheel_hub（chamfer） | 21 / 21 |

结论：
1. P0 范围正确，覆盖 3/4 的零件。P0 必须包含 `midplane`、`reversed` 和 XZ 平面 + offset（本次都用到了）。
2. 圆角/倒角只有 2 处，但没有它们这两个零件就导不出。建议把"简单的边圆角/倒角（`between` 两个角色）"从 P3 提前到 P2。
3. 级别 2 参数（表达式）在实际 rollout 里没有用到，保持在 P3。
4. 装配全是 `import_step` + 位置，没有 link/joint。P2 的"装配只传零件位置"正好匹配。但如果 A.2 修好后智能体改用 `link`，P2 也要支持 `link`。
5. `set Reversed` 已经被重算后的文档吸收，确认了"从 FreeCAD 文档导出，不重放 ops.jsonl"的决定是对的。
