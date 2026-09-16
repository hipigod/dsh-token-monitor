# dsh-token-monitor · 模型 Token 用量监测

DSH（DeepSeek Harness）Web 插件。在**左侧边栏底部、设置按钮正上方**放一个小窗口，显示当前模型的**当日 token 总量**和**每小时直方图**（输入命中缓存 / 输入未命中缓存 / 输出），右侧一个【日志】按钮打开完整的用量报告弹窗。

数据**全部来自本机会话日志**（`$DSH_HOME/sessions/**/session.v3.jsonl.zstd`），不额外埋点、不改动 DSH 源码、不依赖任何第三方包。

---

## 一、装上之后长什么样

### 浮窗（侧边栏会话列表下方、页脚上方）

挂载点是 `shell.overlay`（ui-layout 声明的全框浮层，可叠加、默认点击穿透）。

```
┌─────────────────────────────┐
│ deepseek-flash   日志   —   │  ← 头部可拖动；右上角【日志】【最小化】
│ 2亿 今日总量 · 1.3k 次请求   │
│ ¥14.35 今日花费 ¥35.42 余额  │
│ ▓▓░░▓▓▓░░░░▓▓▓░░░░░░░░░░░░  │  ← 峰谷时段带（深=高峰 / 浅=空闲）
│ ▁▃█▅▂ ▁▁▁▁ ▁▁▁▁ ▁▁▁▁▁▁▁▁▁▁  │  ← 24 小时堆叠直方图
│ 00:00     12:00      23:00  │
│ ● 输入（命中缓存） ● 未命中 ● 输出 │
└─────────────────────────────┘
[ ⚙ Cordis Plugin  ...        ]
[ ⚙ Settings                  ]
```

- **右上角【—】最小化** → 收成一个小胶囊（总量 + 花费），点胶囊还原；状态记在 localStorage
- **拖动头部**可移动位置，**双击头部**回到默认锚点；位置也记在 localStorage
- 位置不是写死的：实时量侧边栏与页脚容器的矩形（`ResizeObserver` + `resize`），
  所以侧栏宽度变化、收起成窄栏、页脚条目增减都会自动跟随

> 为什么不用 `sidebar.footer.action`：那个槽位只能表达"页脚内的一行"，
> 而需求是「工作区 → 会话列表 → **本插件** → 页脚」的次序，落在列表与页脚之间——
> 只有浮层能做到，且不会被其它插件（如 Cordis Plugin 区）挤占。

### 小窗口（旧形态，已改为浮窗）

```
┌────────────────────────────────────────┐
│ deepseek-official/deepseek-flash  日志 │   ← 模型名 + 【日志】按钮
│ 1.1亿  今日总量 · 858 次请求            │   ← 当日总量
│ ▁▃█▅▂▁▁▁ ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁            │   ← 24 小时堆叠直方图
│ 00:00        12:00        23:00        │
│ ● 输入（命中缓存） 1.1亿                  │   ← 图例（跟随悬浮小时）
│ ● 输入（未命中缓存） 908k                 │
│ ● 输出 605k                             │
│ 悬停柱子看该小时明细                      │
└────────────────────────────────────────┘
[ ⚙ 设置 ]                                  ← 本插件在它上方
```

- 鼠标悬停任意柱子 → 图例与提示行切换成**那一小时**的明细。
- 每 30 秒自动刷新一次，窗口重新聚焦时立刻补一次。

### 日志弹窗（点【日志】）

- **区间**：今日 / 近一周 / 近一月 / 自定义（起止日期选择器，按上海日界，最多 400 天）
- **视图**：按对话 / 按模型（可翻页）
- **总量卡片**：总用量、输入（命中缓存）、输入（未命中缓存）、输出
- **时间分布**：区间 ≤2 天按小时、更长按天，堆叠柱图 + 悬浮读数
- **模型分布**：每个模型的用量占比条（同样按三桶堆叠）
- **明细表**：按对话（标题 / 工作区 / 最后活动时间 / 涉及模型）或按模型
- **健康度**：缓存命中率、活跃小时、活跃小时均值、日均、峰值小时、最费对话、覆盖会话数
- **页脚**：写明统计口径与采样时刻；若有个别日志读取异常，在这里如实列出（不静默吞掉）

