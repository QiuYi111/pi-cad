# Reify 部署说明（compute）

本文说明在 compute 上部署阶段 1 的顺序。
compute 是 Windows 10 台式机。Linux 运行在 WSL2 Ubuntu 24.04 里。
K8s 用 k3s，装在 WSL 里。

所有命令都在 WSL 的仓库目录里运行，除非另有说明。

## 0. 开始前

确认下面几项已完成：

- Tailscale 已登录。管理台已开启 HTTPS 证书和 Funnel（Y1）。
- 你同意修改 `.wslconfig`，并重启 WSL（Y3）。这会停止 vLLM。
- mihomo 已开启"允许局域网连接"，且没有代理用户名和密码（Y4）。
- 你已确认 FreeCAD 脚本在本次构建的分支里（见第 14 节，未决问题 1）。

## 1. 调整 WSL 配置

1. 把 `cloud/deploy/wsl/wslconfig.example` 复制到 `%UserProfile%\.wslconfig`。
2. 选一个没人使用模型的时间。
3. 在 Windows 运行 `wsl --shutdown`。
4. 重新打开 Ubuntu。
5. 运行 `systemctl is-active qwen-server`。应输出 `active`。

## 2. 安装 k3s

```bash
sudo bash cloud/deploy/wsl/install-k3s.sh
```

脚本可以重复运行。它不会停止 vLLM。
端口 18020 必须仍归 vLLM 所有。脚本会检查这一点。

## 3. 设置开机自启

按 `cloud/deploy/wsl/reify-autostart.md` 创建 Windows 计划任务。

## 4. 构建并导入工作区镜像

```bash
PRIME_AGENT_REF=<prime-agent 的标签或提交> cloud/image/build.sh --import
```

记下输出的镜像标签，例如 `reify-workspace:<提交号>`。

## 5. 运行 0.5 验证

```bash
export VERIFY_IMAGE=reify-workspace:<提交号>
export VERIFY_PROXY=http://<Windows 主机 IP>:7890
bash cloud/deploy/wsl/verify-runtime.sh
```

脚本会写出 `cloud/deploy/wsl/VERIFY.md`。
按结果选择 seccomp 和 hostUsers：

- 模式 A 成功：`SECCOMP_TYPE=RuntimeDefault`，`HOST_USERS=true`。
- 只有模式 B 成功：`SECCOMP_TYPE=Unconfined`，`HOST_USERS=true`。
- 只有模式 C 成功：`SECCOMP_TYPE=RuntimeDefault`，`HOST_USERS=false`。

三种模式都失败：停止部署。把结果报告给负责人。

要跑一次完整的 `mechanical.one-shot`：

1. 在一个测试 Pod 里设置自己的 API key。脚本不读取密钥。
2. 设置 `VERIFY_ONESHOT_CMD` 为要运行的命令。
3. 再运行一次脚本。

完成后，把 `VERIFY.md` 补充完整，并提交到仓库。

## 6. 密钥（一次性）

密钥文件放在仓库外。不要提交。

1. 生成 ES256 密钥对：

   ```bash
   openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out jwt-private.pem
   openssl ec -in jwt-private.pem -pubout -out jwt-public.pem
   ```

2. 生成数据库密码：

   ```bash
   openssl rand -hex 16
   ```

3. 复制 `cloud/deploy/k3s/secret.template.yaml` 到仓库外，例如 `/root/reify-secrets.yaml`。
4. 把占位值替换为真实值。`JWT_PRIVATE_KEY` 填入 `jwt-private.pem` 的内容。
5. 应用该文件：`sudo k3s kubectl apply -f /root/reify-secrets.yaml`。
6. 删除 `/root/reify-secrets.yaml`。
7. 把 `jwt-private.pem` 放到备份盘或密码管理器。然后从工作目录删除。
8. 创建公钥 ConfigMap（工作区网关使用它）：

   ```bash
   sudo k3s kubectl -n reify-ws create configmap reify-gateway-pubkey \
     --from-file=gateway-public-key.pem=jwt-public.pem --dry-run=client -o yaml \
     | sudo k3s kubectl apply -f -
   ```

   这一步要在 `reify-ws` 命名空间存在后执行，即第 7 步之后。

