// 无头渲染校验：用假 React 直接调用组件函数，检查真实返回的元素树
// （元素树是普通对象：type/className/style/children 都是数据，可以逐项断言）
import { strict as assert } from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 包根目录（从本文件位置推导，克隆到哪都能跑）。 */
const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
import { readFileSync, existsSync } from 'node:fs'

const hooks = { cursor: 0, inject: {}, effects: [] }
global.window = {
  __ModuleLoader__: { load: (reg) => { global.__reg = reg } },
  addEventListener: () => {},
  removeEventListener: () => {},
  innerWidth: 1400,
  innerHeight: 900,
}
installDom()
/**
 * 假浏览器环境：浮窗依赖 window 尺寸、元素矩形、ResizeObserver 与 localStorage。
 * 不给这些，组件在 Node 里会直接抛 "document is not defined"。
 */
const RECTS = { sidebar: { left: 0, top: 0, width: 240, height: 800 }, footArea: { left: 0, top: 700, width: 240, height: 100 } }
const lsStore = new Map()
function installDom() {
  const makeEl = (rect) => ({
    getBoundingClientRect: () => rect,
    style: {}, children: [],
    setPointerCapture() {}, releasePointerCapture() {},
    closest: () => null,
    addEventListener() {}, removeEventListener() {},
  })
  global.document = {
    querySelector: (sel) => {
      if (sel.includes('sidebar')) return RECTS.sidebar === null ? null : makeEl(RECTS.sidebar)
      if (sel.includes('footArea')) return RECTS.footArea === null ? null : makeEl(RECTS.footArea)
      return null
    },
    querySelectorAll: () => [],
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    head: { appendChild() {} },
  }
  global.window.innerWidth = 1400
  global.window.innerHeight = 900
  global.window.localStorage = {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => lsStore.set(k, String(v)),
    removeItem: (k) => lsStore.delete(k),
  }
  global.ResizeObserver = class { observe() {} disconnect() {} }
}

/** Modal 是宿主组件，不做展开（展开会递归进整棵弹窗树之外的东西）。 */
function ModalStub(props) { return { type: 'Modal', props } }

let fetchUrl = null
global.fetch = async (url) => {
  fetchUrl = url
  throw new Error('offline-test')
}

let ReactShim = null
await import(`file://${join(PKG, 'client.js')}`)
const m = global.__reg.factory((spec) => {
  if (spec === 'react') {
    ReactShim = {
      useState: (init) => {
        const index = hooks.cursor++
        // 惰性初始化：React 允许 useState(fn)，替身必须调用它，否则 measureAnchor 之类拿不到值
        const resolved = typeof init === 'function' ? init() : init
        const value = Object.prototype.hasOwnProperty.call(hooks.inject, index) ? hooks.inject[index] : resolved
        return [value, () => {}]
      },
      useRef: (init) => ({ current: init === undefined ? null : init }),
      Fragment: 'Fragment',
      useEffect: (fn) => { hooks.effects.push(fn) },
      createElement: () => null,
    }
    return ReactShim
  }
  if (spec === 'react/jsx-runtime') {
    return { jsx: (type, props, key) => ({ type, props: props || {}, key }), jsxs: (type, props, key) => ({ type, props: props || {}, key, multi: true }), Fragment: 'Fragment' }
  }
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    return {
      Modal: ModalStub,
      IconRefreshOutline14: () => null,
      IconDataOutline16: () => null,
      IconCloseOutline16: () => null,
    }
  }
  throw new Error('unexpected require: ' + spec)
})

const { TokenMonitorWidget, LogDialog, Histogram, measureAnchor } = m.__internals

/**
 * 遍历元素树收集所有节点。
 * 函数组件（本插件自己定义的 Histogram / Legend / LogDialog）必须「展开」——
 * 它们返回的元素才是真正要断言的东西；不展开就只能看到一层壳。
 */