---

## 二、统计口径（重要，决定你看到的数字是什么意思）

每一条用量都来自会话日志里 `assistant/message` 事件的 `data.usage`，即 **provider 自己回报的用量**：

| 界面上的桶 | 日志字段 | 说明 |
|---|---|---|
| 输入（命中缓存） | `cacheReadTokens` | 命中 prefix cache 的输入 |
| 输入（未命中缓存） | `inputTokens` + `cacheWriteTokens` | DeepSeek 侧 `inputTokens` 不含缓存读取；`cacheWriteTokens` 恒为 0，存在时并入此桶 |
| 输出 | `outputTokens` | **已包含 reasoning tokens**，不重复计算 |

- **模型归属**：按事件顺序取「最近一次 `request/context`」作为该次请求生效的路由（`provider/model`）。DSH 只在路由/上下文变化时才追加 `request/context`，所以用游标取最近值是正确的归因方式；连 `request/context` 都没有的极端情况会记为 `unknown` 而不是丢弃。
- **时区**：固定 **Asia/Shanghai（UTC+8）**，日界 = 本地 00:00。近一周 = 含今日共 7 天，近一月 = 含今日共 30 天。
- **会话标题**：优先取 DSH 投影缓存（`storages/session_projcache`）里的标题（即侧边栏显示的那个），取不到则退回日志里的 `session/title`，再退回首条用户消息（截断 80 字）。
- **不含费用估算**：按你的要求，只报 token，不做任何价格折算。

---

## 三、安装 / 卸载

```bash
# 从 GitHub 直接装（推荐）
cd /opt/deepseek-harness && DSH_HOME=~/.dsh pnpm dsh plugin --profile web add github:hipigod/dsh-token-monitor

# 或者先克隆到本地再以本地路径装（改代码即时生效，不用重装）
git clone https://github.com/hipigod/dsh-token-monitor.git /root/apps/dsh-plugin-token-monitor
cd /opt/deepseek-harness && DSH_HOME=~/.dsh pnpm dsh plugin --profile web add /root/apps/dsh-plugin-token-monitor

# 生效（宿主路由与客户端 bundle 都需要重启进程）
systemd-run --on-active=2 --unit="dsh-restart-$(date +%s)" systemctl restart dsh-web.service
# 然后用浏览器刷新 http://127.0.0.1:3080
```

> ⚠️ **不要在当前会话里直接 `systemctl restart dsh-web.service`**：agent 自己是这个服务的子进程，直接重启会把当前对话打断（已实测踩过两次）。用上面的 `systemd-run --on-active` 定时重启，命令会先返回，再由 systemd 去重启。

```bash
# 卸载
cd /opt/deepseek-harness && DSH_HOME=/root/.dsh pnpm dsh plugin --profile web remove @local/dsh-token-monitor
```

### 回滚

```bash
# 好版本快照（每次 preflight 通过后建议复制一份）
ls -t /root/archive/dsh-token-monitor-backups/
cp -a /root/archive/dsh-token-monitor-backups/client.js.good-<时间> /root/apps/dsh-plugin-token-monitor/client.js
# 或整体回滚 profile
cp -a /root/.dsh/archive/profile-web-backup-20260915-163321/. /root/.dsh/profiles/web/
systemd-run --on-active=2 --unit="dsh-rollback-$(date +%s)" systemctl restart dsh-web.service
```

改完源码后：**宿主侧改动**（`index.js`）要重启；**客户端改动**（`client.js`）只需在浏览器刷新页面（reg 里的 bundle 是实时从磁盘读的，实测 `curl` 已能取到新内容）。宿主侧 `client-hmr` 还会 stat-poll 每个 bundle，内容一变就推 `rebuilt` 帧把插件热换掉（实测改完 `client.js` 约 1 秒后浏览器里的浮窗会重挂一次）。

---

## 四、自检（不用看界面就能判断好坏）

插件自带一个诊断端点：

```bash
curl -s http://127.0.0.1:3080/plugin-api/token-monitor/doctor | jq
```

它会如实报告三件事：