## 7. 应用 K8s 清单

1. 替换以下占位值：
   - `cloud/deploy/k3s/platform-api.yaml` 里的 `WORKSPACE_IMAGE`、`HTTPS_PROXY_FOR_WORKSPACES`、镜像标签。
   - `cloud/deploy/k3s/reify-ws-policy.yaml` 里的代理 CIDR（`203.0.113.10/32`）。

   这些值会被提交到仓库。若不希望这样，请使用 kustomize overlay。
2. 应用：

   ```bash
   sudo k3s kubectl apply -k cloud/deploy/k3s
   ```

3. 检查：

   ```bash
   sudo k3s kubectl -n reify-system get pods
   sudo k3s kubectl -n reify-ws get resourcequota,networkpolicy
   ```

4. 确认 `postgres-0` 为 Running 和 Ready。

平台 API 镜像还没有。`platform-api` 会一直处于 ImagePullBackOff，直到镜像导入。

## 8. 公开入口（Funnel）

1. 确认 Caddy 在本机监听：

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18443/internal/x
   ```

   应输出 `404`。
2. 在 Windows 上运行 `cloud/deploy/wsl/funnel.sh`（或按它打印的命令执行）。
3. 用手机流量（不连 Tailscale，不连本地网络）访问：
   - `https://<机器名>.<tailnet>.ts.net/v1/healthz` 应返回 200。
   - `https://<机器名>.<tailnet>.ts.net/internal/x` 应返回 404。

## 9. 备份

1. 在 WSL 中创建 restic 密码文件：

   ```bash
   sudo install -d -m 700 /etc/reify
   sudo sh -c 'umask 077; openssl rand -base64 32 > /etc/reify/restic-password'
   ```

   把这个密码另存到备份盘之外的地方。丢失后无法恢复备份。
2. 安装 restic 和 cron：`sudo apt-get install -y restic cron`。
3. 复制 `cloud/deploy/backup/reify-backup.cron.example` 到 `/etc/cron.d/reify-backup`。修改路径。
4. 手动运行一次：`sudo bash cloud/deploy/backup/backup.sh`。
5. 确认 `/mnt/d/reify-backup/pg/` 下有一个 `.sql.gz` 文件。

## 10. 恢复演练（验收 V12）

用一个测试用户。不要用真实用户。

1. 在桌面应用里打开该用户的项目和会话。记下项目名。
2. 干跑恢复，只看输出：

   ```bash
   sudo bash cloud/deploy/backup/restore.sh --user-id <用户 UUID>
   ```

3. 停止并删除该用户的工作区。把数据库里的状态设为 stopped。

   ```bash
   sudo k3s kubectl -n reify-ws delete deployment ws-<id> --ignore-not-found
   sudo k3s kubectl -n reify-ws delete pvc ws-<id>-data
   ```

   删除 PVC 会删除卷上的文件。这一步是演练的一部分。

4. 删除该用户的数据库行。按下面顺序执行（在 `psql` 中，连接 `reify` 数据库）：

   ```sql
   delete from events where user_id = '<用户 UUID>';
   delete from refresh_tokens where user_id = '<用户 UUID>';
   delete from password_resets where user_id = '<用户 UUID>';
   delete from sessions where project_id in (select id from projects where team_id in (select id from teams where personal_owner = '<用户 UUID>'));
   delete from project_members where user_id = '<用户 UUID>';
   delete from projects where team_id in (select id from teams where personal_owner = '<用户 UUID>');
   delete from workspaces where user_id = '<用户 UUID>';
   delete from team_members where user_id = '<用户 UUID>';
   delete from teams where personal_owner = '<用户 UUID>';
   delete from external_identities where user_id = '<用户 UUID>';
   delete from password_credentials where user_id = '<用户 UUID>';
   delete from users where id = '<用户 UUID>';
   ```