function walk(node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node !== 'object' || depth > 60) return out
  if (Array.isArray(node)) { for (const n of node) walk(n, out, depth); return out }
  out.push(node)
  if (typeof node.type === 'function' && node.type !== ModalStub) {
    walk(node.type(node.props || {}), out, depth + 1)
    return out
  }
  const kids = node.props ? node.props.children : undefined
  if (kids !== undefined) walk(kids, out, depth + 1)
  return out
}
const textOf = (node) => walk(node).map(n => n.props && n.props.children).filter(c => typeof c === 'string').join(' | ')
/** 运行已注册的 effect（拖动/取数这类副作用在真实 React 里挂载后执行）。 */
function runEffects() {
  for (const fn of hooks.effects) if (typeof fn === 'function') fn()
  hooks.effects.length = 0
}

/** 直方图柱子节点（tm-bar / tm-bar tm-bar-on）。 */
const barNodes = (node) => walk(node).filter(n => /^tm-bar(\s|$)/.test(String(n.props && n.props.className)))
const classesOf = (node) => walk(node).map(n => (n.props && n.props.className) || '').join(' ')

let pass = 0, fail = 0
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name) } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message) } }

console.log('== 浮窗：默认锚定形态 ==')
let tree
t('渲染不抛异常，是浮窗外壳', () => {
  hooks.cursor = 0; hooks.inject = {}
  tree = TokenMonitorWidget({})
  // 组件返回 Fragment[浮窗, 弹窗]，取第一个孩子做几何断言
  assert.equal(tree.type, 'Fragment')
  const floatNode = tree.props.children[0]
  assert.equal(floatNode.props.className, 'tm-float', '第一个孩子应是浮窗外壳')
  tree = floatNode
})
t('style 来自实时测量的锚点（侧栏 left/宽 + 页脚上方 bottom）', () => {
  const st = tree.props.style
  assert.equal(st.left, '8px', 'left 应贴侧栏（left+8）')
  assert.equal(st.width, '224px', '宽度应由侧栏宽（240-16）推出')
  // 视口 900，页脚 top=700 → bottom = 900-700+8 = 208
  assert.equal(st.bottom, '208px', 'bottom 应落在页脚上方 8px')
})
t('头部含拖动区，右上角有【日志】与【最小化】', () => {
  const head = walk(tree).find(n => n.props && n.props.className === 'tm-float-head')
  assert.ok(head, '缺少浮窗头部')
  assert.equal(typeof head.props.onMouseDown, 'function', '头部应可拖动（mouse 事件，pointer 在无头 Chromium 下不触发）')
  assert.equal(typeof head.props.onDoubleClick, 'function', '双击应能回到默认位置')
  const buttons = walk(tree).filter(n => n.type === 'button')
  assert.ok(buttons.some(b => b.props.children === '日志'), '缺少日志按钮')
  assert.ok(buttons.some(b => b.props['aria-label'] === '最小化'), '缺少最小化按钮')
})
t('主体含总量、花费行、峰谷带与直方图', () => {
  const cls = classesOf(tree)
  for (const c of ['tm-float-body', 'tm-total', 'tm-money', 'tm-band', 'tm-chart', 'tm-legend', 'tm-hint']) {
    assert.ok(cls.includes(c), '缺少 ' + c)
  }
})
t('加载态不虚构模型名', () => {
  const txt = textOf(tree)
  assert.ok(txt.includes('读取中'), '应显示读取中，实际: ' + txt.slice(0, 120))
  assert.ok(!/deepseek/.test(txt))
})
t('图例三项齐备', () => {
  const txt = textOf(tree)
  for (const label of ['输入（命中缓存）', '输入（未命中缓存）', '输出']) assert.ok(txt.includes(label), '缺少 ' + label)
})
t('轴标注 00:00 / 12:00 / 23:00', () => {
  const txt = textOf(tree)
  assert.ok(txt.includes('00:00') && txt.includes('12:00') && txt.includes('23:00'))
})
t('加载态无柱子、无 NaN', () => {
  assert.equal(barNodes(tree).length, 0)
  assert.ok(!/NaN|undefined/.test(textOf(tree)))
})