1. `host.sessionsRoot` —— 宿主实际读的日志目录；
2. `client.available` / `client.rows` —— **浏览器模块表**里登记了哪些插件（这是「界面上会不会出现」的唯一权威依据，宿主路由 200 不代表客户端会被加载）；
3. `client.ours` —— 本插件那一行，含 bundle 绝对路径；`null` 就说明 `dsh.client` 声明或 `./client` 导出有问题。

另外两个只读路由：

```
GET /plugin-api/token-monitor/overview            今日总览（小窗口数据）
GET /plugin-api/token-monitor/log?period=…&view=… 日志报告
    period = today | week | month | custom | all
    start / end = YYYY-MM-DD（period=custom 时生效）
    view = total | conversation
```

口径一致性是硬约束：`totals`、`models` 求和、`buckets` 求和、`conversations` 求和在任一次响应里**必须相等**（三者都来自同一批已过滤记录）。对不上就是 bug。

---

## 五、已修缺陷（都是真浏览器/真数据抓到的，不是"看起来对"）

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | **整个 Web 应用不挂载**：页面只剩 `Failed to load plugins`，侧栏/会话全没了；正在对话的 agent 也被连带打断（2026-09-15 16:33–17:06 的真实事故） | `client.js` 里 `__ModuleLoader__.load({ id })` 写的是 `dsh-token-monitor`，而模块表行 id 是包名 `@local/dsh-token-monitor`。client-modules 的 `arrive()` 以行 id 为键等待 bundle 自注册，不匹配即抛 `bundle … loaded without registering "<id>" via __ModuleLoader__.load` | 两处统一为包名；加回归断言（`tests/client.test.mjs`）+ **真浏览器 boot 审计**（`tests/e2e-browser.mjs`）+ 放行闸门 `preflight.sh` |
| 2 | 弹窗内容被裁成 380px 宽、右侧全部看不见 | ui-primitives 的 Modal 卡片写死 `width: min(380px, 100%)` + `overflow: hidden`。只改内层 `contentClassName` 无效——外层卡片才是裁剪者 | 改用 `headless: true` 自绘标题栏，并通过 Modal 的 `className`（唯一透传到卡片的入口）覆盖宽度 |
| 3 | 侧栏模型名压到【日志】按钮上（文字重叠） | flex 子项默认不收缩到可用宽度，只写 `text-overflow: ellipsis` 不会生效 | 给标题显式 `max-width: 96px` + `min-width: 0`；模型名只显示末段，完整 `provider/model` 放进 `title` |
| 4 | 内层盒子比卡片宽 40px（贴边/图例被裁） | 内层宽度算式与卡片内边距不匹配 | 内层改 `box-sizing: border-box` + `width: 100%`，图例 `flex-wrap` + 右对齐 |
| 5 | 用户截图里弹窗**下边内容被裁**（`记录deepseek…` 那行看不见） | 高度按 `84vh` 算，而笔记本 + 浏览器工具栏后可用高度只有 ~550px，内容超出卡片被 `overflow: hidden` 吃掉 | 改成 flex 链：卡片 `max-height: calc(100vh - 48px)`，内层 `flex: 1 1 auto` + `min-height: 0` + `overflow-y: auto`，滚动交给内层 |
| 6b | 弹窗顶部「花费」卡显示 **¥0.0 / 未启用计价**，而同一弹窗的模型分布显示 **¥13.09**（自相矛盾） | 宿主 `logPayload` 的返回对象漏了顶层 `cost`/`currency` 两个字段（模型分布读的是 `models[].cost`，所以显示正常） | 客户端加兜底：顶层缺 `cost` 时用 `totals.cost` 重建、币种从余额推断；宿主侧也补上字段（下次重启生效） |
| 7 | 浮窗**完全拖不动**（位置永远不变） | React 的 `onPointerDown` 在无头 Chromium 下不触发；另外我以为 jsdom 支持 pointer 事件 | 改用 mouse 事件（`onMouseDown` + window 上的 move/up，指针滑出头部也不丢事件），并把「拖动后坐标真的变了」变成端到端硬断言 |
| 6d | 侧栏底部位置被其它插件（Cordis Plugin 区）占用 | 原来注册在 `sidebar.footer.action`，只能落在页脚内 | 改挂 `shell.overlay` 做浮窗，位置由实时测量的锚点决定 |
| 6c | 小窗口的花费/余额/峰谷带**完全不出现**，但样式与辅助函数都在 | 那次 patch 的锚点在文件里已不匹配，**替换静默未生效**，而脚本仍打印成功；我误信了输出 | 重写并**就地 grep 自证**；preflight 新增「关键代码块是否真的写进文件」静态核对（`1.5/4`） |
| 6 | 窄视口下弹窗有**横向超出风险** | 宽度用 `94vw`，而 Modal 的 `.root` 自带 24px 内边距（可用宽度 = `100vw - 48px`），且卡片是 flex item（`min-width: auto` 不收缩） | 改 `min(1080px, calc(100vw - 48px))` + `min-width: 0`；表格包一层 `overflow-x: auto` 的容器 |
| **8** | 浮窗**偶尔变成没有皮肤的裸 div**，跑到侧边栏**左上角**压住会话列表（用户 2026-09-16 截图）；**点【日志】打开再关掉就恢复正常** | 皮肤 `<style>` 只写了 `data-plugin-css`、**没写 `data-plugin`**。DSH 的 client-modules 在**每个模块 materialize 时**都会 `claimStyles(id)`，把所有 `style:not([data-plugin])` 认领给那个模块；这张表被别的模块认领后，client-hmr 重建那个模块时会 `removeOwnedStyles(id)` 把它一起删掉。**插件的 fiber 毫发无伤、React 树照常渲染，只是 CSS 没了** → 浮窗落回 `shell.overlay` 的正常流（左上角 0,0）。而重新注入的唯一路径，恰好是打开日志弹窗时 `LogDialog` 顺带跑的那次 `ensureStyle()`——这就是"开关一次日志就好了"的原因 | ① 样式表补上 `data-plugin` = 包名（与官方 `tsdown.client.ts` 的注入器一致，别人 claim 不走）；② `apply()` 里注入皮肤并挂 `MutationObserver(document.head)`，表一消失就补回；③ `position:fixed`/`z-index` 同时走 inline，样式表缺失的那一瞬间也不会掉进正常流；④ `ensureStyle()` 发现这张表**归属被别人改写过**时把归属抢回来（`removeOwnedStyles` 是按 data-plugin 属性比对的，抢回来就等于销掉别人的账），内容被清空也补回。回归：`tests/client.test.mjs`（归属 + 抢回 + 自愈 + 降级 + head 缺失兜底）、`tests/render.test.mjs`（inline 定位）、`tests/e2e-browser.mjs`（真浏览器里删表 → 自动补回、位置不跳）、`scripts/hmr-probe.mjs`（下面「真 HMR 回归」） |
| **9** | 峰谷时段带在**跨零点后的当天**把 9:00–12:00 的高峰涂成空闲（2026-09-17 00:55 由 e2e 抓到：**峰 0 谷 24**；此前 20:55 跑是绿的，被旧断言放过去了） | `PeakBand` 对**没有用量的小时**（宿主给 `band = 0`，含"今天还没到的小时"）一律回落到 `bandOf(Date.now())` —— 用**当前小时**的颜色涂遍整条带。当前小时是空闲时，一整天的高峰全被涂成"便宜" | 空格子按**它自己那个小时**判定：先解析桶 key（`bandOfKey('2026-09-17T09')`），解析不出再退到「上海今天第 i 个小时」（新增 `shanghaiDayStartMs()`）。旧断言只查「峰谷都有」，改成**金标准向量**：测试与 e2e 都独立算一遍 24 格应有的峰谷，逐格比对，与运行时刻无关 |

