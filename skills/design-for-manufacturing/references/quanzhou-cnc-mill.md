# 铨洲智造 CNC 智能制造打样（铣削） (quanzhou.cnc_mill) 规则参考

Source: 铨洲智造 `quanzhou-cnc-design-guide-v8.14.pdf`, version 8.14, dated 2026-08-14.

Process: `cnc_mill` — 3-axis, top and bottom setups

## Materials

| Material | Density (g/cm³) | Size limited |
|---|---|---|
| `al6061` (default) | 2.7 | no |
| `al7075` | 2.81 | yes |
| `steel_45` | 7.85 | yes |

## Tables

### tap_drill_mm

| Key | Value |
|---|---|
| `M2` | 1.6 |
| `M2.5` | 2.05 |
| `M3` | 2.5 |
| `M4` | 3.3 |
| `M5` | 4.2 |
| `M6` | 5.0 |
| `M8` | 6.8 |
| `M10` | 8.5 |
| `M12` | 10.2 |
| `UNC1/4-20` | 5.105 |
| `UNC3/8-16` | 7.937 |

### tool_diameters_mm

| Value |
|---|
| 1 |
| 1.5 |
| 2 |
| 3 |
| 4 |
| 6 |
| 8 |
| 10 |
| 12 |

### standard_thickness_mm

| Value |
|---|
| 1 |
| 1.5 |
| 2 |
| 2.5 |
| 3 |
| 4 |
| 5 |
| 6 |
| 8 |
| 10 |
| 12 |
| 15 |
| 16 |
| 20 |
| 25 |
| 30 |

### gb1804_m

| Key | Value |
|---|---|
| `0.5-3` | 0.1 |
| `>3-6` | 0.1 |
| `>6-30` | 0.2 |
| `>30-120` | 0.3 |
| `>120-400` | 0.5 |
| `>400-1000` | 0.8 |
| `>1000-2000` | 1.2 |

## Rules

### stock

| ID | Layers | Severity | Rule (quote) | Limits | Page | Inferred |
|---|---|---|---|---|---|---|
| `stock.size_range` | L | error | 包围盒最小 10×10×1，最大 650×440×30 mm | min_mm=[10, 10, 1]<br>max_mm=[650, 440, 30]<br>compare=sorted | 1 |  |
| `stock.size_limited_material` | L | info | 材料是 7075 或 45# 钢时：尺寸范围以平台为准 | — | 1 |  |
| `stock.thickness_range` | L | error | Z 向厚度 1–30 mm | min_mm=1<br>max_mm=30 | 1 |  |
| `stock.side_height` | G | error | 侧面高度 > 200 mm 时，侧面只能有圆孔 | max_mm=200 | 1 |  |
| `stock.standard_thickness` | L+G | info | Z 厚度不是常见标准板厚时报 info | standard_mm=[1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 16, 20, 25, 30] | 2 | yes |
| `stock.thin_plate_large` | L+G | warn | Z 厚度 < 10 mm 且为大尺寸薄板时，必须是标准厚度 | thin_mm=10<br>very_thin_mm=4<br>large_longest_mm=200 | 7 | yes |
| `stock.removal_ratio` | L | warn | 去除率过高会有应力变形 | max_ratio=0.8 | 7 | yes |
| `stock.surface_treatment` | L | info | 7075、45# 钢建议选表面处理 | materials=[al7075, steel_45] | 11 |  |

### tol

| ID | Layers | Severity | Rule (quote) | Limits | Page | Inferred |
|---|---|---|---|---|---|---|
| `tol.general` | L | info | 默认精度 GB/T 1804-m | standard=GB/T 1804-m | 1 |  |
| `tol.precision_hole` | L | info | 精孔实际精度 0–0.02 | actual_min_mm=0<br>actual_max_mm=0.02<br>compensation_min_mm=0.02<br>compensation_max_mm=0.03<br>trigger_below_mm=0.03 | 8 |  |

### hole

| ID | Layers | Severity | Rule (quote) | Limits | Page | Inferred |
|---|---|---|---|---|---|---|
| `hole.min_diameter` | L+G | error | 孔 Φ1.2mm 以上 | min_mm=1.2 | 1 |  |
| `hole.depth_ratio` | L+G | error | 孔深 / 孔径：≤ 3 无问题 | info_ratio=3<br>warn_ratio=5<br>error_ratio=8 | 1, 8 |  |
| `hole.thread_tap_drill` | L+G | error | 螺纹孔底孔直径必须等于底孔表 | tolerance_mm=0.05 | 1 |  |
| `hole.thread_modeled` | L | warn | 平台按底孔识别，真实螺纹几何会破坏识别 | — | 1 | yes |
| `hole.thread_length` | L | error | 螺纹有效长度 ≤ 5 × 公称直径 | max_ratio=5 | 1 |  |
| `hole.thread_min_depth` | L | warn | ≥ M3 时 ≥ 0.6 × D；< M3 时 ≥ 0.8 × D | min_ratio_from_m3=0.6<br>min_ratio_below_m3=0.8<br>m3_mm=3<br>lock_length_min_ratio=1<br>lock_length_max_ratio=2 | 1 |  |
| `hole.thread_blind_extra` | L | warn | 盲孔底孔深度应 ≥ 螺纹深度 + 1 × D | extra_ratio=1 | 1 | yes |
| `hole.thread_side_wall` | G | error | 螺纹孔到外壁的余量 ≥ 1 mm | min_margin_mm=1 | 1 |  |
| `hole.blind_bottom_wall` | G | warn | 盲孔孔底到对面的壁厚 ≥ 孔径 / 2 | min_ratio=0.5<br>min_mm=1 | 8 |  |
| `hole.bottom_shape` | L+G | error | 球形 / 圆弧底不支持 | cone_severity=info | 5, 8 |  |
| `hole.internal_chamfer` | G | warn | 孔内倒角（台阶孔中间的倒角）不支持 | — | 5 |  |
| `hole.ring_groove` | G | warn | 孔内环槽、T 槽不支持 | — | 5 |  |
| `hole.countersink` | L+G | warn | 沉头孔（锥形）可能 NG 或加工不完全 | recommended=counterbore | 6 |  |
| `hole.countersink_to_bottom` | L+G | error | 沉头锥面不能画到底，底部必须留圆柱底孔 | — | 6 |  |
| `hole.side_support_face` | G | error | 与孔轴垂直的对面必须有平面作为加工支撑面 | — | 4 |  |
| `hole.waist_slot_depth` | L+G | warn | 腰孔深度 ≤ 3 × 宽度 | max_depth_ratio=3<br>relaxed_aspect_ratio=2<br>relaxed_severity=info | 10 |  |