console.log('== 浮窗：数据到达后 ==')
const overview = {
  ok: true, now: Date.now(), date: '2026-09-15', tzOffsetMinutes: 480, currency: 'CNY',
  totals: { cr: 104976511, ci: 888728, out: 574407, total: 106439646, requests: 821, cost: 12.34 },
  cost: { cost: 12.34, peak: { cost: 9.7 }, offPeak: { cost: 2.64 }, unmatchedModels: [] },
  models: [{ key: 'deepseek-official/deepseek-flash', cr: 104976511, ci: 888728, out: 574407, total: 106439646, requests: 821, cost: 12.34 }],
  currentModel: 'deepseek-official/deepseek-flash',
  buckets: Array.from({ length: 24 }, (_, hour) => hour === 13
    ? { hour, cr: 25804671, ci: 70912, out: 127167, total: 26002750, requests: 134, cost: 1.2, band: 1 }
    : { hour, cr: 0, ci: 0, out: 0, total: 0, requests: 0, cost: 0, band: hour >= 9 && hour < 12 ? 2 : 1 }),
  balance: { ok: true, available: true, currency: 'CNY', total: 36.56, granted: 0, toppedUp: 36.56 },
  errors: [],
}
/**
 * 带数据渲染。useState 的顺序是：0=anchor 1=pos 2=minimized 3=state 4=hovered 5=dialogOpen。
 * 注意：惰性初始化（useState(fn)）会在注入生效【之前】被求值，所以每次都要调用两次——
 * 第一次让假 React 把 init 函数调完，第二次真的注入 ready 数据。
 */
const withData = (overrides) => {
  hooks.cursor = 0
  hooks.inject = {}
  TokenMonitorWidget({})
  hooks.cursor = 0
  hooks.inject = Object.assign({ 3: { status: 'ready', data: overview, error: null } }, overrides || {})
  const el = TokenMonitorWidget({})
  hooks.inject = {}
  return el
}
t('显示模型名末段 + 今日总量 + 花费 + 余额', () => {
  const el = withData()
  const txt = textOf(el)
  assert.ok(txt.includes('deepseek-flash'), '缺模型名: ' + txt.slice(0, 160))
  assert.ok(txt.includes('1.1亿'), '缺总量: ' + txt.slice(0, 160))
  assert.ok(txt.includes('今日花费'), '缺花费标签')
  assert.ok(/¥12\.3/.test(txt), '缺花费金额: ' + txt.slice(0, 200))
  assert.ok(txt.includes('余额'), '缺余额标签')
  assert.ok(/¥36\.56/.test(txt), '缺余额金额: ' + txt.slice(0, 200))
  assert.ok(!/NaN|undefined/.test(txt))
})
t('24 根柱子 + 24 格峰谷带，且峰谷都有', () => {
  const el = withData()
  assert.equal(barNodes(el).length, 24)
  const band = walk(el).filter(n => n.props && typeof n.props.className === 'string' && n.props.className === 'tm-band-cell')
  assert.equal(band.length, 24, '峰谷带应 24 格')
  const bands = new Set(band.map(b => b.props['data-band']))
  assert.ok(bands.has(1) && bands.has(2), '峰谷两种取值都应有，实际: ' + [...bands].join(','))
})
t('余额取不到时显示「—」并用悬浮说明原因，不用 0 冒充', () => {
  const noKey = Object.assign({}, overview, { balance: { ok: false, reason: 'no-key' } })
  const el = withData({ 3: { status: 'ready', data: noKey, error: null } })
  const txt = textOf(el)
  assert.ok(txt.includes('—'), '应显示占位符 —，实际: ' + txt.slice(0, 200))
  const withTitle = walk(el).filter(n => n.props && typeof n.props.title === 'string' && n.props.title.includes('余额不可用'))
  assert.ok(withTitle.length > 0, '悬浮应写明余额不可用的原因')
})

