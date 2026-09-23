/**
 * 模型 Token 用量监测 · TOKEN MONITOR — Client half.
 *
 * 挂载点：`shell.overlay`（ui-layout 声明的全框浮层）里的一个**浮窗**，
 * 位置由实时测量的锚点决定 —— 落在「侧边栏会话列表下方、页脚（设置按钮）上方」。
 * 历史上曾注册在 `sidebar.footer.action`，但那个槽位只能表达「页脚内的一行」，
 * 落不到会话列表与页脚之间，且位置会被其它插件占用（见 README 缺陷 6d）。
 *
 * 皮肤（`<style>`）必须带 `data-plugin` = 包名并自愈，否则会被别的模块 claimStyles
 * 认领走、再随它的 HMR 重建被删掉，浮窗就会变成没皮肤的裸 div（见 README 缺陷 8）。
 *
 * 数据来源：宿主侧插件注册的两个命名路由
 *   GET /plugin-api/token-monitor/overview   今日总览（小窗口）
 *   GET /plugin-api/token-monitor/log?...    日志弹窗全量报告
 * 客户端不读会话日志、不碰 ctx 服务之外的东西，只做取数与呈现。
 *
 * 展示约定：
 *   - 「输入（命中缓存）」= cacheReadTokens
 *   - 「输入（未命中缓存）」= inputTokens + cacheWriteTokens
 *   - 「输出」= outputTokens（含 reasoning）
 *   - 时间口径固定 Asia/Shanghai，由宿主统一切分，客户端不再做时区换算。
 */