> 这两个（5、6）是我最初 e2e 只跑 1400×900 一个尺寸漏掉的——**测试视口不等于用户视口**。
> 现在 `tests/e2e-browser.mjs` 里加了 1280×560 矮视口回归：断言「卡片不越视口 + 内层可滚 + 滚到底最后一段可达」。

## 配色

统一用 **DeepSeek 自己的蓝色系**（`--dsw-static-deepseek-*`），三桶靠明度区分，而不是靠色相：

| 桶 | token | 值 |
|---|---|---|
| 输入（命中缓存） | `--dsw-static-deepseek-400` | `rgb(103, 158, 254)` |
| 输入（未命中缓存） | `--dsw-static-deepseek-500` | `rgb(65, 118, 230)` |
| 输出 | `--dsw-static-deepseek-450` | `rgb(86, 134, 254)` |

明度顺序也表达语义：命中缓存是"省下来的"（偏浅），输出是"真花出去的"（最亮）。

## 六、花费与余额（2026-09-15 新增）

小窗口在「今日总量」下方显示 **今日花费 + 账户余额**，日志弹窗里另有「花费」「账户余额」卡与明细表的「花费」列。

### 单价（官方价目表，元 / 百万 tokens）

来源 [DeepSeek 官方定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)（2026-09-10 12:00 起生效）。**价格分峰谷，这是计费正确性的核心：**

