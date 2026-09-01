# Pi-CAD

**从设计意图，到可检查的机械模型。**

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/QiuYi111/pi-cad/actions/workflows/ci.yml/badge.svg)](https://github.com/QiuYi111/pi-cad/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Pi-CAD 是一款基于 [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent)
的桌面机械设计 Agent。描述一个零件、装配体、修改或分析任务，它可以澄清需求、探索
概念、编写确定性 CAD、构建 STEP、检查结果，并让源码、模型、测量和审查始终对应。

使用 OpenAI Codex OAuth 登录 ChatGPT，不需要 API Key。

## 核心思想

模型适合搜索设计空间，工程工作还需要可靠、可延续的事实。

Pi-CAD 为模型提供持久的 Python 工作台。需求、产物、计算和观察结果可以在长任务中
持续使用。简短的工作流卡片只展示当前目标、可用操作、必须交付的内容和合法下一步。
模型仍可自由推理和写代码；运行时负责判断什么才是有效的构建、测量、审查和发布。

- **可编程工具。** Prime 在持久 IPython 中组合 CAD、检查、仿真和图片生成。
- **默认提供视觉反馈。** 构建会向 Agent 和用户返回有用视图。
- **产物拥有身份。** 源码、STEP、图片和证据保留用途与版本；重建会使旧证据失效。
- **工作流负责闭环。** 缺少义务和非法状态转换是真正执行的规则，而不是提醒。
- **过程可检查。** 桌面端展示模型活动、STEP 几何、工作流状态、轨迹和蒸馏进度。

## 示例

### 设计新零件

> 设计一块 100 × 80 × 5 mm 的安装板，四角各有一个 5 mm 孔。孔边距至少 8 mm，
> 增加适合打印的圆角，并导出 STEP。

Pi-CAD 会把需求变成确定性源码和几何，返回视觉反馈，测量真实模型，并将最终文件留在
项目目录。

### 设计装配体

> 设计一个紧凑的可折叠手机支架，支持横屏和竖屏。转轴、限位和间隙应适合 FDM 打印。

Agent 可以探索概念、定义接口、构建零件、检查装配体，并修改真实候选模型。

### 修改或分析已有模型

> 把安装孔从 4.2 mm 增大到 5.0 mm，但不要改变外部包络。验证结果。

> 检查这个 STEP，报告精确包围盒和实体数量。不要修改它。

修改和分析使用不同工作流。测量始终绑定到真正接受检查的模型版本。

## Windows 安装

从最新 Release 下载 **`Pi-CAD-Setup-x64.exe`**，双击打开。

首次设置与主工作台使用同一套界面。它会：

1. 检查 WSL 2 和 Ubuntu；
2. 缺失时提供 Windows 官方 WSL 安装；
3. 安装包内置的 Prime 和 Pi-CAD 运行环境；
4. 登录 ChatGPT；
5. 选择项目目录。

只有 Windows 需要启用 WSL 时才申请管理员权限。Windows 可能要求重启一次。Pi-CAD
会保留已安装文件，重启后继续设置。

要求：

- Windows 10 2004 或更新版本，或 Windows 11；
- 固件中已启用虚拟化；
- 缺少 WSL 时，有权限启用它；
- ChatGPT 登录和模型调用需要网络。

安装包包含匹配的 Prime Agent 和 Pi-CAD 运行环境。正常安装不会克隆仓库。

## Linux 安装

下载 `Pi-CAD-Linux-x86_64.AppImage` 或对应的 `.deb`。Linux 直接运行 Agent，
不经过 WSL。首次启动前，用系统包管理器安装 Bubblewrap。应用内置 Prime、Pi-CAD
和 Node，再通过 `uv` 准备 Python 环境。

## macOS 安装

下载 `Pi-CAD-macOS-arm64.dmg`，把 Pi-CAD 拖入 Applications。Apple Silicon
版本直接在 macOS 运行 Prime 和 Pi-CAD，作者和 Reviewer 进程使用系统
`sandbox-exec` 隔离。公开版本需要 Developer ID 签名和公证；未签名 CI 产物只供测试。

## 第一个任务

打开 Pi-CAD，选择目录、登录，然后在工作台输入需求。Provider、模型、推理等级、
Reviewer 和目录权限都可在设置中修改。

桌面端包含流式 Agent 状态、工作流状态条和编辑器、交互式 STEP 查看器、工具消息卡、
项目切换、轨迹查看和经验蒸馏。

## 命令行

开发者也可以直接在 Linux、macOS 或 WSL 2 中运行：

```bash
sudo apt-get update
sudo apt-get install -y bubblewrap libglu1-mesa ripgrep

git clone https://github.com/QiuYi111/prime-agent.git
git clone https://github.com/QiuYi111/pi-cad.git

cd prime-agent && npm ci
cd ../pi-cad
npm install
npm run setup:python
PRIME_AGENT_REPO="$PWD/../prime-agent" npm run prime:setup
```

主要工作流：

| 工作流 | 用途 |
| --- | --- |
| `mechanical.one-shot` | 新零件或装配体，直到发布 |
| `mechanical.modify` | 修改已有设计 |
| `mechanical.analysis` | 只读几何分析 |

## 当前范围

Pi-CAD 当前支持 Windows + WSL 2 和 Ubuntu，提供 STEP-first build123d 建模、B-Rep
检查、受管理的视觉反馈、工作流包、隔离审查、概念图生成和工程计算方案。

它不能替代物理测试、制造审查或专业工程签字。

## 许可证

[MIT](LICENSE)。Codex 图片生成兼容包在
[`packages/prime-codex-image-gen`](packages/prime-codex-image-gen) 中保留上游署名。