window.__ModuleLoader__.load({
  id: "@local/dsh-token-monitor",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var jsx = require('react/jsx-runtime')
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    var Modal = primitives.Modal
    var IconRefreshOutline14 = primitives.IconRefreshOutline14
    var IconDataOutline16 = primitives.IconDataOutline16
    var IconCloseOutline16 = primitives.IconCloseOutline16

    // ───────────────────────── 常量 ─────────────────────────

    /**
     * 包名。它是四个东西的同一个值，任何一处不一致都会出事故（详见 README「已修缺陷」）：
     * 模块表行 id = `__ModuleLoader__.load({id})` = `<style data-plugin>` 的归属者 = HMR 的 entry id。
     */
    var PLUGIN_ID = '@local/dsh-token-monitor'

    var API_OVERVIEW = '/plugin-api/token-monitor/overview'
    var API_LOG = '/plugin-api/token-monitor/log'
    /** 小窗口自动刷新间隔（宿主侧扫描有 (mtime,size) 缓存，这个频率不会造成重复解码）。 */
    var POLL_MS = 30000
    /** 分页大小。 */
    var PAGE_SIZE = 12

    // 全部用 DeepSeek 自己的蓝色系（--dsw-static-deepseek-*），三桶靠明度而不是色相区分：
    //   命中缓存 400（中亮）→ 未命中 500（标准 DeepSeek 蓝）→ 输出 450（高亮）
    // 明度顺序也表达语义：缓存命中是"省下来的"（偏浅），输出是"真金白银花出去的"（最亮）。
    var COLORS = {
      cacheRead: 'var(--dsw-static-deepseek-400)',
      uncached: 'var(--dsw-static-deepseek-500)',
      output: 'var(--dsw-static-deepseek-450)',
      // 峰谷时段带：高峰=标准 DeepSeek 蓝（贵），空闲=浅蓝（便宜一半）。
      // 用同一色系的明度差，而不是红/绿那种"好坏"语义——峰谷只是价格差异，不是对错。
      peakBand: 'var(--dsw-static-deepseek-500)',
      idleBand: 'var(--dsw-static-deepseek-200)',
      /** 花费/余额：中性强调色，避免和 token 三桶抢注意力。 */
      money: 'var(--dsw-alias-label-primary)',
    }

    // ───────────────────────── 样式 ─────────────────────────

    var CSS_TAG = 'dsh-token-monitor/skin.css'
    var CSS = [
      '.tm-root{box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:8px 10px 10px;margin:0 6px 2px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);font:var(--dsw-font-xs-12,12px/1.5 ui-sans-serif,system-ui,"PingFang SC","Microsoft YaHei",sans-serif);color:var(--dsw-alias-label-primary)}',
      '.tm-root *{box-sizing:border-box}',
      '.tm-root-tight{padding:6px 4px;margin:0 4px 2px;align-items:center}',

      '.tm-head{display:flex;align-items:center;gap:6px;min-width:0}',
      '.tm-title{display:flex;align-items:center;gap:5px;flex:1 1 auto;min-width:0;overflow:hidden}',
      // max-width 是必需的：flex 子项不会自动收缩到可用宽度，只写 ellipsis 会让长模型名
      // 直接压到【日志】按钮上（截图实证）。这里显式留出按钮宽度。
      // 名字可用宽度跟容器走：固定 96px 会把它压成 "deepseek-fl…"，而【日志】左边其实还有空白。
      // clamp 给 96px 保底（防重叠）+ 42% 弹性 + 190px 上限（超长名不挤压按钮）。
      '.tm-model{display:block;flex:0 1 auto;min-width:0;max-width:clamp(96px,42%,190px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650;font-size:12px;color:var(--dsw-alias-label-primary)}',
      '.tm-model-dim{color:var(--dsw-alias-label-tertiary);font-weight:500}',
      '.tm-head-actions{display:flex;align-items:center;gap:2px;flex:none}',

      '.tm-total{display:flex;align-items:baseline;gap:5px;flex-wrap:wrap}',
      '.tm-total-value{font-size:17px;font-weight:700;letter-spacing:-.01em;font-variant-numeric:tabular-nums}',
      '.tm-total-label{font-size:11px;color:var(--dsw-alias-label-tertiary)}',

      // 浮窗外壳：挂进 shell.overlay（该层 pointer-events:none，直接子元素自动恢复 auto）。
      // 用 position:fixed 锚定到侧边栏几何，随侧边栏宽度/收起状态与窗口尺寸实时跟随。
      '.tm-float{position:fixed;z-index:30;display:flex;flex-direction:column;box-sizing:border-box;'
        + 'border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);'
        + 'box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.18));overflow:hidden}',
      '.tm-float-head{display:flex;align-items:center;gap:4px;padding:4px 6px 0 8px;cursor:grab;user-select:none}',
      '.tm-float-head:active{cursor:grabbing}',
      '.tm-float-body{padding:0 10px 8px}',
      '.tm-float-icon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex:none;'
        + 'border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0}',
      '.tm-float-icon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      // 最小化后的胶囊
      '.tm-pill{position:fixed;z-index:30;display:flex;align-items:center;gap:6px;padding:4px 8px;cursor:pointer;'
        + 'border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);'
        + 'box-shadow:var(--dsw-elevation-prominent,0 6px 16px rgba(0,0,0,.16));'
        + 'font:var(--dsw-font-xs-12,12px/1.4 ui-sans-serif,system-ui,"PingFang SC",sans-serif);color:var(--dsw-alias-label-primary)}',
      '.tm-pill:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.tm-pill-total{font-weight:700;font-variant-numeric:tabular-nums}',
      '.tm-pill-money{font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',

      // 花费/余额行
      '.tm-money{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding-top:1px}',
      '.tm-money-item{display:flex;align-items:baseline;gap:3px;min-width:0}',
      '.tm-money-value{font-size:12.5px;font-weight:650;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.tm-money-label{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
      '.tm-money-dim{color:var(--dsw-alias-label-tertiary);font-weight:500}',
      '.tm-money-warn{color:var(--dsw-alias-state-warn-label)}',

      // 峰谷时段带（直方图上方）
      '.tm-band{display:flex;gap:1px;height:5px;margin-bottom:3px}',
      '.tm-band-cell{flex:1 1 0;min-width:2px;border-radius:1px;background:var(--dsw-alias-bg-layer-2)}',
      '.tm-band-cell[data-band="1"]{background:var(--dsw-static-deepseek-200)}',
      '.tm-band-cell[data-band="2"]{background:var(--dsw-static-deepseek-500)}',
      '.tm-band-legend{display:flex;align-items:center;gap:8px;font-size:10px;color:var(--dsw-alias-label-tertiary);margin-bottom:2px}',
      '.tm-band-key{display:flex;align-items:center;gap:3px}',

      '.tm-chart{display:flex;align-items:flex-end;gap:1px;height:42px;padding-top:2px}',
      '.tm-bar{flex:1 1 0;min-width:2px;height:100%;display:flex;flex-direction:column;justify-content:flex-end;gap:0;border-radius:2px;cursor:default;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.tm-bar-on{outline:1px solid var(--dsw-alias-border-l3);outline-offset:0}',
      '.tm-bar span{display:block;width:100%}',
      '.tm-bar-empty{height:2px;background:var(--dsw-alias-border-l1)}',

      '.tm-axis{display:flex;justify-content:space-between;font-size:10px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.tm-legend{display:flex;gap:8px 10px;flex-wrap:wrap;justify-content:flex-end;max-width:100%;min-width:0;font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.tm-legend-item{display:flex;align-items:center;gap:4px;cursor:default}',
      '.tm-legend-item b{font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.tm-swatch{width:8px;height:8px;border-radius:2px;flex:none}',
      '.tm-hint{min-height:14px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.tm-note{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
      '.tm-error{font-size:10.5px;color:var(--dsw-alias-state-error-primary)}',

      // 窄栏（collapsed：56px rail）形态
      '.tm-rail{display:flex;flex-direction:column;align-items:center;gap:2px;width:100%;background:none;border:none;padding:4px 0;border-radius:8px;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit}',
      '.tm-rail:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.tm-rail-value{font-size:9.5px;font-weight:650;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;line-height:1}',

      // 纯文字按钮（本插件自带，避免依赖其它插件组件）
      '.tm-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:6px;padding:2px 7px;font:inherit;font-size:11px;line-height:1.5;cursor:pointer;white-space:nowrap}',
      '.tm-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.tm-btn[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);font-weight:650}',
      '.tm-btn-icon{display:inline-flex;align-items:center;justify-content:center;padding:3px}',
      '.tm-btn[disabled]{opacity:.5;cursor:default}',

      // 弹窗
      // ① 卡片本身：ui-primitives 的 .dialog 是 width:min(380px,100%) + overflow:hidden，
      //    内层再宽也会被裁掉（实测：内层 1080px、卡片 380px → 右侧全被隐藏）。
      //    Modal 只把 className 透给卡片，所以宽度必须在这里覆盖。
      // 宽度：Modal 的 .root 自带 24px 内边距，所以可用宽度 = 100vw - 48px；
      // 直接用 94vw 在窄视口会超出这个可用宽度被裁。min-width:0 是必需的——
      // 卡片是 flex item，默认 min-width:auto 不会收缩到可用宽度以下。
      '.tm-modal{width:min(1080px,calc(100vw - 48px)) !important;min-width:0 !important;max-width:none !important;max-height:calc(100vh - 48px) !important;overflow:hidden}',
      // ② 内层：只负责排版与滚动，宽度交给卡片
      '.tm-dialog{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:100%;min-width:0;max-width:none;flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:18px 22px 20px}',
      '.tm-dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:2px 0 0}',
      '.tm-dialog-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.tm-dialog-desc{margin:3px 0 0;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}',
      '.tm-dialog-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:8px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}',
      '.tm-dialog-close:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.tm-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.tm-row-between{justify-content:space-between}',
      '.tm-sep{width:1px;height:16px;background:var(--dsw-alias-border-l1)}',
      '.tm-group{display:flex;gap:4px;flex-wrap:wrap}',
      '.tm-date{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;padding:2px 6px;color-scheme:dark}',
      '.tm-range-text{font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',

      '.tm-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px}',
      '.tm-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1)}',
      '.tm-card-label{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:3px}',
      '.tm-card-value{font-size:19px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.01em}',
      '.tm-card-sub{font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-top:2px}',

      '.tm-section{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px}',
      '.tm-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px 12px;flex-wrap:wrap;margin-bottom:8px}',
      '.tm-section-title{font-size:12.5px;font-weight:650}',
      '.tm-section-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',

      '.tm-hist{display:flex;align-items:flex-end;gap:2px;height:96px;padding-top:4px;overflow-x:auto}',
      '.tm-hist-col{flex:1 1 0;min-width:7px;height:100%;display:flex;flex-direction:column;justify-content:flex-end;gap:0;border-radius:3px;background:var(--dsw-alias-bg-layer-2);cursor:default}',
      '.tm-hist-col-on{outline:1px solid var(--dsw-alias-border-l3)}',
      '.tm-hist-col span{display:block;width:100%}',
      '.tm-hist-axis{display:flex;gap:2px;margin-top:5px;font-size:10px;color:var(--dsw-alias-label-tertiary)}',
      '.tm-hist-axis div{flex:1 1 0;min-width:7px;text-align:center;overflow:hidden;white-space:nowrap}',

      '.tm-dist{display:flex;flex-direction:column;gap:6px;margin-top:2px}',
      '.tm-dist-row{display:flex;align-items:center;gap:8px;font-size:11.5px}',
      '.tm-dist-name{flex:0 0 auto;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
      '.tm-dist-track{flex:1 1 auto;height:8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;display:flex}',
      '.tm-dist-track span{display:block;height:100%}',
      '.tm-dist-value{flex:0 0 auto;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);font-weight:600}',
      '.tm-dist-pct{flex:0 0 42px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);font-size:10.5px}',

      '.tm-table-wrap{width:100%;max-width:100%;overflow-x:auto;overflow-y:visible}',
      '.tm-table{width:100%;border-collapse:collapse;font-size:11.5px}',
      '.tm-table th{text-align:right;font-weight:500;color:var(--dsw-alias-label-tertiary);font-size:10.5px;padding:0 8px 6px;white-space:nowrap;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.tm-table th:first-child,.tm-table td:first-child{text-align:left}',
      '.tm-table td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.tm-cell-title{max-width:min(420px,42vw)}',
      '.tm-table tr:last-child td{border-bottom:none}',
      '.tm-table tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.tm-cell-title{display:flex;flex-direction:column;gap:1px;align-items:flex-start;text-align:left;min-width:180px;max-width:420px}',
      '.tm-cell-title b{font-weight:600;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
      '.tm-cell-title small{color:var(--dsw-alias-label-tertiary);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
      '.tm-chip{display:inline-block;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 6px;font-size:10px;color:var(--dsw-alias-label-tertiary);margin-right:3px}',

      '.tm-empty{padding:18px 6px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:11.5px}',
      '.tm-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
      '.tm-mini{display:inline-flex;gap:2px;align-items:center}',
    ].join('\n')

    /**
     * 注入本插件的皮肤。
     *
     * ⚠ 必须同时写 `data-plugin`（= 包名）与 `data-plugin-css`（去重键）。原因是 DSH 的
     * client-modules 在**每个模块 materialize 时**都会跑 claimStyles(id)，把文档里所有
     * `style:not([data-plugin])` 的样式表认领给那个模块（packages/client/modules/src/client/
     * system.ts 的 claimStyles）；随后 client-hmr 重建那个模块时会跑 removeOwnedStyles(id)，
     * 把「属于它的」样式表一起删掉（packages/client/hmr/src/client/index.ts）。
     *
     * 只写 data-plugin-css 的后果（2026-09-16 用户截图实证）：这张表先被别的模块 claim 走，
     * 再随它的 HMR 重建被删 —— 本插件的 fiber 毫发无伤、React 树照常渲染，但 CSS 没了，
     * 浮窗退化成无样式 div 落进 shell.overlay 的正常流（左上角 0,0），压住侧栏的会话列表，
     * 只有「打开日志再关掉」这种偶然路径才会重新注入。
     *
     * 官方注入器（packages/client/tsdown.client.ts 的 styleInjectionModule）就是同时打这两个
     * 属性，这里对齐它：这张表只归本插件所有，别人 claim 不走；我们自己的 HMR 重建会连它
     * 一起正确回收，再由 apply() 重新注入。
     */
    function ensureStyle() {
      if (typeof document === 'undefined' || document.head === null || document.head === undefined) return
      var existing = document.querySelector('style[data-plugin-css="' + CSS_TAG + '"]')
      if (existing !== null) {
        // 表在，但归属未必是本插件：修复前注入的那张（只写了 data-plugin-css）早已被别的模块
        // 的 claimStyles 认领走。认领/回收的账本是「按 data-plugin 属性逐字比对」的
        // （removeOwnedStyles），所以把归属抢回来就等于替那张表销掉别人的账 —— 那个模块
        // 之后再重建，也不会连坐删掉我们的皮肤。只按 data-plugin-css 去重、不看归属，
        // 会让页面长期停在「皮肤是别人的」这个中间态上。
        if (existing.getAttribute('data-plugin') !== PLUGIN_ID) existing.setAttribute('data-plugin', PLUGIN_ID)
        // 只清内容、不删节点同样是「皮肤没了」（外部清理脚本、误操作），补回内容。
        if (existing.textContent === '') existing.textContent = CSS
        return
      }
      var tag = document.createElement('style')
      tag.setAttribute('data-plugin', PLUGIN_ID)
      tag.setAttribute('data-plugin-css', CSS_TAG)
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * 样式自愈：这张表一旦消失（HMR 记账误删、别的代码清理 head、用户脚本等），必须立刻补回。
     * 不补的后果就是上面的故障形态——浮窗长期停成无样式 div，用户得手动开关一次日志弹窗。
     *
     * 观察 document.head 的 childList：删除动作本身触发一次微任务回调，补回后不再产生新变更，
     * 因此不会自激循环。返回的观察器交给调用方 disconnect（随 fiber 一起回收）。
     *
     * head 还不存在时退一步观察 documentElement：head 被插进来时 childList 回调会再跑一次
     * ensureStyle 把皮肤补上；否则 apply 这一跑没注入成，就再没有任何东西会重试。
     *
     * @returns {MutationObserver|null} 观察器；环境不支持时为 null
     */
    function watchStyle() {
      if (typeof MutationObserver !== 'function') return null
      if (typeof document === 'undefined') return null
      var head = document.head
      var target = (head === null || head === undefined) ? document.documentElement : head
      if (target === null || target === undefined) return null
      var observer = new MutationObserver(function () { ensureStyle() })
      observer.observe(target, { childList: true })
      return observer
    }

    // ───────────────────────── 工具 ─────────────────────────

    /** 紧凑数字：1234 → 1.2k，1200000 → 1.2M。 */
    function fmtCompact(value) {
      var n = Number(value) || 0
      if (n < 1000) return String(n)
      if (n < 1000000) return trimZero(n / 1000) + 'k'
      if (n < 1000000000) return trimZero(n / 1000000) + 'M'
      return trimZero(n / 1000000000) + 'B'
    }

    function trimZero(n) {
      var v = n >= 100 ? Math.round(n) : Math.round(n * 10) / 10
      return String(v)
    }

    /** 全量数字（千分位），用于明细表。 */
    function fmtFull(value) {
      return (Number(value) || 0).toLocaleString('en-US')
    }

    /** 分档位压缩：把「十万级」显示成 12.3万，避免中文界面里满屏 M。 */
    function fmtZh(value) {
      var n = Number(value) || 0
      if (n < 10000) return fmtFull(n)
      if (n < 100000000) return trimZero(n / 10000) + '万'
      return trimZero(n / 100000000) + '亿'
    }

    /** 金额：小额保留 2~4 位有效数字，别把 ￥0.0034 显示成 ￥0.00。 */
    function fmtMoney(value, currency) {
      var n = Number(value)
      if (!Number.isFinite(n)) return '—'
      var unit = currency === 'CNY' || currency === undefined || currency === null ? '¥' : (currency + ' ')
      if (n >= 1) return unit + n.toFixed(2)
      if (n >= 0.01) return unit + n.toFixed(4)
      return unit + n.toPrecision(2)
    }

    function fmtPercent(ratio) {
      if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—'
      return (ratio * 100).toFixed(1) + '%'
    }

    /** 桶标签：小时桶 'YYYY-MM-DDTHH' → 'HH:00'；天桶 'YYYY-MM-DD' → 'M/D'。 */
    function bucketLabel(key, dim) {
      if (typeof key !== 'string') return ''
      if (dim === 'hour') {
        var parts = key.split('T')
        return parts.length === 2 ? parts[1] + ':00' : key
      }
      var bits = key.split('-')
      return bits.length === 3 ? String(Number(bits[1])) + '/' + String(Number(bits[2])) : key
    }

    /** 完整桶标签（悬浮提示用）。 */
    function bucketFullLabel(key, dim) {
      if (dim === 'hour') {
        var parts = String(key).split('T')
        if (parts.length !== 2) return key
        return parts[0] + ' ' + parts[1] + ':00–' + parts[1] + ':59'
      }
      return key + '（当日）'
    }

    /** 空桶（区间内没有用量的那一格）。字段与宿主 timeBuckets 的空桶完全一致。 */
    function emptyBucket(key) {
      return { key: key, label: key, cr: 0, ci: 0, out: 0, total: 0, requests: 0, cost: 0, band: 0, peak: false }
    }

    /**
     * 区间内的**全部**桶 key（上海口径，升序）：天粒度逐日，小时粒度逐小时（每天 24 格）。
     * 区间非法、倒序，或格数超出上限（自定义区间跨年）时返回空数组 —— 调用方据此放弃补齐，
     * 宁可稀疏，也不能为了补空档把上万条空桶塞进图里。
     *
     * @param {string} start YYYY-MM-DD（上海）
     * @param {string} end YYYY-MM-DD（上海，含当天）
     * @param {string} dim 'hour' | 'day'
     * @returns {Array<string>} key 列表；无法补齐时为空
     */
    function rangeKeys(start, end, dim) {
      if (typeof start !== 'string' || typeof end !== 'string') return []
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return []
      if (end < start) return []
      var dayLimit = dim === 'hour' ? 40 : 1000
      var keys = []
      var cursor = start
      for (var i = 0; i < dayLimit && cursor <= end; i += 1) {
        if (dim === 'hour') {
          for (var hour = 0; hour < 24; hour += 1) keys.push(cursor + 'T' + String(hour).padStart(2, '0'))
        } else {
          keys.push(cursor)
        }
        cursor = shiftDateString(cursor, 1)
      }
      return cursor <= end ? [] : keys
    }

    /**
     * 按区间补齐时间轴：缺的格子补成 0 桶（Histogram 对 0 桶画 2px 底线，
     * 既保持等距节奏，又能一眼看出"这几天没用"）。
     * 已有桶的顺序与内容原样保留；补齐后严格按区间升序排列。
     */
    function fillBuckets(buckets, dim, range) {
      if (range === null || typeof range !== 'object') return buckets
      var keys = rangeKeys(range.start, range.end, dim)
      if (keys.length === 0) return buckets
      var byKey = Object.create(null)
      for (var i = 0; i < buckets.length; i += 1) {
        var bucket = buckets[i]
        if (bucket !== null && typeof bucket === 'object' && typeof bucket.key === 'string') byKey[bucket.key] = bucket
      }
      var list = []
      for (var j = 0; j < keys.length; j += 1) {
        var hit = byKey[keys[j]]
        list.push(hit === undefined ? emptyBucket(keys[j]) : hit)
      }
      return list
    }

    /**
     * 峰谷时段判定：与宿主 isPeakHour 同一规则（北京时间周一至周五 9–12、14–18）。
     * 这里再算一遍是为了给"未来小时"上色——那部分没有数据、宿主不会返回 band。
     * @param {number} ms UTC 毫秒
     * @returns {0|1|2} 0=未知 1=空闲时段 2=高峰时段
     */
    function bandOf(ms) {
      var local = new Date(ms + 8 * 3600000)
      var day = local.getUTCDay()
      if (day === 0 || day === 6) return 1
      var hour = local.getUTCHours()
      return ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)) ? 2 : 1
    }

    /**
     * 上海当日 00:00 对应的 UTC 毫秒。峰谷带要按「今天第 i 个小时」上色，就得知道今天从哪一刻起。
     * @param {number} ms 当前时刻（UTC 毫秒）
     * @returns {number} 当日 00:00（上海）的 UTC 毫秒
     */
    function shanghaiDayStartMs(ms) {
      var local = new Date(ms + 8 * 3600000)
      return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 8 * 3600000
    }

    /**
     * 桶 key → 该桶**自己那个时段**的峰谷判定。
     * key 是上海本地时刻串（'2026-09-17T09' 小时桶 / '2026-09-17' 天桶），
     * 先还原成真实 UTC 瞬时（-8h）再交给 bandOf（内部再 +8h）。
     * @param {string} key 桶 key
     * @returns {0|1|2} 0=解析不出（未知）
     */
    function bandOfKey(key) {
      if (typeof key !== 'string') return 0
      var m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?/.exec(key)
      if (m === null) return 0
      var ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] === undefined ? 0 : Number(m[4]))
      return bandOf(ms - 8 * 3600000)
    }

    /** 峰谷时段带：直方图上方一条 24 格色带，回答"哪个时段贵"。 */
    function PeakBand(props) {
      var buckets = props.buckets || []
      var hours = props.hours || 24
      var dayStart = shanghaiDayStartMs(Date.now())
      var cells = []
      for (var i = 0; i < hours; i += 1) {
        var bucket = buckets[i]
        var band = bucket && typeof bucket.band === 'number' && bucket.band > 0 ? bucket.band : 0
        // 没有用量的小时（含「今天还没到的小时」）宿主给的 band 是 0，必须按**这一格自己那个小时**
        // 判定：先看桶 key，再看「今天第 i 个小时」。
        // 旧写法对空格子一律用 bandOf(Date.now()) —— 跨零点后整条带都按"当前小时"上色，
        // 9:00–12:00 的高峰会被涂成空闲（e2e 在 00:55 抓到：峰 0 谷 24）。
        if (band === 0) band = bandOfKey(bucket && bucket.key)
        if (band === 0) band = bandOf(dayStart + i * 3600000)
        cells.push(jsx.jsx('div', {
          className: 'tm-band-cell',
          'data-band': band,
          title: String(i).padStart(2, '0') + ':00–' + String(i).padStart(2, '0') + ':59 · '
            + (band === 2 ? '高峰时段（单价 ×2）' : '空闲时段（单价 ×1）'),
        }, 'band' + i))
      }
      return jsx.jsx('div', { className: 'tm-band', children: cells })
    }

    /**
     * 取响应里的币种：优先顶层 currency，其次余额的币种，最后按人民币兜底。
     * 为什么要兜底：宿主某版 logPayload 漏传 currency 时，金额会退化成不带符号的数字。
     */
    function currencyOf(data) {
      if (data && typeof data.currency === 'string' && data.currency) return data.currency
      if (data && data.balance && typeof data.balance.currency === 'string' && data.balance.currency) return data.balance.currency
      return 'CNY'
    }

    /** 余额是否可用（取到真实数字）。 */
    function balanceKnown(balance) {
      return !!(balance && balance.ok === true && typeof balance.total === 'number')
    }

    /** 余额悬浮说明：把取不到的原因讲清楚，而不是只显示一个"—"。 */
    function balanceTitle(balance) {
      if (balanceKnown(balance)) {
        return '账户余额 ' + fmtMoney(balance.total, balance.currency)
          + (balance.granted ? '\n赠送余额 ' + fmtMoney(balance.granted, balance.currency) : '')
          + (balance.toppedUp ? '\n充值余额 ' + fmtMoney(balance.toppedUp, balance.currency) : '')
          + (balance.available === false ? '\n⚠ 余额不足' : '')
      }
      var reason = balance && balance.reason
      var why = reason === 'no-key' ? '未找到 DeepSeek API Key（可用 DEEPSEEK_API_KEY 或插件配置 apiKey）'
        : reason === 'timeout' ? '余额接口超时'
          : reason === 'network' ? '余额接口不可达'
            : reason ? '余额接口返回 ' + reason : '尚未取到'
      return '余额不可用：' + why
    }

    /** 相对时间：多久以前。 */
    function fmtAgo(ms, now) {
      if (typeof ms !== 'number' || ms <= 0) return '—'
      var diff = Math.max(0, now - ms)
      var min = Math.floor(diff / 60000)
      if (min < 1) return '刚刚'
      if (min < 60) return min + ' 分钟前'
      var hour = Math.floor(min / 60)
      if (hour < 24) return hour + ' 小时前'
      var day = Math.floor(hour / 24)
      if (day < 30) return day + ' 天前'
      return new Date(ms).toISOString().slice(0, 10)
    }

    /** 上海当前日期（用于自定义日期默认值）。 */
    function shanghaiToday(offsetMinutes) {
      var off = typeof offsetMinutes === 'number' ? offsetMinutes : 480
      return new Date(Date.now() + off * 60000).toISOString().slice(0, 10)
    }

    function shiftDateString(date, days) {
      var ms = Date.parse(date + 'T00:00:00.000Z')
      return new Date(ms + days * 86400000).toISOString().slice(0, 10)
    }

    /** fetch JSON（带超时与错误归一）。 */
    function getJson(url, timeoutMs) {
      var controller = typeof AbortController === 'function' ? new AbortController() : null
      var timer = controller === null ? null : setTimeout(function () { controller.abort() }, timeoutMs || 15000)
      return fetch(url, controller === null ? undefined : { signal: controller.signal })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status)
          return res.json()
        })
        .then(function (body) {
          if (body && body.ok === false) throw new Error(body.error || '服务端返回失败')
          return body
        })
        .finally(function () { if (timer !== null) clearTimeout(timer) })
    }

    // ───────────────────────── 直方图 ─────────────────────────

    /**
     * 堆叠直方图：每根柱子 = 命中缓存输入 / 未命中输入 / 输出。
     * 高度按「当前区间最大值」归一，因此不看绝对量级也能看出形状；
     * 总量为 0 的桶画一条 2px 底线，保持 24 格的节奏感。
     */
    function Histogram(props) {
      var buckets = props.buckets || []
      var dim = props.dim || 'hour'
      var hovered = props.hovered
      var onHover = props.onHover
      var totalOf = function (b) { return b.cr + b.ci + b.out }
      var max = 0
      for (var i = 0; i < buckets.length; i += 1) max = Math.max(max, totalOf(buckets[i]))
      var cls = props.compact === true ? 'tm-chart' : 'tm-hist'
      var colCls = props.compact === true ? 'tm-bar' : 'tm-hist-col'

      return jsx.jsxs('div', {
        children: [
          jsx.jsx('div', {
            className: cls,
            children: buckets.map(function (bucket, index) {
              var total = totalOf(bucket)
              var has = total > 0
              var heightPct = function (value) {
                if (max <= 0) return 0
                return (value / max) * 100
              }
              return jsx.jsxs('div', {
                className: colCls + (hovered === index ? ' ' + (props.compact === true ? 'tm-bar-on' : 'tm-hist-col-on') : ''),
                onMouseEnter: function () { onHover(index) },
                onMouseLeave: function () { onHover(-1) },
                title: bucketFullLabel(bucket.key || bucket.hourLabel, dim) + '\n命中缓存 ' + fmtFull(bucket.cr)
                  + ' · 未命中 ' + fmtFull(bucket.ci) + ' · 输出 ' + fmtFull(bucket.out),
                children: has
                  ? [
                    jsx.jsx('span', { style: { height: heightPct(bucket.out) + '%', background: COLORS.output, marginBottom: '1px' } }, 'out'),
                    jsx.jsx('span', { style: { height: heightPct(bucket.ci) + '%', background: COLORS.uncached, marginBottom: '1px' } }, 'ci'),
                    jsx.jsx('span', { style: { height: heightPct(bucket.cr) + '%', background: COLORS.cacheRead } }, 'cr'),
                  ]
                  : jsx.jsx('span', { className: 'tm-bar-empty' }),
              }, String(bucket.key || bucket.hour || index))
            }),
          }),
          props.showAxis === false ? null : jsx.jsx('div', {
            className: 'tm-hist-axis',
            children: buckets.map(function (bucket, index) {
              // 只在首尾与每 N 格标注，避免挤成一团。
              var step = buckets.length > 16 ? Math.ceil(buckets.length / 8) : (buckets.length > 8 ? 3 : 4)
              var label = (index === 0 || index === buckets.length - 1 || index % step === 0)
                ? bucketLabel(bucket.key || String(bucket.hour).padStart(2, '0'), bucket.key === undefined ? 'hour' : dim)
                : ''
              return jsx.jsx('div', { children: label }, 'ax' + index)
            }),
          }),
        ],
      })
    }

    /** 图例：显示区间合计或悬浮桶的即时数值。 */
    function Legend(props) {
      var value = props.value
      var items = [
        { key: 'cacheRead', label: '输入（命中缓存）', color: COLORS.cacheRead, n: value.cr },
        { key: 'uncached', label: '输入（未命中缓存）', color: COLORS.uncached, n: value.ci },
        { key: 'output', label: '输出', color: COLORS.output, n: value.out },
      ]
      return jsx.jsx('div', {
        className: 'tm-legend',
        children: items.map(function (item) {
          return jsx.jsx('div', {
            className: 'tm-legend-item',
            children: [
              jsx.jsx('i', { className: 'tm-swatch', style: { background: item.color } }),
              jsx.jsx('span', { children: item.label }),
              jsx.jsx('b', { children: fmtCompact(item.n) }),
            ],
          }, item.key)
        }),
      })
    }

    // ───────────────────────── 小窗口 ─────────────────────────

    // ───────────────────────── 浮窗锚定与状态 ─────────────────────────

    /** localStorage 键：最小化状态与拖拽后的位置（刷新后保留）。 */
    var LS_MIN = 'dsh-token-monitor:minimized'
    var LS_POS = 'dsh-token-monitor:pos'

    function readLS(key, fallback) {
      try {
        var raw = window.localStorage.getItem(key)
        return raw === null ? fallback : raw
      } catch { return fallback }
    }

    function writeLS(key, value) {
      try { window.localStorage.setItem(key, value) } catch { /* 隐私模式下写不了，忽略 */ }
    }

    /**
     * 测量锚点：把浮窗放到「会话列表下方、侧栏页脚上方」。
     *
     * 为什么不写死坐标：侧边栏宽度可调、可收起，页脚高度随 Cordis Plugin 等条目变化，
     * 写死任何一个都会在别人机器上错位。这里实时量 .sidebar 与页脚容器的矩形。
     *
     * @returns {{left:number, width:number, bottom:number}} 视口坐标下的锚点
     */
    function measureAnchor() {
      var vw = window.innerWidth
      var vh = window.innerHeight
      var sidebar = document.querySelector('[class*="sidebar"]')
      if (sidebar === null) sidebar = document.querySelector('nav')
      var rect = sidebar === null ? null : sidebar.getBoundingClientRect()
      var footer = document.querySelector('[class*="footArea"]')
      var footerTop = footer === null ? null : footer.getBoundingClientRect().top
      // 收起成窄栏时宽度很小，此时浮窗按窄形态排布
      var width = rect === null || rect.width < 8 ? 224 : Math.max(180, Math.min(rect.width - 16, 320))
      return {
        left: rect === null ? 12 : Math.max(8, rect.left + 8),
        width: width,
        bottom: footerTop === null ? 96 : Math.max(24, vh - footerTop + 8),
      }
    }

    /**
     * 浮窗。数据每 POLL_MS 拉一次，并在窗口聚焦时补一次。
     * 右上角【最小化】收成胶囊，点胶囊还原；头部可拖动，位置记在 localStorage。
     *
     * @param props.owner 由 shell.overlay 传入（该槽位 owner 为空对象）
     */
    function TokenMonitorWidget(props) {
      var [anchor, setAnchor] = React.useState(measureAnchor)
      var [pos, setPos] = React.useState(function () {
        var raw = readLS(LS_POS, '')
        if (raw === '') return null
        try {
          var parsed = JSON.parse(raw)
          return (typeof parsed.left === 'number' && typeof parsed.top === 'number') ? parsed : null
        } catch { return null }
      })
      var [minimized, setMinimized] = React.useState(function () { return readLS(LS_MIN, '0') === '1' })
      var dragRef = React.useRef(null)

      React.useEffect(function () { ensureStyle() }, [])

      // 锚点跟随：侧栏宽度变化 / 页脚高度变化 / 窗口尺寸变化都要重新量。
      React.useEffect(function () {
        var update = function () { setAnchor(measureAnchor()) }
        update()
        window.addEventListener('resize', update)
        var observers = []
        if (typeof ResizeObserver === 'function') {
          for (var node of [document.querySelector('[class*="sidebar"]'), document.querySelector('[class*="footArea"]')]) {
            if (node !== null) {
              var ro = new ResizeObserver(update)
              ro.observe(node)
              observers.push(ro)
            }
          }
        }
        return function () {
          window.removeEventListener('resize', update)
          for (var ro of observers) ro.disconnect()
        }
      }, [])

      var [state, setState] = React.useState({ status: 'loading', data: null, error: null })
      var [hovered, setHovered] = React.useState(-1)
      var [dialogOpen, setDialogOpen] = React.useState(false)

      React.useEffect(function () {
        var alive = true
        function load() {
          getJson(API_OVERVIEW)
            .then(function (data) { if (alive) setState({ status: 'ready', data: data, error: null }) })
            .catch(function (error) {
              if (alive) setState(function (prev) {
                // 已有数据时保留旧数据，只标记错误，避免小窗口闪烁成空。
                return { status: prev.data === null ? 'error' : 'stale', data: prev.data, error: String(error && error.message || error) }
              })
            })
        }
        load()
        var timer = setInterval(load, POLL_MS)
        function onFocus() { load() }
        window.addEventListener('focus', onFocus)
        return function () {
          alive = false
          clearInterval(timer)
          window.removeEventListener('focus', onFocus)
        }
      }, [])

      var data = state.data
      var models = (data && data.models) || []
      var totals = (data && data.totals) || { cr: 0, ci: 0, out: 0, total: 0, requests: 0 }
      var buckets = (data && data.buckets) || []
      var currency = currencyOf(data)
      var errorMessage = state.error

      // 侧栏只有 96px 给名字，provider 前缀（deepseek-official/）会把它挤成 "deepseek-o…"，
      // 所以只显示末段；完整 provider/model 放在 title 里。
      var modelName = models.length === 0
        ? (state.status === 'loading' ? '读取中…' : '今日暂无用量')
        : String(models[0].key).split('/').pop()
      var hoveredBucket = hovered >= 0 && hovered < buckets.length ? buckets[hovered] : null
      var legendValue = hoveredBucket === null
        ? totals
        : { cr: hoveredBucket.cr, ci: hoveredBucket.ci, out: hoveredBucket.out }

      /** 最小化/还原，状态记在 localStorage（刷新后保持用户选择）。 */
      function toggleMinimized() {
        setMinimized(function (prev) {
          writeLS(LS_MIN, prev ? '0' : '1')
          return !prev
        })
      }

      /**
       * 头部拖动。用 mouse 事件而不是 pointer 事件：
       * 实测 React 的 onPointerDown 在无头 Chromium 下不触发（拖动完全失效），
       * mouse 系列最稳；顺带在拖动时给 body 加 cursor/禁用选中。
       */
      function onHeadMouseDown(event) {
        if (event.button !== 0) return
        if (event.target && event.target.closest && event.target.closest('button') !== null) return
        var el = event.currentTarget.parentElement
        if (el === null) return
        var rect = el.getBoundingClientRect()
        dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, moved: false }
        document.body.style.userSelect = 'none'
        event.preventDefault()
      }

      function onHeadDoubleClick() { resetPosition() }

      // 拖动期间把 move/up 挂在 window 上：指针滑出头部也不会丢事件。
      React.useEffect(function () {
        function onMove(event) {
          var drag = dragRef.current
          if (drag === null) return
          var width = event.clientX - drag.dx
          var height = event.clientY - drag.dy
          drag.moved = true
          setPos({
            left: Math.max(4, Math.min(width, window.innerWidth - 80)),
            top: Math.max(4, Math.min(height, window.innerHeight - 40)),
          })
        }
        function onUp() {
          if (dragRef.current === null) return
          var moved = dragRef.current.moved
          dragRef.current = null
          document.body.style.userSelect = ''
          if (moved) {
            setPos(function (current) {
              if (current !== null) writeLS(LS_POS, JSON.stringify(current))
              return current
            })
          }
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
        return function () {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
          document.body.style.userSelect = ''
        }
      }, [])

      /** 回到默认锚点（会话列表下方、页脚上方）。 */
      function resetPosition() {
        writeLS(LS_POS, '')
        setPos(null)
      }

      // 拖过就用用户坐标，否则锚定在侧栏页脚上方（bottom 定位，高度自适应）。
      //
      // position/z-index 也走 inline，而不是只靠注入的 CSS：样式表万一缺失（注入失败、
      // 被外部清理），fixed 定位仍然成立，浮窗最坏只是「没皮肤」，绝不会掉进 shell.overlay
      // 的正常流去压住侧栏会话列表（那正是用户截图里的故障形态）。
      var PIN = { position: 'fixed', zIndex: 30 }
      var floatStyle = pos === null
        ? { position: PIN.position, zIndex: PIN.zIndex, left: anchor.left + 'px', width: anchor.width + 'px', bottom: anchor.bottom + 'px' }
        : { position: PIN.position, zIndex: PIN.zIndex, left: pos.left + 'px', width: anchor.width + 'px', top: pos.top + 'px' }

      if (minimized) {
        return jsx.jsxs('div', {
          className: 'tm-pill',
          style: {
            position: PIN.position,
            zIndex: PIN.zIndex,
            left: floatStyle.left,
            bottom: pos === null ? floatStyle.bottom : undefined,
            top: pos === null ? undefined : floatStyle.top,
          },
          role: 'button',
          tabIndex: 0,
          title: '展开 Token 用量监测',
          onClick: toggleMinimized,
          children: [
            jsx.jsx(IconDataOutline16, { size: 14 }),
            jsx.jsx('span', { className: 'tm-pill-total', children: fmtZh(totals.total) }),
            jsx.jsx('span', { className: 'tm-pill-money', children: fmtMoney(totals.cost, currency) }),
          ],
        })
      }

      var floatNode = jsx.jsxs('div', {
        className: 'tm-float',
        style: floatStyle,
        children: [
          jsx.jsxs('div', {
            className: 'tm-float-head',
            onMouseDown: onHeadMouseDown,
            onDoubleClick: onHeadDoubleClick,
            title: '拖动可移动，双击回到默认位置',
            children: [
              jsx.jsx('div', {
                className: 'tm-title',
                children: jsx.jsx('span', {
                  className: 'tm-model' + (models.length === 0 ? ' tm-model-dim' : ''),
                  title: models.map(function (m) { return m.key + ' · ' + fmtFull(m.total) }).join('\n') || modelName,
                  children: modelName,
                }),
              }),
              jsx.jsx('div', {
                className: 'tm-head-actions',
                children: [
                  state.status === 'stale'
                    ? jsx.jsx('span', { className: 'tm-error', title: errorMessage, children: '离线' })
                    : null,
                  jsx.jsx('button', {
                    type: 'button', className: 'tm-btn',
                    onClick: function () { setDialogOpen(true) },
                    title: '打开用量日志',
                    children: '日志',
                  }),
                  jsx.jsx('button', {
                    type: 'button', className: 'tm-float-icon',
                    onClick: toggleMinimized,
                    title: '最小化',
                    'aria-label': '最小化',
                    children: '—',
                  }),
                ],
              }),
            ],
          }),
          jsx.jsxs('div', {
            className: 'tm-float-body',
            children: [
          jsx.jsxs('div', {
            className: 'tm-total',
            children: [
              jsx.jsx('span', { className: 'tm-total-value', children: fmtZh(totals.total) }),
              jsx.jsx('span', { className: 'tm-total-label', children: '今日总量' }),
              totals.requests > 0
                ? jsx.jsx('span', { className: 'tm-total-label', children: '· ' + fmtCompact(totals.requests) + ' 次请求' })
                : null,
            ],
          }),

          /* 花费与余额：余额取不到时显示"—"并说明原因，绝不用 0 冒充（0 会被读成"没钱了"）。 */
          jsx.jsxs('div', {
            className: 'tm-money',
            children: [
              jsx.jsxs('span', {
                className: 'tm-money-item',
                title: '今日花费（按官方价目表逐条计价，峰谷单价不同）'
                  + (data && data.cost ? '\n高峰 ' + fmtMoney(data.cost.peak.cost) + ' · 空闲 ' + fmtMoney(data.cost.offPeak.cost) : ''),
                children: [
                  jsx.jsx('span', { className: 'tm-money-value', children: fmtMoney(totals.cost, currency) }),
                  jsx.jsx('span', { className: 'tm-money-label', children: '今日花费' }),
                ],
              }),
              jsx.jsxs('span', {
                className: 'tm-money-item',
                title: balanceTitle(data && data.balance),
                children: [
                  jsx.jsx('span', {
                    className: 'tm-money-value' + (balanceKnown(data && data.balance) ? '' : ' tm-money-dim'),
                    children: balanceKnown(data && data.balance)
                      ? fmtMoney(data.balance.total, data.balance.currency)
                      : '—',
                  }),
                  jsx.jsx('span', { className: 'tm-money-label', children: '余额' }),
                ],
              }),
              data && data.balance && data.balance.ok === true && data.balance.available === false
                ? jsx.jsx('span', { className: 'tm-money-warn', title: '账户余额不足，API 将拒绝请求', children: '余额不足' })
                : null,
            ],
          }),

          /* 峰谷时段带（直方图上方）：高峰深蓝 / 空闲浅蓝。 */
          jsx.jsx(PeakBand, { buckets: buckets, hours: 24 }),

          jsx.jsx(Histogram, {
            buckets: buckets,
            dim: 'hour',
            compact: true,
            hovered: hovered,
            onHover: setHovered,
            showAxis: false,
          }),

          jsx.jsx('div', { className: 'tm-axis', children: [
            jsx.jsx('span', { children: '00:00' }),
            jsx.jsx('span', { children: '12:00' }),
            jsx.jsx('span', { children: '23:00' }),
          ] }),

              jsx.jsx(Legend, { value: legendValue }),

              jsx.jsx('div', {
                className: 'tm-hint',
                children: hoveredBucket === null
                  ? (state.status === 'loading' ? '正在读取会话日志…' : '悬停柱子看该小时明细')
                  : bucketFullLabel(hoveredBucket.key === undefined ? String(hoveredBucket.hour).padStart(2, '0') : hoveredBucket.key, 'hour')
                    + ' · 合计 ' + fmtFull(hoveredBucket.total),
              }),
            ],
          }),
        ],
      })

      // 弹窗是 body 级 portal，与浮窗并列返回（Fragment），保证它盖在浮窗之上。
      // 用 React.Fragment（Element 2）而不是 jsx-runtime 的 Fragment 字符串：
      // 前者是 {type: Symbol(react.fragment), props:{children}}，测试可以像展开普通组件一样展开它。
      return jsx.jsxs(React.Fragment, {
        children: [
          floatNode,
          dialogOpen ? jsx.jsx(LogDialog, { onClose: function () { setDialogOpen(false) } }) : null,
        ],
      })
    }

    // ───────────────────────── 日志弹窗 ─────────────────────────

    var PRESETS = [
      { key: 'today', label: '今日' },
      { key: 'week', label: '近一周' },
      { key: 'month', label: '近一月' },
      { key: 'custom', label: '自定义' },
    ]

    /**
     * 用量日志弹窗：区间总量 / 时间分布 / 模型分布 / 会话明细 / 健康度。
     * 所有数字都来自同一次请求的同一份记录集（宿主保证三种分组合计相等）。
     */
    function LogDialog(props) {
      var [period, setPeriod] = React.useState('today')
      var today = shanghaiToday(480)
      var [start, setStart] = React.useState(shiftDateString(today, -6))
      var [end, setEnd] = React.useState(today)
      var [view, setView] = React.useState('conversation')
      var [state, setState] = React.useState({ status: 'loading', data: null, error: null })
      var [hovered, setHovered] = React.useState(-1)
      var [page, setPage] = React.useState(0)
      var [tick, setTick] = React.useState(0)

      React.useEffect(function () { ensureStyle() }, [])

      var query = (function () {
        var parts = ['period=' + encodeURIComponent(period), 'view=' + encodeURIComponent(view)]
        if (period === 'custom') {
          parts.push('start=' + encodeURIComponent(start))
          parts.push('end=' + encodeURIComponent(end))
        }
        return parts.join('&')
      })()

      React.useEffect(function () {
        var alive = true
        setState(function (prev) { return { status: prev.data === null ? 'loading' : 'refreshing', data: prev.data, error: null } })
        getJson(API_LOG + '?' + query)
          .then(function (data) { if (alive) setState({ status: 'ready', data: data, error: null }) })
          .catch(function (error) {
            if (alive) setState(function (prev) { return { status: 'error', data: prev.data, error: String(error && error.message || error) } })
          })
        return function () { alive = false }
      }, [query, tick])

      React.useEffect(function () { setPage(0); setHovered(-1) }, [query])

      var data = state.data
      var totals = (data && data.totals) || { cr: 0, ci: 0, out: 0, total: 0, requests: 0 }
      var dim = (data && data.dim) || 'hour'
      // 时间轴必须**连续**：宿主只返回"有用的桶"，空白日期会缺格，坐标轴上 09-19 后面直接跟
      // 09-22，两天间隔被压成相邻，看上去像"每天都在用"（用户截图反馈）。这里按区间补齐空格。
      var buckets = fillBuckets((data && data.buckets) || [], dim, data && data.range)
      var models = (data && data.models) || []
      var conversations = (data && data.conversations) || []
      var health = (data && data.health) || null
      // 顶层 cost 缺失时（旧版宿主），用 totals.cost 重建，避免出现
      // 「顶部花费卡显示未启用计价、而模型分布显示真实金额」这种自相矛盾。
      var cost = (data && data.cost) || null
      if (cost === null && data && data.totals && typeof data.totals.cost === 'number' && data.totals.cost > 0) {
        cost = { cost: data.totals.cost, peak: { cost: 0, requests: 0, tokens: 0 }, offPeak: { cost: 0, requests: 0, tokens: 0 }, unmatchedModels: [], derived: true }
      }
      var currency = currencyOf(data)
      var hoveredBucket = hovered >= 0 && hovered < buckets.length ? buckets[hovered] : null

      var rows = view === 'conversation'
        ? conversations
        : models.map(function (model) {
          return {
            id: model.key,
            title: model.key,
            models: [model.key],
            workspaceLabel: null,
            totals: model,
            synthetic: true,
          }
        })
      var pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
      var safePage = Math.min(page, pageCount - 1)
      var pageRows = rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

      var rangeText = data === null
        ? ''
        : (data.range.start === data.range.end ? data.range.start : data.range.start + ' → ' + data.range.end)
          + ' · 上海时区'

      return jsx.jsx(Modal, {
        open: true,
        onClose: props.onClose,
        // headless：自绘标题栏；className 用来把卡片宽度从 380px 拿回来
        headless: true,
        title: 'Token 用量日志',
        className: 'tm-modal',
        children: jsx.jsxs('div', {
          className: 'tm-dialog',
          children: [
            jsx.jsxs('div', {
              className: 'tm-dialog-head',
              children: [
                jsx.jsx('div', {
                  children: [
                    jsx.jsx('h2', { className: 'tm-dialog-title', children: 'Token 用量日志' }),
                    jsx.jsx('p', { className: 'tm-dialog-desc', children: '按模型与时间统计的会话用量，数据来自本机会话日志' }),
                  ],
                }),
                jsx.jsx('button', {
                  type: 'button',
                  className: 'tm-dialog-close',
                  onClick: props.onClose,
                  'aria-label': '关闭',
                  title: '关闭',
                  children: jsx.jsx(IconCloseOutline16, { size: 16 }),
                }),
              ],
            }),

            // ── 区间选择 ──
            jsx.jsxs('div', {
              className: 'tm-row tm-row-between',
              children: [
                jsx.jsxs('div', {
                  className: 'tm-row',
                  children: [
                    jsx.jsx('div', {
                      className: 'tm-group',
                      children: PRESETS.map(function (item) {
                        return jsx.jsx('button', {
                          type: 'button',
                          className: 'tm-btn',
                          'aria-pressed': period === item.key ? 'true' : 'false',
                          onClick: function () { setPeriod(item.key) },
                          children: item.label,
                        }, item.key)
                      }),
                    }),
                    period === 'custom'
                      ? jsx.jsxs('div', {
                        className: 'tm-row',
                        children: [
                          jsx.jsx('input', {
                            type: 'date', className: 'tm-date', value: start, max: end,
                            onChange: function (event) { setStart(event.target.value || today) },
                            'aria-label': '起始日期',
                          }),
                          jsx.jsx('span', { className: 'tm-range-text', children: '→' }),
                          jsx.jsx('input', {
                            type: 'date', className: 'tm-date', value: end, min: start,
                            onChange: function (event) { setEnd(event.target.value || today) },
                            'aria-label': '结束日期',
                          }),
                        ],
                      })
                      : jsx.jsx('span', { className: 'tm-range-text', children: rangeText }),
                  ],
                }),
                jsx.jsxs('div', {
                  className: 'tm-row',
                  children: [
                    jsx.jsxs('div', {
                      className: 'tm-group',
                      children: [
                        jsx.jsx('button', {
                          type: 'button', className: 'tm-btn',
                          'aria-pressed': view === 'conversation' ? 'true' : 'false',
                          onClick: function () { setView('conversation') },
                          children: '按对话',
                        }),
                        jsx.jsx('button', {
                          type: 'button', className: 'tm-btn',
                          'aria-pressed': view === 'total' ? 'true' : 'false',
                          onClick: function () { setView('total') },
                          children: '按模型',
                        }),
                      ],
                    }),
                    jsx.jsx('button', {
                      type: 'button',
                      className: 'tm-btn tm-btn-icon',
                      title: '重新读取会话日志',
                      'aria-label': '刷新',
                      disabled: state.status === 'loading' || state.status === 'refreshing',
                      onClick: function () { setTick(function (n) { return n + 1 }) },
                      children: jsx.jsx(IconRefreshOutline14, { size: 14 }),
                    }),
                  ],
                }),
              ],
            }),

            state.status === 'error' && state.data === null
              ? jsx.jsx('div', { className: 'tm-error', children: '读取失败：' + state.error })
              : null,

            // ── 总量卡片 ──
            jsx.jsxs('div', {
              className: 'tm-cards',
              children: [
                card('总用量', fmtZh(totals.total), fmtFull(totals.total) + ' tokens · ' + fmtCompact(totals.requests) + ' 次请求'),
                card('花费', fmtMoney(cost === null ? null : cost.cost, currency),
                  cost === null ? '未启用计价'
                    : cost.derived === true
                      ? '今日累计（峰谷明细见小窗口）'
                      : '高峰 ' + fmtMoney(cost.peak.cost, currency) + ' / 空闲 ' + fmtMoney(cost.offPeak.cost, currency)),
                card('账户余额', balanceKnown(data && data.balance) ? fmtMoney(data.balance.total, data.balance.currency) : '—',
                  balanceKnown(data && data.balance)
                    ? (data.balance.available === false ? '⚠ 余额不足' : '赠送 ' + fmtMoney(data.balance.granted, data.balance.currency))
                    : balanceTitle(data && data.balance)),
                card('输入（命中缓存）', fmtZh(totals.cr), '占输入 ' + fmtPercent(totals.cr + totals.ci > 0 ? totals.cr / (totals.cr + totals.ci) : null), COLORS.cacheRead),
                card('输入（未命中缓存）', fmtZh(totals.ci), '每次请求均 ' + fmtFull(health === null ? 0 : health.avgInputPerRequest) + ' tokens', COLORS.uncached),
                card('输出', fmtZh(totals.out), '每次请求均 ' + fmtFull(health === null ? 0 : health.avgOutputPerRequest) + ' tokens', COLORS.output),
              ],
            }),

            // ── 时间分布 ──
            jsx.jsxs('div', {
              className: 'tm-section',
              children: [
                jsx.jsxs('div', {
                  className: 'tm-section-head',
                  children: [
                    jsx.jsxs('div', {
                      children: [
                        jsx.jsx('div', { className: 'tm-section-title', children: dim === 'hour' ? '每小时用量' : '每日用量' }),
                        jsx.jsx('div', {
                          className: 'tm-section-sub',
                          children: hoveredBucket === null
                            ? rangeText
                            : bucketFullLabel(hoveredBucket.key, dim) + ' · 合计 ' + fmtFull(hoveredBucket.total)
                              + '（命中 ' + fmtFull(hoveredBucket.cr) + ' / 未命中 ' + fmtFull(hoveredBucket.ci) + ' / 输出 ' + fmtFull(hoveredBucket.out) + '）',
                        }),
                      ],
                    }),
                    jsx.jsx(Legend, { value: hoveredBucket === null ? totals : hoveredBucket }),
                  ],
                }),
                buckets.length === 0
                  ? jsx.jsx('div', { className: 'tm-empty', children: '这个区间没有用量记录' })
                  : jsx.jsx(Histogram, { buckets: buckets, dim: dim, hovered: hovered, onHover: setHovered }),
              ],
            }),

            // ── 模型分布 ──
            models.length === 0
              ? null
              : jsx.jsxs('div', {
                className: 'tm-section',
                children: [
                  jsx.jsxs('div', {
                    className: 'tm-section-head',
                    children: [
                      jsx.jsx('div', { className: 'tm-section-title', children: '模型分布' }),
                      jsx.jsx('div', { className: 'tm-section-sub', children: models.length + ' 个模型' }),
                    ],
                  }),
                  jsx.jsx('div', {
                    className: 'tm-dist',
                    children: models.map(function (model) {
                      var pct = totals.total > 0 ? model.total / totals.total : 0
                      return jsx.jsxs('div', {
                        className: 'tm-dist-row',
                        children: [
                          jsx.jsx('span', { className: 'tm-dist-name', title: model.key, children: model.key }),
                          jsx.jsx('span', {
                            className: 'tm-dist-track',
                            children: [
                              jsx.jsx('span', { style: { width: (model.total > 0 ? (model.cr / model.total) * 100 : 0) + '%', background: COLORS.cacheRead } }),
                              jsx.jsx('span', { style: { width: (model.total > 0 ? (model.ci / model.total) * 100 : 0) + '%', background: COLORS.uncached } }),
                              jsx.jsx('span', { style: { width: (model.total > 0 ? (model.out / model.total) * 100 : 0) + '%', background: COLORS.output } }),
                            ],
                          }),
                          jsx.jsx('span', { className: 'tm-dist-value', children: fmtCompact(model.total) }),
                          jsx.jsx('span', { className: 'tm-dist-pct', children: fmtPercent(pct) }),
                          jsx.jsx('span', { className: 'tm-dist-pct', title: '该模型区间花费', children: fmtMoney(model.cost, currency) }),
                        ],
                      }, model.key)
                    }),
                  }),
                ],
              }),

            // ── 明细表 ──
            jsx.jsxs('div', {
              className: 'tm-section',
              children: [
                jsx.jsxs('div', {
                  className: 'tm-section-head',
                  children: [
                    jsx.jsx('div', {
                      className: 'tm-section-title',
                      children: view === 'conversation' ? '按对话' : '按模型',
                    }),
                    jsx.jsx('div', {
                      className: 'tm-section-sub',
                      children: rows.length === 0
                        ? '无记录'
                        : (view === 'conversation' ? rows.length + ' 个对话' : rows.length + ' 个模型')
                          + (pageCount > 1 ? ' · 第 ' + (safePage + 1) + '/' + pageCount + ' 页' : ''),
                    }),
                  ],
                }),
                rows.length === 0
                  ? jsx.jsx('div', { className: 'tm-empty', children: '这个区间没有对话产生用量' })
                  : jsx.jsx('div', {
                    className: 'tm-table-wrap',
                    children: jsx.jsx('table', {
                    className: 'tm-table',
                    children: [
                      jsx.jsx('thead', {
                        children: jsx.jsx('tr', {
                          children: [
                            jsx.jsx('th', { children: view === 'conversation' ? '对话' : '模型' }),
                            jsx.jsx('th', { children: '输入·命中' }),
                            jsx.jsx('th', { children: '输入·未命中' }),
                            jsx.jsx('th', { children: '输出' }),
                            jsx.jsx('th', { children: '合计' }),
                            jsx.jsx('th', { children: '花费' }),
                            jsx.jsx('th', { children: '请求' }),
                          ],
                        }),
                      }),
                      jsx.jsx('tbody', {
                        children: pageRows.map(function (row) {
                          return jsx.jsx('tr', {
                            children: [
                              jsx.jsx('td', {
                                children: jsx.jsx('div', {
                                  className: 'tm-cell-title',
                                  children: [
                                    jsx.jsx('b', { title: row.title || row.id, children: row.title || row.id }),
                                    jsx.jsx('small', {
                                      title: (row.models || []).join(', '),
                                      children: (row.synthetic === true
                                        ? '模型合计'
                                        : (row.workspaceLabel ? row.workspaceLabel + ' · ' : '') + fmtAgo(row.lastMs, data === null ? Date.now() : data.now))
                                        + ' · ' + (row.models || []).map(function (m) { return m.split('/').pop() }).join(', '),
                                    }),
                                  ],
                                }),
                              }),
                              jsx.jsx('td', { children: fmtFull(row.totals.cr) }),
                              jsx.jsx('td', { children: fmtFull(row.totals.ci) }),
                              jsx.jsx('td', { children: fmtFull(row.totals.out) }),
                              jsx.jsx('td', { children: jsx.jsx('b', { children: fmtZh(row.totals.total) }) }),
                              jsx.jsx('td', { children: fmtMoney(row.totals.cost, currency) }),
                              jsx.jsx('td', { children: fmtFull(row.totals.requests) }),
                            ],
                          }, row.id + ':' + (row.title || ''))
                        }),
                      }),
                    ],
                    }),
                  }),
                pageCount > 1
                  ? jsx.jsxs('div', {
                    className: 'tm-row tm-row-between',
                    style: { marginTop: '8px' },
                    children: [
                      jsx.jsx('button', {
                        type: 'button', className: 'tm-btn', disabled: safePage <= 0,
                        onClick: function () { setPage(Math.max(0, safePage - 1)) },
                        children: '上一页',
                      }),
                      jsx.jsx('span', { className: 'tm-range-text', children: (safePage + 1) + ' / ' + pageCount }),
                      jsx.jsx('button', {
                        type: 'button', className: 'tm-btn', disabled: safePage >= pageCount - 1,
                        onClick: function () { setPage(Math.min(pageCount - 1, safePage + 1)) },
                        children: '下一页',
                      }),
                    ],
                  })
                  : null,
              ],
            }),

            // ── 健康度（第一性原理补充项：从同一份记录直接推导，不做估计）──
            health === null
              ? null
              : jsx.jsxs('div', {
                className: 'tm-section',
                children: [
                  jsx.jsx('div', {
                    className: 'tm-section-head',
                    children: [
                      jsx.jsx('div', { className: 'tm-section-title', children: '健康度' }),
                      jsx.jsx('div', {
                        className: 'tm-section-sub',
                        children: '缓存命中率是这套体系里唯一能直接省下输入成本的杠杆',
                      }),
                    ],
                  }),
                  jsx.jsxs('div', {
                    className: 'tm-cards',
                    children: [
                      card('缓存命中率', fmtPercent(health.cacheHitRate), '命中 ' + fmtZh(totals.cr) + ' / 输入 ' + fmtZh(totals.cr + totals.ci)),
                      card('活跃小时', String(health.activeHours), '闲置 ' + fmtFull(health.idleHours) + ' 小时'),
                      card('活跃小时均值', fmtZh(health.avgPerActiveHour), '日均 ' + fmtZh(health.avgPerDay)),
                      card('用量峰值小时', health.peakHour === null ? '—' : bucketLabel(health.peakHour.key, 'hour'), health.peakHour === null ? '无数据' : fmtZh(health.peakHour.total) + ' · ' + fmtFull(health.peakHour.requests) + ' 次请求'),
                      card('最费对话', health.peakConversation === null ? '—' : fmtZh(health.peakConversation.total), health.peakConversation === null ? '无数据' : (health.peakConversation.title || health.peakConversation.id)),
                      card('覆盖会话', fmtFull(health.sessionCount), '共扫描 ' + fmtFull(health.totalSessionsScanned) + ' 个会话日志'),
                    ],
                  }),
                ],
              }),

            // ── 页脚 ──
            jsx.jsxs('div', {
              className: 'tm-foot',
              children: [
                jsx.jsx('span', {
                  children: '统计口径：命中缓存 = cacheReadTokens，未命中 = inputTokens + cacheWriteTokens，输出含 reasoning；时区固定 Asia/Shanghai；'
                    + '花费按官方价目表逐条计价（高峰时段单价 ×2）',
                }),
                jsx.jsx('span', {
                  children: data === null
                    ? ''
                    : (state.status === 'refreshing' ? '刷新中… ' : '')
                      + '采样于 ' + new Date(data.now).toLocaleTimeString('zh-CN', { hour12: false }),
                }),
              ],
            }),

            (cost && cost.unmatchedModels && cost.unmatchedModels.length > 0)
              ? jsx.jsx('div', {
                className: 'tm-money-warn',
                children: '以下模型未登记单价，已按默认价（¥' + '1/百万 未命中）估算：' + cost.unmatchedModels.join(', ')
                  + ' —— 在插件配置 pricing.models 里补上即可精确计费',
              })
              : null,

            (data && data.errors && data.errors.length > 0)
              ? jsx.jsx('div', {
                className: 'tm-error',
                children: '有 ' + data.errors.length + ' 个会话日志读取异常（已跳过，不影响其它会话）：'
                  + data.errors.slice(0, 3).map(function (e) { return String(e.path).split('/').slice(-2).join('/') + ' — ' + e.message }).join('；'),
              })
              : null,
          ],
        }),
      })
    }

    /** 指标卡。 */
    function card(label, value, sub, color) {
      return jsx.jsxs('div', {
        className: 'tm-card',
        children: [
          jsx.jsxs('div', {
            className: 'tm-card-label',
            children: [
              color === undefined ? null : jsx.jsx('i', { className: 'tm-swatch', style: { background: color } }),
              jsx.jsx('span', { children: label }),
            ],
          }),
          jsx.jsx('div', { className: 'tm-card-value', children: value }),
          sub === undefined || sub === null ? null : jsx.jsx('div', { className: 'tm-card-sub', children: sub }),
        ],
      })
    }

    // ───────────────────────── 注册 ─────────────────────────

    /** 需要 ctx.slots 才能注册；数据全部走同源 HTTP，不依赖其它客户端服务。 */
    var inject = ['slots']

    function apply(ctx) {
      // 皮肤先落地：apply 一跑就有样式，不等任何一次 React 挂载；同时挂上自愈观察器，
      // 让样式表在运行期被任何外力删除后都能立刻回来（用户遇到的就是「被删了没人补」）。
      ctx.effect(function () {
        ensureStyle()
        var observer = watchStyle()
        return function () { if (observer !== null) observer.disconnect() }
      }, 'token-monitor: skin stylesheet')

      ctx.effect(function () {
        // 注册进 ui-layout 声明的 shell.overlay（全框浮层，list 槽位，可叠加）。
        //
        // 为什么不再用 sidebar.footer.action：那个位置已被其它插件占用（Cordis Plugin 区），
        // 且侧栏底部要按『工作区 → 会话列表 → 本插件 → 页脚』的次序排，
        // 而 footer 槽位只能表达『页脚内的一行』，无法落在会话列表与页脚之间。
        // overlay 层是 pointer-events:none + 直接子元素 auto，正好做浮窗。
        return ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({
            name: 'shell.overlay',
            id: 'token-monitor',
            order: 90,
          }, TokenMonitorWidget)
        })
      }, 'token-monitor: floating window')
    }

    exports.apply = apply
    exports.inject = inject
    // 供无头测试使用（不参与宿主加载路径）
    exports.__internals = {
      PLUGIN_ID: PLUGIN_ID,
      CSS_TAG: CSS_TAG,
      ensureStyle: ensureStyle,
      watchStyle: watchStyle,
      fmtCompact: fmtCompact,
      fmtZh: fmtZh,
      fmtFull: fmtFull,
      fmtPercent: fmtPercent,
      bucketLabel: bucketLabel,
      rangeKeys: rangeKeys,
      fillBuckets: fillBuckets,
      bucketFullLabel: bucketFullLabel,
      fmtAgo: fmtAgo,
      fmtMoney: fmtMoney,
      bandOf: bandOf,
      bandOfKey: bandOfKey,
      shanghaiDayStartMs: shanghaiDayStartMs,
      measureAnchor: measureAnchor,
      readLS: readLS,
      writeLS: writeLS,
      LS_MIN: LS_MIN,
      LS_POS: LS_POS,
      PeakBand: PeakBand,
      shanghaiToday: shanghaiToday,
      shiftDateString: shiftDateString,
      TokenMonitorWidget: TokenMonitorWidget,
      LogDialog: LogDialog,
      Histogram: Histogram,
      API_OVERVIEW: API_OVERVIEW,
      API_LOG: API_LOG,
    }
    return module.exports
  },
})