| 模型 | 输入·命中缓存 | 输入·未命中 | 输出 |
|---|---|---|---|
| `deepseek-flash`（V4.1-Flash） | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro` | 0.15 / 0.30 | 4.5 / 9.0 | 13.5 / 27.0 |

「空闲 / 高峰」——**空闲时段价格正好是高峰的一半**。高峰时段 = **北京时间周一至周五 9:00–12:00、14:00–18:00**，其余（含周末全天）为空闲。

因此：**花费不能拿区间总量乘单一单价**，必须逐条按该条记录的时间取价再累加。`aggregate` / `overview` 都是这么算的，并且额外出一个峰谷分解（今天有多少钱花在高峰时段），直接回答"要不要把活挪到空闲时段跑"。

### 配置

单价可能再变，所以写在插件配置里，改 `~/.dsh/profiles/web/cordis.patch.yml` 即可，不必改代码：

```yaml
- id: token-monitor
  config:
    pricing:
      currency: CNY
      unit: 1000000
      peakMultiplier: 2          # 高峰 = 空闲 × 2
      defaultModel: { cacheRead: 0.02, uncached: 1, output: 4 }   # 未登记模型的兜底价
      models:
        deepseek-flash: { cacheRead: 0.02, uncached: 1, output: 4 }
        deepseek-v4-pro: { cacheRead: 0.15, uncached: 4.5, output: 13.5 }
    apiKeyEnv: DEEPSEEK_API_KEY  # 余额查询用；也可直接 apiKey: sk-...