### cavity

| ID | Layers | Severity | Rule (quote) | Limits | Page | Inferred |
|---|---|---|---|---|---|---|
| `cavity.min_width` | L+G | error | 内腔 / 内槽宽度 ≥ 1.25 mm | min_mm=1.25<br>p1_table_mm=1.2<br>engraving_gap_min_mm=1.25 | 1, 8 |  |
| `cavity.depth_tool_ratio` | L+G | error | 槽深 ≤ 5 × 刀具直径 | max_ratio=5 | 8 |  |

### corner

| ID | Layers | Severity | Rule (quote) | Limits | Page | Inferred |
|---|---|---|---|---|---|---|
| `corner.inner_auto_radius` | L+G | warn | 内竖直角半径 < 深度 / 5 时：平台会自动加工出 R = 深度 / 5 的圆角 | radius_ratio=5<br>info_severity=info<br>mated_severity=warn | 9 |  |
| `corner.relief_size` | G | warn | 避空半径必须 > 刀具半径，不能相等 | recommended_diameters_mm=[1.2, 1.7, 2.2, 3.2, 4.2] | 9 |  |

### floor

| ID | Layers | Severity | Rule (quote) | Limits | Page | Inferred |
|---|---|---|---|---|---|---|
| `floor.chamfer` | L+G | warn | 底部（腔底与侧壁之间）倒 C 角不建议 | — | 10 |  |
| `floor.fillet_radius` | L+G | warn | 底部 R 角需要 > R2 | min_mm=2<br>exclusive=True | 10 |  |

### outer

| ID | Layers | Severity | Rule (quote) | Limits | Page | Inferred |
|---|---|---|---|---|---|---|
| `outer.concave_narrow` | G | error | 外形内凹区域宽度小于最小刀具时，无法生成刀路 | min_tool_mm=1 | 5 |  |

### wall

| ID | Layers | Severity | Rule (quote) | Limits | Page | Inferred |
|---|---|---|---|---|---|---|
| `wall.min_thickness` | G | error | 薄壁 / 薄片 ≥ 1 mm | min_mm=1 | 3 |  |
| `wall.slender_suspended` | G | warn | 内部悬空细长结构：建议留 ≥ 0.5 mm 底面或加筋 | min_floor_mm=0.5 | 7 |  |

### edge

| ID | Layers | Severity | Rule (quote) | Limits | Page | Inferred |
|---|---|---|---|---|---|---|
| `edge.default_chamfer` | L | info | 未倒角或 < C0.5 的锐边：平台默认 C0.1–0.5 | min_mm=0.5<br>default_min_mm=0.1<br>default_max_mm=0.5 | 1 |  |
| `edge.double_side_chamfer` | L+G | warn | 上下两面外形都有 > C0.5 倒角时可能 NG | side_min_mm=0.5<br>standard_double_side_max_mm=1 | 1, 2 |  |
| `edge.double_side_fillet` | L+G | error | 锐边 R 角只支持单面 | — | 2 |  |

### twoside

| ID | Layers | Severity | Rule (quote) | Limits | Page | Inferred |
|---|---|---|---|---|---|---|
| `twoside.back_notch_ratio` | G | warn | 反面缺口尺寸不能超过该面外形尺寸的 30% | max_ratio=0.3 | 2 |  |
| `twoside.nonstandard_back` | G | warn | 非标准厚度时，反面只能有圆形沉头孔台阶 | — | 2 |  |
| `twoside.max_outline_top` | G | error | 至少一面的最大外形必须在零件 Z 最高处 | — | 3 |  |

### surface

| ID | Layers | Severity | Rule (quote) | Limits | Page | Inferred |
|---|---|---|---|---|---|---|
| `surface.double_side_curved` | G | error | 曲面只允许在一个方向（上或下）出现 | ball_min_diameter_mm=4 | 10 |  |
| `surface.multi_face` | G | info | 多面特征（侧面特征）会有接刀痕 | — | 4 |  |

### ganging

| ID | Layers | Severity | Rule (quote) | Limits | Page | Inferred |
|---|---|---|---|---|---|---|
| `ganging.forbidden` | G | error | 禁止拼板：多个零件用细小连接筋连成一体 | — | 3, 5, 11 |  |
