# 开机自动启动 WSL 和 k3s

目的：Windows 重启后，WSL 和 k3s 自动恢复。平台控制器按期望状态恢复工作区。

## 前提

- WSL 已开启 systemd（`/etc/wsl.conf` 里有 `[boot] systemd=true`）。
- k3s 已安装，服务 `k3s` 为开机启用（`install-k3s.sh` 会完成这一步）。
- `.wslconfig` 中 `vmIdleTimeout=-1`。没有这一项，WSL 会在空闲后关机。

## 第一步：确认 k3s 会随 WSL 启动

在 WSL 里运行：

```bash
systemctl is-enabled k3s
```

应输出 `enabled`。

## 第二步：创建 Windows 计划任务

在 Windows 上打开"任务计划程序"，选择"创建任务"（不是"创建基本任务"）。

| 页签 | 设置 |
|---|---|
| 常规 | 名称：`Reify WSL 自启动`。选择"不管用户是否登录都要运行"。勾选"使用最高权限运行"。 |
| 触发器 | 新建 → 开始任务："启动时"。可选：延迟 30 秒，等网络就绪。 |
| 操作 | 新建 → 程序或脚本：`wsl.exe`。参数：`-d Ubuntu -u root -- true` |
| 条件 | 取消勾选"只有在计算机使用交流电源时才启动"（台式机通常无需改，笔记本要改）。 |
| 设置 | 取消勾选"如果任务运行时间超过 3 天，则停止"。`wsl.exe` 启动后会很快返回，但 WSL 虚拟机会继续运行。 |

`-d Ubuntu` 必须与 `wsl -l -v` 显示的发行版名称一致。

命令行写法（管理员 PowerShell，示例）：

```powershell
$action  = New-ScheduledTaskAction -Execute "wsl.exe" -Argument "-d Ubuntu -u root -- true"
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = "PT30S"
Register-ScheduledTask -TaskName "Reify WSL 自启动" -Action $action -Trigger $trigger `
  -User "<Windows 用户名>" -Password "<密码>" -RunLevel Highest
```

## 第三步：验证

1. 重启 Windows。
2. 等待 3 分钟。
3. 在 Windows 上运行：

   ```powershell
   wsl -d Ubuntu -u root -- systemctl is-active k3s
   wsl -d Ubuntu -u root -- k3s kubectl get nodes
   ```

4. 确认 `k3s` 为 `active`，节点为 `Ready`。
5. 确认 `qwen-server.service` 也已启动（它不由本文件管理，它的自启动单独设置）。

## 注意

- 这个任务只启动 WSL。它不会重启 vLLM。
- Windows 更新会重启机器。这是已知风险（计划第 14 节）。内测说明里要写清楚。
- 运行 `wsl --shutdown` 会停止所有 WSL 服务，包括 vLLM 和 k3s。只在维护窗口执行。
- 如果任务在用户未登录时无法运行，WSL 可能不会启动。这一点要在验证步骤中确认（见 `cloud/deploy/README.md` 的未决问题）。