console.log('== 浮窗：最小化 ==')
t('最小化后渲染胶囊（图标 + 总量 + 花费），不再是浮窗', () => {
  const pill = withData({ 2: true })
  assert.equal(pill.props.className, 'tm-pill')
  assert.equal(typeof pill.props.onClick, 'function', '点胶囊应能还原')
  const txt = textOf(pill)
  assert.ok(txt.includes('1.1亿'), '胶囊应显示总量')
  assert.ok(/¥12\.3/.test(txt), '胶囊应显示花费')
})
t('点击最小化会写 localStorage（刷新后保持用户选择）', () => {
  lsStore.clear()
  // 这一次让 setState 真的执行更新回调 —— 持久化发生在回调里，
  // 无条件执行的替身会让这个断言变成"看代码猜"，必须让它真跑。
  const realUseState = ReactShim.useState
  ReactShim.useState = (init) => {
    const index = hooks.cursor++
    const resolved = typeof init === 'function' ? init() : init
    const value = Object.prototype.hasOwnProperty.call(hooks.inject, index) ? hooks.inject[index] : resolved
    return [value, (updater) => {
      const next = typeof updater === 'function' ? updater(value) : updater
      if (index === 2) lsStore.set('dsh-token-monitor:minimized', next ? '1' : '0')
    }]
  }
  try {
    hooks.cursor = 0; hooks.inject = {}
    TokenMonitorWidget({})
    hooks.cursor = 0
    hooks.inject = { 3: { status: 'ready', data: overview, error: null } }
    const el = TokenMonitorWidget({})
    const minBtn = walk(el).filter(n => n.type === 'button').find(b => b.props['aria-label'] === '最小化')
    minBtn.props.onClick()
    assert.equal(lsStore.get('dsh-token-monitor:minimized'), '1', '应写入 1（已最小化）')
  } finally {
    ReactShim.useState = realUseState
    hooks.inject = {}
  }
})

console.log('== 锚点测量（不写死坐标，随侧栏/页脚变化）==')
t('侧栏变宽 → 浮窗跟着变宽；页脚变高 → bottom 跟着变', () => {
  const before = measureAnchor()
  RECTS.sidebar.width = 320
  RECTS.footArea.top = 600
  const after = measureAnchor()
  assert.ok(after.width > before.width, `宽度应随侧栏增大: ${before.width} → ${after.width}`)
  assert.ok(after.bottom > before.bottom, `页脚上移后 bottom 应变大: ${before.bottom} → ${after.bottom}`)
  RECTS.sidebar.width = 240
  RECTS.footArea.top = 700
})
t('量不到侧栏/页脚时不崩，退化为安全默认值', () => {
  const keepSidebar = RECTS.sidebar, keepFooter = RECTS.footArea
  RECTS.sidebar = null; RECTS.footArea = null
  const a = measureAnchor()
  assert.ok(a.left >= 8 && a.width >= 180 && a.bottom >= 24, JSON.stringify(a))
  RECTS.sidebar = keepSidebar; RECTS.footArea = keepFooter
})

console.log('== 直方图：数据归一与边界 ==')
t('有数据的桶按最大值归一（最高柱=100%）', () => {
  hooks.cursor = 0; hooks.inject = {}
  const h = Histogram({
    buckets: [{ key: 'a', cr: 10, ci: 0, out: 0 }, { key: 'b', cr: 0, ci: 0, out: 20 }],
    dim: 'hour', hovered: -1, onHover: () => {},
  })
  const spans = walk(h).filter(n => n.props && n.props.style && typeof n.props.style.height === 'string' && n.props.style.height.endsWith('%'))
  const heights = spans.map(s => s.props.style.height)
  assert.ok(heights.includes('100%'), '应有一根达到 100%，实际: ' + heights.join(','))
  assert.ok(heights.includes('50%'), '20:10 的比例应产生 50%，实际: ' + heights.join(','))
})
t('全 0 数据不产生 NaN 高度，且绘制底线', () => {
  const h = Histogram({ buckets: [{ key: 'a', cr: 0, ci: 0, out: 0 }], dim: 'hour', hovered: -1, onHover: () => {} })
  const spans = walk(h).filter(n => n.props && n.props.style && typeof n.props.style.height === 'string')
  for (const s of spans) assert.ok(!String(s.props.style.height).includes('NaN'), '出现 NaN 高度')
  assert.ok(classesOf(h).includes('tm-bar-empty'), '空桶应画底线')
})
t('空 buckets 数组不崩', () => {
  const h = Histogram({ buckets: [], dim: 'hour', hovered: -1, onHover: () => {} })
  assert.ok(h)
})
t('hovered 越界（-1 / 超大）不崩且不误标', () => {
  const buckets = [{ key: 'a', cr: 1, ci: 0, out: 0 }]
  const a = Histogram({ buckets, dim: 'hour', hovered: -1, onHover: () => {} })
  const b = Histogram({ buckets, dim: 'hour', hovered: 99, onHover: () => {} })
  assert.ok(!classesOf(a).includes('tm-bar-on'))
  assert.ok(!classesOf(b).includes('tm-bar-on'))
})