```

未登记单价的模型**不会静默算成 0**（那会被读成"不花钱"），而是用 `defaultModel` 估算并在弹窗里点名提示。

### 余额

调 DeepSeek 官方 `GET /user/balance`（只读、免费）。凭据解析顺序：插件配置 `apiKey` → 环境变量 `apiKeyEnv` → `$DSH_HOME/.credentials.yaml` 的 `refs` 段。结果缓存 120 秒，接口超时 6 秒即降级。

**取不到时显示「—」并在悬浮里写明原因**（no-key / timeout / network / http-4xx），绝不用 `0` 冒充——`0` 会被读成"没钱了"，这是误导。

### 峰谷时段带（直方图上方）

直方图上方一条 24 格色带，**同一 DeepSeek 蓝的明度差**表达价格差异：高峰 `deepseek-500`（深，贵）、空闲 `deepseek-200`（浅，半价）。不用红/绿是因为峰谷只是价格差，不是对错。

## 七、放行闸门（改完必跑）

```bash
bash /root/apps/dsh-plugin-token-monitor/preflight.sh     # 退出码 0 才允许说"完成"
```

它依次跑：客户端契约（含 **id == 包名**）→ 宿主逻辑 → 元素树 → **profile 挂载核对** → **真浏览器 boot 审计**（全新 context，零缓存；断言「无 pageerror / 无 4xx / 无 `Failed to load plugins` / 侧栏已渲染 / 硬刷新后仍正常」）。

**为什么需要它：**事故当时 `host`/`client`/`render` 三层全绿，界面上却是整个应用打不开——单元测试无法发现"注册 id 与模块表行 id 不匹配"这类跨进程契约错误，只有真的 boot 一次才知道。

## 八、验证方式（五层，越往下越接近真相）

```bash
# 从 GitHub 克隆下来后，直接在克隆目录里跑（测试不依赖绝对路径）
git clone https://github.com/hipigod/dsh-token-monitor.git && cd dsh-token-monitor
node tests/host.test.mjs          # 35 项：宿主纯逻辑 + 真实 HTTP 路由（自建 server，不依赖宿主）
node tests/client.test.mjs        # 23 项：格式化/桶标签/峰谷判定/日期/注册契约与皮肤归属契约
node tests/render.test.mjs        # 21 项：用假 React 直接调用组件函数，断言真实元素树
TOKEN=$(grep -oE 'token=[A-Za-z0-9_-]+' /var/log/dsh-web.log | tail -1)
node tests/e2e-browser.mjs "$TOKEN"   # 32 项：无头 Chromium 打开真 GUI，断言真 DOM 几何
```

第四层是**唯一能发现上面 4 个缺陷**的一层：前三层全绿的时候，界面上依然是空的。
`tests/e2e-browser.mjs` 直接断言「模型名与【日志】按钮的矩形不相交」「弹窗卡片宽度 > 900px」「内层不溢出卡片」这类几何事实，而不是截图给人看。

### 真 HMR 回归（缺陷 8 的机制级复现）

`tests/e2e-browser.mjs` 里删 `<style>` 是**手工**模拟。要证明「宿主自己的重建路径也不会弄丢皮肤」，
用工作区里的 `scripts/hmr-probe.mjs`（临时改一次 `client.js` 内容 → 宿主 500ms stat-poll 推 `rebuilt` 帧 →
浏览器热重建插件，结束后把文件按字节还原并校验 sha256）：

```bash
TOKEN=$(grep -oE 'token=[A-Za-z0-9_-]+' /var/log/dsh-web.log | tail -1)
node /root/dsh-workspace/2026-09-token-monitor-workspace/scripts/hmr-probe.mjs "$TOKEN"
```

它断言三件事：**已打开的页面不用刷新就换上 new bundle**（真取回了新 rev，皮肤表是新 DOM 节点）、
重建后皮肤与坐标无损、**皮肤表被别的模块认领后再重建时归属被抢回**。2026-09-17 实测 7/7 通过。


另有宿主侧自检端点（不需要 token、不需要浏览器）：

```bash
curl -s http://127.0.0.1:3080/plugin-api/token-monitor/doctor | jq
```

## 八点五、本机部署位置（这台机器上的实际情况）

| 路径 | 是什么 |
|---|---|
| `/root/apps/dsh-plugin-token-monitor/` | 插件源码。**不要搬**：profile 以 `link:` 依赖它，搬走会让整个 GUI 不挂载 |
| `/root/dsh-workspace/2026-09-token-monitor-workspace/` | 开发这一轮的工作区（笔记、截图、`scripts/hmr-probe.mjs`，`source` 符号链接指向源码；旧名 `dsh-token-monitor-workspace` 已改名） |
| `/root/archive/dsh-token-monitor-backups/` | 好版本快照与事故版本备份 |
| `/root/archive/profile-web-backup-20260915-163321/` | 安装插件前的 web profile 备份（整体回滚用） |
| https://github.com/hipigod/dsh-token-monitor | 已推送的公开仓库 |

那轮对话的完整记录（实现细节、两个事故的复盘、恢复手册）在这个工作区的
`notes/token-monitor-plugin.md`。

## 九、实现要点（为什么这么做）

- **zstd 多帧**：DSH 的会话日志是**多帧拼接**的 zstd 流，每帧 ~1.8KB（实测 1.38MB / 750 帧）。`zlib.zstdDecompressSync(buffer)` 只解第一帧——会得到「1 行日志」；流式解压器则在第二帧边界报 `Unknown frame descriptor`。因此按帧魔数切分、逐帧解码，并给解码器加 `finishFlush: Z_SYNC_FLUSH`：不加的话，一个只有帧头的坏数据会**静默返回空缓冲**，伪装成「这个会话没有用量」。
- **截断判定**：zstd 是分块压缩，末尾少几字节往往仍能解出来，所以「能否解压」不足以判断截断。做法是：末帧解不出且前面已解出内容 → 标记截断继续；否则报错。同时用 `hasIncompleteTail()`（明文末尾没有换行）兜住「残行恰好还能 JSON.parse」的情况。
- **扫描缓存**：按 `(mtimeMs, size)` 做文件级缓存，30 秒轮询不会重复解码历史日志；进程内单飞（同一时刻只跑一次扫描），并清理已删除会话的缓存项。
- **跨插件零依赖**：宿主侧只用 `node:zlib` + `node:fs`；客户端侧只 require `react` / `react/jsx-runtime` / `@deepseek-ai/dsh-client-ui-primitives`（三者都是 DSH 的 `PLATFORM_MODULES` 基线外置），不 import 任何其它插件。
- **注册 id 必须等于包名**：client-modules 的 `arrive()` 以「模块表行 id」为键等待 bundle 自注册，`__ModuleLoader__.load({id})` 里写别的名字会在浏览器 boot 期直接抛错，表现为「插件不显示」且宿主日志里**没有任何痕迹**（这是本插件踩过的第一个坑）。
- **挂载点**：注册进 ui-layout 声明的 `shell.overlay`（全框浮层，list 槽位、可叠加、默认点击穿透），由 `ctx.slots.inject(...)` 等待该槽位声明后再注册——直接 `register` 到别人声明的槽位会在加载期报错。位置不是写死的：实时量侧栏与页脚矩形的锚点（`bottom` 定位）。历史上曾用 `sidebar.footer.action`，但那个槽位只能表达「页脚内的一行」，落在不了会话列表与页脚之间（见缺陷 6d）。
- **皮肤必须自己"上户口"**：`<style>` 同时写 `data-plugin`（= 包名，归属）与 `data-plugin-css`（去重键），并在 `apply()` 里注入 + 用 `MutationObserver(document.head)` 自愈；`ensureStyle()` 若发现这张表的归属被别人改写过，会把归属**抢回来**（`removeOwnedStyles` 是按 `data-plugin` 属性逐字比对的，抢回来即销掉别人的账）。不写 `data-plugin` 的表会被 client-modules 的 `claimStyles` 认领给别人，再随那个模块的 HMR 重建被 `removeOwnedStyles` 删掉，而本插件不会收到任何通知（见缺陷 8）。`position:fixed`/`z-index` 另外走 inline 兜底：即使皮肤一时缺失，浮窗也只是"没化妆"，不会掉进 overlay 的正常流去压住侧栏。
- **峰谷是按"那一格自己那个小时"算的**：宿主只给有用量的小时带 `band`，空格子（含今天还没到的小时）由客户端补。补的时候必须用**该格对应的小时**（桶 key → `bandOfKey`，兜底 `shanghaiDayStartMs(now) + i 小时`），不能用 `Date.now()`——那会把整条带涂成"当前小时"的颜色，跨零点后高峰时段的颜色就错了（缺陷 9）。

---

四层测试都是**对抗性**用例：跨日界、跨月、非法日期（`2026-99-99`、`2026-02-30` 必须被拒而不是被 `Date.parse` 归一）、坏帧、截断帧、越界 hover、空数据、`NaN` 传播、定时器泄漏、口径一致性（totals == models 求和 == buckets 求和 == conversations 求和）。

---

## 十、已知边界

- **第三方客户端插件是"全应用级"风险**：一个注册 id 写错的 bundle 会让整个 GUI 不挂载（不是只坏自己）。所以改动客户端代码后必须跑 `preflight.sh`，别只看单元测试。
- 只统计**写进会话日志**的用量。如果某个 provider 不回报 usage，那部分不会出现在这里（也无法从日志推断）。
- 「按对话」里同时包含 subagent 会话（如果有的话），会按会话 id 分开列出。
- 历史日志格式升级（当前硬编码 `session.v3.jsonl.zstd`）后需要同步改路径；`doctor` 会在模块表层面先暴露异常。
- 日志目录默认取 `$DSH_HOME`（未设则 `~/.dsh`），与 DSH 自身一致。
