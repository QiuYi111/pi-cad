# CAD Viewer 选型

更新时间：2026-08-31

## 结论

主视口建议采用 [`three-cad-viewer`](https://github.com/bernhard-42/three-cad-viewer)，不要继续维护自制坐标轴、方向控件、相机状态和模型树。

STEP 继续在 Pi-CAD/sidecar 中用 OpenCascade 系工具读取和离散化，再把带层级、名称、颜色、三角面和边线的数据传给 Viewer。第一版不要把 STEP 解析搬进 Electron 渲染进程。

建议分两层：

1. `three-cad-viewer` 管显示、相机、标准视图、坐标、选择和树。
2. Pi-CAD 自己补很薄的测量与剖切层；后续若确实需要浏览器内 B-Rep，再单独评估 OpenCascade.js。

CADAM 只作为视觉参考。That Open Engine 和 xeokit 都更偏 BIM/IFC，不适合作为当前 STEP-first 机械 CAD 的底座。

## 需求

当前最容易做错的不是材质，而是视口语义：

- 世界坐标、屏幕坐标和模型坐标必须一致。
- 右上角方向控件必须与相机 `up`、正视/俯视/侧视严格对应。
- resize、DPI、最大化和面板拖动后，画布与控件必须同步。
- 选择要能回到零件、实体、面和边。
- 需要适配模型树、隐藏、聚焦、剖切、测量和装配。

这些不该靠几块 DOM 和手写旋转矩阵拼出来。

## 对比

| 方案 | 许可证 | STEP | 标准视图/坐标 | 选择/树 | 剖切/测量 | 活跃度 | Electron/React 代价 | 判断 |
|---|---|---|---|---|---|---|---|---|
| three-cad-viewer | MIT | 不直接读 STEP；接收离散后的 Three.js 几何 | 内建视图与 `up: "Z"` 配置 | 内建层级 Shapes、显示状态和零件树 | 未见成熟的原生测量/剖切 | 仓库持续维护，专为 CAD 显示 | 低；ESM 组件嵌入现有 React 容器 | **首选** |
| CADAM | GPL-3.0 | OpenSCAD WASM，主要产出网格，不是 STEP/B-Rep Viewer | React Three Fiber 自建 | 当前设计树仍在需求/演进中 | 没有可直接复用的完整机械 CAD 检查层 | 很活跃，约 5k stars | 中高；只能摘设计，直接复用会受 GPL 约束 | 只参考视觉 |
| That Open Engine | MIT（核心组件） | 官方重点是 IFC/Fragments，不直接支持 STEP | 有相机、网格等底层组件；不是现成机械 CAD ViewCube | 有射线选择和 BIM 数据组件 | 有 Clipper、长度/面积/体积测量 | 很活跃，2026 年仍频繁更新 | 中；组件多，需要自行组装 UI，STEP 仍需转换 | 不选，方向偏 BIM |
| xeokit v2 | AGPL-3.0 或商业许可 | 不直接支持 STEP；常见入口是 XKT、IFC、glTF | NavCube、AxisGizmo、标准相机控制成熟 | TreeView、选择、隐藏、X-ray 成熟 | SectionPlanes 和距离/角度测量成熟 | 成熟且频繁发布 | 中；功能最全，但需格式转换与许可证评估 | 功能备选，不宜默认集成 |
| xeokit v3 | AGPL-3.0 | 多格式，但仍不以 STEP 为主 | 新架构包含 Viewer/View | 新工具栈 | 测量已有模块 | 仍明确标为 alpha | 高，API 仍可能变化 | 暂不采用 |
| OpenCascade.js | LGPL-2.1 | **原生 STEP/B-Rep 能力** | 无现成产品级视口控件 | 需要自行做拾取、树和 UI | 几何计算可做，但 UI 全要自建 | 最新正式 release 较早 | 很高；WASM 体积、初始化、worker、打包都有成本 | 只作为解析内核候选 |

## 各方案说明

### three-cad-viewer

这是最贴近现状的方案。官方把它定义为基于 Three.js 的 CAD Viewer，输入是已离散的顶点、三角面、法线和边；多个 Shape 可以组成层级树。它已有 CAD 显示需要的状态模型，支持每个节点的实体/边线显示状态，并允许明确设置 Z-up。

优点：

- MIT，可直接用于桌面产品。
- 输入与 Pi-CAD 当前的“后端读 STEP、前端显示网格”边界一致。
- 不需要在 renderer 内启动 OpenCascade WASM。
- 模型树、零件显示、边线和相机约定由一个组件统一维护。
- 可保留 Pi-CAD 自己的视觉样式，不必照搬完整界面。

限制：

- 它不是 STEP Loader。
- 官方资料没有证明它提供完整的尺寸标注和剖切工作流。
- 需要做一层 React 生命周期封装，并检查容器 resize 与高 DPI。

### CADAM

[CADAM 官方仓库](https://github.com/Adam-CAD/CADAM)使用 React 19、React Three Fiber 和 OpenSCAD WASM，整体采用 GPL-3.0。它是完整应用，不是独立 Viewer 包。

直接搬它的问题：

- GPL-3.0 会影响集成后的分发方式。
- 它的几何核心是 OpenSCAD/网格，不保留 STEP 的装配与 B-Rep 语义。
- 现有视口同样基于 Three.js/R3F 自行组装，不能从根上消除坐标、方向控件、DPI 和选择同步的坑。
- 官方 issue 中“参数化设计树 Viewer”仍是开放需求，说明它不是现成的完整装配树方案。

可以借鉴：全屏模型优先、轻量浮动控件、空状态和生成过程的视觉层级。不要复制代码。

### That Open Engine

[核心仓库](https://github.com/ThatOpen/engine_components)为 MIT，且维护活跃。官方已有 Raycaster、Clipper、Fragments 和长度/面积等测量组件；剖切示例证明它能从点击面创建和管理剖切平面。

问题是产品方向主要是 BIM/IFC。它能解决通用 Three.js 工具问题，却不能直接解决 STEP 读取、机械零件层级和 B-Rep 选择。集成后仍要自己搭 ViewCube、机械模型树和 STEP 转换，收益小于 three-cad-viewer。

### xeokit

[xeokit v2](https://github.com/xeokit/xeokit-sdk)的 Viewer 功能最完整：官方示例明确列有 NavCube、AxisGizmo、TreeView、ContextMenu、SectionPlanes 和测量。它适合大模型、BIM 和工程审阅。

主要阻碍：

- AGPL-3.0；闭源分发需要商业许可。
- 官方 Loader 重点是 XKT、IFC、glTF、OBJ 等，不含直接 STEP。
- 为当前单件/小装配机械 CAD 引入 BIM 数据链过重。

如果以后产品明确开源为 AGPL，或购买商业许可，并且目标扩展到大型 BIM/工厂模型，xeokit 才值得重新考虑。

[xeokit v3](https://github.com/xeokit/sdk)仍标为 alpha，暂不用于发布版。

### OpenCascade.js

[OpenCascade.js](https://github.com/donalffons/opencascade.js)是 OpenCascade 的 WebAssembly 移植，许可证 LGPL-2.1，确实能在浏览器侧处理 STEP 和 B-Rep。

但它是几何内核，不是 Viewer 产品。坐标轴、ViewCube、相机控制、树、选择外观、测量 UI、剖切交互都仍要自己做。若只是为了修正现有右上角控件，引入它不会解决问题，反而增加 WASM 打包和线程管理成本。

## 推荐落地

### 第一阶段：替换视口，不动几何链

- sidecar 从 STEP 提取层级、名称、颜色、变换、三角面、法线和可见边。
- 定义稳定的 `CadSceneDocument`，版本化传给 renderer。
- 用 `three-cad-viewer` 替换当前自制 canvas、坐标轴和右上角相机控件。
- 统一 Z-up；用基准模型验证 Front/Back/Left/Right/Top/Bottom。
- ResizeObserver 驱动画布尺寸，使用真实 `devicePixelRatio`。

### 第二阶段：补工程检查

- 测量通过后端 OpenCascade/Build123d 查询精确点、边、面，不以三角网格估算为权威结果。
- 前端只负责拾取和画标注。
- 剖切可先用 Three.js clipping plane；剖面面积等精确结果仍由后端计算。
- 模型树节点保存稳定 ArtifactRef/shape id，避免只靠数组下标。

### 第三阶段：再决定是否需要浏览器 B-Rep

只有出现离线即时 STEP 导入、浏览器内布尔运算或完全无 sidecar Viewer 的明确需求时，才引入 OpenCascade.js。

## 验收基准

替换后至少自动验证：

1. Z-up 模型六个标准视图方向正确。
2. ViewCube 点击后的相机方向与坐标标记一致。
3. 100%、125%、150%、200% DPI 下控件不漂移、不模糊。
4. 800×600、1280×720、1920×1080 和最大化下无裁切。
5. 拖动左右面板时 Viewer 实时 resize，不拉伸模型。
6. 选择零件后，树与视口双向同步。
7. 多零件 STEP 保留名称、颜色、层级和变换。
8. 隐藏、隔离、聚焦、正交/透视切换可恢复。
9. 测量结果与后端精确值一致，不把网格近似冒充尺寸。
10. WebGL context 丢失后给出可恢复错误，不显示空白画布。

## 官方来源

- [three-cad-viewer 官方仓库](https://github.com/bernhard-42/three-cad-viewer)
- [CADAM 官方仓库](https://github.com/Adam-CAD/CADAM)
- [That Open Engine 官方组织与仓库](https://github.com/ThatOpen)
- [That Open Clipper 官方示例](https://github.com/ThatOpen/engine_components/blob/main/packages/core/src/core/Clipper/example.ts)
- [xeokit v2 官方仓库](https://github.com/xeokit/xeokit-sdk)
- [xeokit 官方示例目录](https://xeokit.github.io/xeokit-sdk/examples/index.html)
- [xeokit v3 官方仓库](https://github.com/xeokit/sdk)
- [OpenCascade.js 官方仓库](https://github.com/donalffons/opencascade.js/)
- [OpenCascade 官方许可证说明](https://dev.opencascade.org/doc/overview/html/index.html)
