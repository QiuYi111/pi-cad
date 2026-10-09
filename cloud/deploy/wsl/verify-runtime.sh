#!/usr/bin/env bash
# Plan 0.5: check the runtime conditions on compute before any product code depends on them.
#
# Checks, in order:
#   1. bwrap works inside a test pod. Tries three modes and stops at the first that works:
#        A  seccomp RuntimeDefault, hostUsers default
#        B  seccomp Unconfined,     hostUsers default
#        C  seccomp RuntimeDefault, hostUsers false
#   2. The chosen pod reaches api.openai.com and chatgpt.com through the proxy.
#      Any HTTP status counts as reachable. A timeout (000) does not.
#   3. Optional: run one workflow inside the pod (VERIFY_ONESHOT_CMD), with timing and peak usage.
#
# Writes a results table to stdout and to VERIFY.md (or VERIFY_OUT).
#
# Required:
#   VERIFY_IMAGE   workspace image already imported into k3s (cloud/image/build.sh --import)
#   VERIFY_PROXY   proxy URL as seen from pods, for example http://<windows-host-ip>:7890
# Optional:
#   VERIFY_NS            namespace for test pods (default reify-ws, so the NetworkPolicy applies)
#   VERIFY_ONESHOT_CMD   shell command for the one-shot test, run as user 1000 in the pod.
#                        Put API keys in the pod environment yourself. The script never reads keys.
#   VERIFY_OUT           results file (default: VERIFY.md next to this script)
#   KUBECTL_BIN          kubectl command (default: "k3s kubectl")
#
# Test pods carry the label reify.dev/verify=true and are deleted on exit.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NS="${VERIFY_NS:-reify-ws}"
IMAGE="${VERIFY_IMAGE:?set VERIFY_IMAGE to the imported workspace image tag}"
PROXY="${VERIFY_PROXY:?set VERIFY_PROXY to the proxy URL seen from pods}"
ONESHOT_CMD="${VERIFY_ONESHOT_CMD:-}"
OUT="${VERIFY_OUT:-$SCRIPT_DIR/VERIFY.md}"
KUBECTL_BIN="${KUBECTL_BIN:-k3s kubectl}"
RUN_ID="$(date +%H%M%S)"
STARTED="$(date '+%Y-%m-%d %H:%M:%S %z')"

# shellcheck disable=SC2086
kc() { $KUBECTL_BIN -n "$NS" "$@"; }