5. 正式恢复：

   ```bash
   sudo REIFY_WORKSPACE_IMAGE=reify-workspace:<提交号> \
     bash cloud/deploy/backup/restore.sh --user-id <用户 UUID> --apply
   ```

6. 在桌面应用里重新打开项目和会话。确认文件和会话都在。

脚本不会自动删除任何数据。它在数据还存在时会停止。

## 11. 安全检查

- 从工作区 Pod 中运行 `ls /workspace`，只能看到自己的目录。
- 从工作区 Pod 中连接 `postgres.reify-system.svc.cluster.local:5432` 应失败。
- 从工作区 Pod 中访问 `https://kubernetes.default.svc` 应失败。
- 外部访问 `/internal/*` 应返回 404。

这些检查对应验收 V3 和 V13。

## 12. 监控（最小）

- `k3s kubectl top nodes` 和 `top pods`（需要 metrics-server，k3s 自带）。
- 磁盘：`df -h /` 查看 WSL 根盘。剩余少于 100 GB 时处理。
- 备份日志：`tail /var/log/reify-backup.log`。

## 13. 文件清单

| 路径 | 内容 |
|---|---|
| `cloud/image/Dockerfile` | 工作区镜像 |
| `cloud/image/entrypoint.sh` | 工作区入口脚本 |
| `cloud/image/build.sh` | 构建并导入镜像 |
| `cloud/deploy/k3s/` | K8s 清单（`kubectl apply -k`） |
| `cloud/deploy/k3s/workspace-template.yaml` | 每个用户的工作区模板（由控制器渲染） |
| `cloud/deploy/k3s/secret.template.yaml` | 密钥模板（不含真实值） |
| `cloud/deploy/wsl/` | WSL 配置、k3s 安装、验证、Funnel、自启动 |
| `cloud/deploy/backup/` | 备份、恢复、cron 示例 |

## 14. 未决问题

1. **FreeCAD 脚本不在本分支。** `scripts/bootstrap-freecad.sh` 和 `python/runtimes/freecad/` 的锁文件只存在于 `claude/cad-transfer` 的提交（aff9c89、ee5254b）中。镜像构建需要它们。请先把这些提交合并或 cherry-pick 到构建分支。脚本支持 `PI_CAD_FREECAD_HOME`，镜像用它把安装位置指向 `/opt/reify/freecad`。
2. **`cloud/workspace-gateway` 还不存在。** 镜像假定它有 `package.json`、锁文件和 `start` 脚本。
3. **版本号需要核对。** 构建前确认：Node 22.20.0、uv 0.9.7、`caddy:2.10-alpine`、`postgres:16.4-bookworm`。
4. **seccomp 和 hostUsers 由 0.5 验证决定。** 工作区命名空间只设 `warn` 和 `audit` 为 restricted。是否改为 `enforce`，待定。`Unconfined` 不符合 restricted。
5. **占位值。** 代理 IP、镜像标签、平台 API 镜像、公钥和密钥都是占位。部署前必须替换。
6. **local-path 目录。** `install-k3s.sh` 用 k3s 启动参数 `--default-local-storage-path` 把目录设为 `/var/lib/reify/volumes`。这个参数需要在所用的 k3s 版本上确认。
7. **Windows 计划任务。** 需要验证：用户未登录时，计划任务能否启动 WSL。
8. **NetworkPolicy 行为。** k3s 默认的网络策略控制器需要验证两点：Service 的出站规则是否按后端 Pod 匹配；kubelet 的探针是否被放行。验证脚本只测试了代理和 bwrap，没有测这两点。请在 V3 中补测。
9. **镜像不含 simulation 和 Blender。** 镜像用 `PI_CAD_BASE_RUNTIME=1` 构建。阶段 1 不做这两项。
10. **脚本未在真实集群上运行。** `backup.sh`、`restore.sh`、`install-k3s.sh` 只做了语法检查。请在 compute 上先做干跑。
11. **机器外备份。** 阶段 1 末尾再做。
12. **平台 API 镜像和 SQL 迁移。** 不在本次范围内。