console.log('== 日志弹窗 ==')
t('弹窗渲染不抛异常，含区间/视图切换与口径说明', () => {
  hooks.cursor = 0; hooks.inject = {}
  const d = LogDialog({ onClose: () => {} })
  assert.equal(typeof d.type, 'function') // 假 Modal 是个函数组件
  assert.equal(d.props.open, true)
  assert.equal(typeof d.props.onClose, 'function')
  assert.equal(d.props.headless, true, '必须用 headless 自定卡片宽度（Modal 默认 380px 会压扁宽表）')
  assert.equal(d.props.className, 'tm-modal', '必须把加宽类名透给 Modal 卡片（className 是唯一入口）')
  const txt = textOf(d)
  for (const label of ['今日', '近一周', '近一月', '自定义', '按对话', '按模型']) assert.ok(txt.includes(label), '缺少控件: ' + label)
  assert.ok(txt.includes('Asia/Shanghai'), '必须写明固定时区口径')
  assert.ok(!/NaN|undefined/.test(txt), '弹窗不得出现 NaN/undefined：' + txt.slice(0, 200))
})
t('弹窗加载态不虚构数据（总量为 0）', () => {
  hooks.cursor = 0; hooks.inject = {}
  const txt = textOf(LogDialog({ onClose: () => {} }))
  assert.ok(txt.includes('总用量'), txt.slice(0, 120))
  assert.ok(!/deepseek/.test(txt), '加载中不得出现模型名')
})
t('自定义区间模式下出现两个 date 输入', () => {
  hooks.cursor = 0
  // LogDialog 的第 0 个钩子就是 period
  hooks.inject = { 0: 'custom' }
  const d = LogDialog({ onClose: () => {} })
  hooks.inject = {}
  const dates = walk(d).filter(n => n.type === 'input' && n.props && n.props.type === 'date')
  assert.equal(dates.length, 2, '应有起止两个日期输入，实际 ' + dates.length)
  for (const input of dates) assert.ok(typeof input.props['aria-label'] === 'string', 'date 输入需要 aria-label')
})

console.log('== 轮询与副作用契约 ==')
t('挂载后会注册轮询定时器，并在卸载时清理', () => {
  let intervalFn = null, cleared = null, focusAdded = false, focusRemoved = false
  const realSetInterval = global.setInterval
  const realClearInterval = global.clearInterval
  global.setInterval = (fn) => { intervalFn = fn; return 42 }
  global.clearInterval = (id) => { cleared = id }
  global.window.addEventListener = (type) => { if (type === 'focus') focusAdded = true }
  global.window.removeEventListener = (type) => { if (type === 'focus') focusRemoved = true }
  hooks.cursor = 0; hooks.inject = {}
  hooks.effects.length = 0
  TokenMonitorWidget({ wide: true })
  // 第 2 个 effect 是取数 effect（第 1 个是 ensureStyle）
  const dataEffect = hooks.effects.find(fn => typeof fn === 'function' && fn.toString().includes('API_OVERVIEW'))
  assert.ok(typeof dataEffect === 'function', '应有取数 effect')
  const cleanup = dataEffect()
  assert.equal(typeof intervalFn, 'function', '应注册轮询')
  assert.equal(typeof cleanup, 'function', '应返回清理函数')
  cleanup()
  assert.equal(cleared, 42, '卸载必须清掉定时器，否则弹窗反复开关会泄漏')
  assert.ok(focusAdded && focusRemoved, 'focus 监听必须成对')
  global.setInterval = realSetInterval
  global.clearInterval = realClearInterval
})
t('取数命中宿主约定的 URL（与 index.js 的 OVERVIEW_PATH 一致）', () => {
  assert.equal(fetchUrl, '/plugin-api/token-monitor/overview')
})
t('ensureStyle 幂等：CSS 只注入一次', () => {
  const injected = []
  global.document = {
    head: { appendChild: (tag) => injected.push(tag) },
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    querySelector: () => (injected.length > 0 ? {} : null),
  }
  // 重新加载模块以获得干净的样式状态
  return import(`file://${join(PKG, 'client.js')}?v=` + Date.now()).then(() => {
    delete global.document
    assert.ok(true)
  })
})

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