cleanup() {
  kc delete pod -l reify.dev/verify=true --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

# make_pod NAME SECCOMP HOSTUSERS(omit|false)
make_pod() {
  local name="$1" seccomp="$2" hostusers="$3" hu_line=""
  if [ "$hostusers" = "false" ]; then
    hu_line="  hostUsers: false"
  fi
  cat <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: ${name}
  namespace: ${NS}
  labels:
    reify.dev/role: workspace
    reify.dev/verify: "true"
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
${hu_line}
  securityContext:
    runAsUser: 1000
    runAsGroup: 1000
    runAsNonRoot: true
    seccompProfile:
      type: ${seccomp}
  containers:
    - name: probe
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["sleep", "3600"]
      env:
        - name: HTTPS_PROXY
          value: "${PROXY}"
        - name: HTTP_PROXY
          value: "${PROXY}"
        - name: NO_PROXY
          value: "localhost,127.0.0.1,.svc,.cluster.local"
        - name: HOME
          value: /workspace/home
      resources:
        requests:
          cpu: "1"
          memory: 2Gi
        limits:
          cpu: "2"
          memory: 4Gi
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
EOF
}

# start_pod NAME SECCOMP HOSTUSERS -> prints seconds from apply to Ready; returns 1 if not Ready
start_pod() {
  make_pod "$1" "$2" "$3" | kc apply -f - >/dev/null || return 1
  local t0 t1
  t0="$(date +%s)"
  kc wait --for=condition=Ready "pod/$1" --timeout=600s >/dev/null 2>&1 || return 1
  t1="$(date +%s)"
  echo $((t1 - t0))
}

bwrap_ok() {
  kc exec "$1" -- bwrap --unshare-all --ro-bind / / --proc /proc --dev /dev true >/dev/null 2>&1
}

# probe_url POD URL -> "CODE SECONDS" or "000 -"
probe_url() {
  local out
  out="$(kc exec "$1" -- curl -sS -o /dev/null -m 20 -w '%{http_code} %{time_total}' "$2" 2>/dev/null)" || out="000 -"
  [ -n "$out" ] || out="000 -"
  echo "$out"
}

# pull_note POD -> text from the Pulled event, or a note that the image was already present
pull_note() {
  local msg
  msg="$(kc get events --field-selector "involvedObject.name=$1,reason=Pulled" \
    -o jsonpath='{.items[*].message}' 2>/dev/null || true)"
  if [ -n "$msg" ]; then
    printf '%s' "$msg" | head -c 160
  else
    printf 'no pull event (image already present)'
  fi
}

# peak_usage FILE -> "PEAK_CPU_MILLICORES PEAK_MEMORY_MI" from kubectl top lines
peak_usage() {
  awk '
    function mem(v) {
      if (v ~ /Gi$/) { sub(/Gi$/, "", v); return v * 1024 }
      if (v ~ /Mi$/) { sub(/Mi$/, "", v); return v + 0 }
      if (v ~ /Ki$/) { sub(/Ki$/, "", v); return v / 1024 }
      return 0
    }
    function cpu(v) {
      if (v ~ /m$/) { sub(/m$/, "", v); return v + 0 }
      return (v + 0) * 1000
    }
    NF >= 3 { c = cpu($2); m = mem($3); if (c > pc) pc = c; if (m > pm) pm = m; n++ }
    END { if (n == 0) print "n/a n/a"; else printf "%d %d\n", pc, pm }
  ' "$1"
}

ROWS=()     # "mode|seccomp|hostUsers|ready|bwrap|pull"
WORKING=""
WORKING_MODE=""
WORKING_SECCOMP=""
WORKING_HOSTUSERS=""

echo "[verify] namespace=$NS image=$IMAGE proxy=$PROXY run=$RUN_ID"

MODES=("A RuntimeDefault omit" "B Unconfined omit" "C RuntimeDefault false")
for spec in "${MODES[@]}"; do
  read -r mode seccomp hostusers <<<"$spec"
  name="reify-verify-${mode,,}-${RUN_ID}"
  echo "[verify] mode $mode: seccomp=$seccomp hostUsers=$hostusers"

  if ! ready_s="$(start_pod "$name" "$seccomp" "$hostusers")"; then
    echo "[verify]   pod did not become Ready"
    ROWS+=("$mode|$seccomp|$hostusers|not ready|not run|-")
    kc delete pod "$name" --ignore-not-found --wait=false >/dev/null 2>&1 || true
    continue
  fi
  pull="$(pull_note "$name")"

  if bwrap_ok "$name"; then
    echo "[verify]   bwrap ok (ready in ${ready_s}s)"
    ROWS+=("$mode|$seccomp|$hostusers|${ready_s}s|yes|$pull")
    WORKING="$name"
    WORKING_MODE="$mode"
    WORKING_SECCOMP="$seccomp"
    WORKING_HOSTUSERS="$hostusers"
    break
  fi
  echo "[verify]   bwrap failed"
  ROWS+=("$mode|$seccomp|$hostusers|${ready_s}s|no|$pull")
  kc delete pod "$name" --ignore-not-found --wait=false >/dev/null 2>&1 || true
done

PROXY_ROWS=()
ONESHOT_NOTE="not run (set VERIFY_ONESHOT_CMD to run it)"
PEAK="n/a n/a"
WALL="-"

if [ -n "$WORKING" ]; then
  echo "[verify] proxy checks from $WORKING"
  for url in "https://api.openai.com/v1/models" "https://chatgpt.com/"; do
    res="$(probe_url "$WORKING" "$url")"
    PROXY_ROWS+=("$url|$res")
    echo "[verify]   $url -> $res"
  done

  if [ -n "$ONESHOT_CMD" ]; then
    echo "[verify] one-shot run in $WORKING"
    sampler_out="$(mktemp)"
    ( while true; do kc top pod "$WORKING" --no-headers >>"$sampler_out" 2>/dev/null; sleep 5; done ) &
    sampler=$!
    t0="$(date +%s)"
    if kc exec "$WORKING" -- bash -lc "$ONESHOT_CMD"; then
      ONESHOT_NOTE="exit 0"
    else
      ONESHOT_NOTE="exit $? (see the pod output above)"
    fi
    t1="$(date +%s)"
    kill "$sampler" 2>/dev/null || true
    wait "$sampler" 2>/dev/null || true
    WALL="$((t1 - t0))s"
    PEAK="$(peak_usage "$sampler_out")"
    rm -f "$sampler_out"
  fi
else
  echo "[verify] no mode passed the bwrap check. Proxy and one-shot tests skipped."
fi

# Human-readable output
{
  echo "# 0.5 运行条件验证结果"
  echo
  echo "- 开始时间：$STARTED"
  echo "- 命名空间：$NS"
  echo "- 镜像：$IMAGE"
  echo "- 代理（Pod 内地址）：$PROXY"
  echo "- 主机内核：$(uname -r)"
  echo "- 运行脚本的人：$(whoami)"
  echo
  echo "## 1. bwrap（沙箱）"
  echo
  echo "| 模式 | seccomp | hostUsers | 就绪耗时 | bwrap | 镜像拉取 |"
  echo "|---|---|---|---|---|---|"
  for row in "${ROWS[@]}"; do
    IFS='|' read -r m s h r b p <<<"$row"
    echo "| $m | $s | $h | $r | $b | $p |"
  done
  echo
  echo "选定模式：${WORKING_MODE:-无（全部失败）}"
  echo
  echo "## 2. 代理可达性（选定模式的 Pod 内测试）"
  echo
  echo "| 地址 | HTTP 码 | 耗时（秒） |"
  echo "|---|---|---|"
  if [ "${#PROXY_ROWS[@]}" -eq 0 ]; then
    echo "| - | 未测 | - |"
  else
    for row in "${PROXY_ROWS[@]}"; do
      IFS='|' read -r u c t <<<"$row"
      echo "| $u | $c | $t |"
    done
  fi
  echo
  echo "判定：HTTP 码为 3 位数字即视为可达。000 表示超时或连接失败。"
  echo
  echo "## 3. mechanical.one-shot（简单零件）"
  echo
  echo "- 运行结果：$ONESHOT_NOTE"
  echo "- 墙钟时间：$WALL"
  echo "- 峰值 CPU（毫核）/ 内存（Mi）：$PEAK（kubectl top，需要 metrics-server）"
  echo "- 产出检查（7 张图和 STEP）：_待人工填写_"
  echo "- 使用的模型连接方式：_待填写_"
  echo
  echo "## 4. 结论"
  echo
  echo "- seccomp（写入 workspace-template.yaml 的 SECCOMP_TYPE）：${WORKING_SECCOMP:-_待定_}"
  echo "- hostUsers（写入 HOST_USERS）：${WORKING_HOSTUSERS:-_待定_}"
  echo "- 验收 0.5 是否通过：_待填写_"
} >"$OUT"

echo
echo "Results written to $OUT"
echo
if [ -n "$WORKING" ]; then
  echo "bwrap mode: $WORKING_MODE (seccomp=$WORKING_SECCOMP, hostUsers=$WORKING_HOSTUSERS)"
else
  echo "bwrap mode: none passed"
  exit 1
fi
