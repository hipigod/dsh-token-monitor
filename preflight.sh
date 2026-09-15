#!/usr/bin/env bash
# preflight.sh — 改完这个插件后的唯一放行闸门。
#
# 为什么必须有它：2026-09-15 的事故里，三份单元测试全绿，但 client.js 的注册 id 与包名
# 不一致，导致 **整个 DSH Web 应用不挂载**（页面只剩 "Failed to load plugins"），
# 连带把正在对话的 agent 一起打断。单元测试查不出这种问题——只有真 boot 一次才知道。
#
# 用法：
#   bash /root/apps/dsh-plugin-token-monitor/preflight.sh
#
# 退出码 0 = 可以认为"好了"；非 0 = 别宣布完成。

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAILED=0
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    ✅ %s\n' "$*"; }
warn() { printf '    ⚠️  %s\n' "$*"; }
bad() { printf '    ❌ %s\n' "$*"; FAILED=1; }

say "1/4 客户端契约：注册 id 必须等于包名"
if node "$DIR/tests/client.test.mjs" | tail -1 | grep -q '0 失败'; then
  ok "client 契约通过（含 id == package.name 断言）"
else
  bad "client 契约失败 —— 立刻停下，这版会拖垮整个应用"
  node "$DIR/tests/client.test.mjs" | grep -A3 FAIL | head -20
fi

say "1.5/4 关键代码块是否真的写进文件（防「patch 没落地」）"
# 事故：小窗口的花费/余额/峰谷带 patch 因为锚点不匹配从未写进文件，
# 而脚本仍打印成功 —— 表现是界面上永远不出现新功能，排查极久。
# 这里对渲染树里的关键标识做静态核对：只有样式没有调用，就是漏写。
MISSING=""
mark() { if ! grep -q "$1" "$DIR/client.js"; then MISSING="$MISSING $2"; fi; }
mark "className: 'tm-money'" "小窗口花费/余额行"
mark "jsx.jsx(PeakBand" "峰谷时段带渲染"
mark "jsx.jsxs('span', {" "余额项结构"
mark "'shell.overlay'" "浮层槽位注册"
mark "className: 'tm-float'" "浮窗外壳"
mark "'最小化'" "最小化按钮"
mark "onMouseDown: onHeadMouseDown" "拖动处理器"
mark '@local/dsh-token-monitor' "注册 id"
if [ -z "$MISSING" ]; then
  ok "关键代码块齐备"
else
  bad "client.js 缺少关键代码块:$MISSING"
fi

say "2/4 宿主与渲染：逻辑 + 元素树"
for f in host render; do
  if node "$DIR/tests/$f.test.mjs" | tail -1 | grep -q '0 失败'; then
    ok "$f 通过"
  else
    bad "$f 失败"
    node "$DIR/tests/$f.test.mjs" | grep -A3 FAIL | head -20
  fi
done

# 自动探测本机的 dsh 环境（发布给别人用，不能假设路径与运行状态）
DSH_CHECKOUT="${DSH_CHECKOUT:-/opt/deepseek-harness}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-web}"
LOG="${DSH_LOG:-/var/log/dsh-web.log}"
SKIPPED_LIVE=0

say "3/4 宿主是否已加载本插件"
if [ ! -d "$DSH_CHECKOUT" ] || [ ! -d "$DSH_HOME_DIR/profiles/$PROFILE" ]; then
  SKIPPED_LIVE=1
  warn "未检测到 dsh 环境（$DSH_CHECKOUT / profiles/$PROFILE），跳过"
else
  DUMP="$(cd "$DSH_CHECKOUT" && DSH_HOME="$DSH_HOME_DIR" timeout 120 pnpm dsh --profile "$PROFILE" --dump-config 2>&1 || true)"
  if printf '%s' "$DUMP" | grep -q "@local/dsh-token-monitor"; then
    ok "profile 里已挂载"
  else
    bad "profile 里没有本插件（先跑 dsh plugin --profile $PROFILE add .）"
  fi
  if printf '%s' "$DUMP" | grep -qiE "cannot find|failed to load"; then
    bad "dump-config 里出现加载错误"
  fi
fi

say "4/4 真浏览器 boot 审计（唯一能发现『整个应用挂不挂载』的一层)"
TOKEN="$(grep -oE 'token=[A-Za-z0-9_-]+' "$LOG" 2>/dev/null | tail -1 || true)"
if [ "$SKIPPED_LIVE" = "1" ]; then
  warn "本机没有可审计的 dsh web，跳过 boot 审计（发布/CI 场景下的正常结果）"
elif [ -z "$TOKEN" ]; then
  bad "取不到 web token，无法做 boot 审计（去 $LOG 里确认 dsh web 是否正常启动）"
elif ! command -v node >/dev/null; then
  bad "没有 node"
else
  OUT="$(node "$DIR/tests/e2e-browser.mjs" "$TOKEN" 2>&1)"
  if printf '%s' "$OUT" | tail -1 | grep -q '0 失败'; then
    ok "$(printf '%s' "$OUT" | tail -1)"
  else
    bad "boot 审计失败"
    printf '%s\n' "$OUT" | grep -B1 -A3 FAIL | head -30
  fi
fi

say "结论"
if [ "$FAILED" = "0" ]; then
  cat <<'EOF'
    ✅ 检查全过（客户端契约 / 关键代码块 / 宿主逻辑 / 元素树 / 真浏览器 boot）。
       ⚠ 注意：跳过 boot 审计时，只证明"代码与单元测试没问题"，
         不能证明"装到真机上界面会正常" —— 那一层必须在有 dsh web 的机器上跑。
       客户端改动刷新页面即可；宿主改动需要重启（务必用 systemd-run 定时重启，
       不要直接 systemctl restart —— agent 自己是这个服务的子进程，会被一起杀掉）。
EOF
  exit 0
fi
cat <<'EOF'
    ❌ 有检查失败 —— 【不要】宣布完成，也【不要】重启服务。
       若失败在 boot 审计：说明这版会让整个 GUI 起不来。先回滚到上一个能用的提交：
         git -C <插件目录> checkout HEAD -- client.js index.js
         然后重启 dsh web（务必用定时重启，别在自己这一轮对话里直接 restart）。
EOF
exit 1
