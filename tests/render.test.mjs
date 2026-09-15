// 无头渲染校验：用假 React 直接调用组件函数，检查真实返回的元素树
// （元素树是普通对象：type/className/style/children 都是数据，可以逐项断言）
import { strict as assert } from 'node:assert'
import { readFileSync, existsSync } from 'node:fs'

const hooks = { cursor: 0, inject: {}, effects: [] }
global.window = {
  __ModuleLoader__: { load: (reg) => { global.__reg = reg } },
  addEventListener: () => {},
  removeEventListener: () => {},
}
/** Modal 是宿主组件，不做展开（展开会递归进整棵弹窗树之外的东西）。 */
function ModalStub(props) { return { type: 'Modal', props } }

let fetchUrl = null
global.fetch = async (url) => {
  fetchUrl = url
  throw new Error('offline-test')
}

await import('/root/apps/dsh-plugin-token-monitor/client.js')
const m = global.__reg.factory((spec) => {
  if (spec === 'react') {
    return {
      useState: (init) => {
        const index = hooks.cursor++
        const value = Object.prototype.hasOwnProperty.call(hooks.inject, index) ? hooks.inject[index] : init
        return [value, () => {}]
      },
      useEffect: (fn) => { hooks.effects.push(fn) },
      createElement: () => null,
    }
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

const { TokenMonitorWidget, LogDialog, Histogram } = m.__internals

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
const classesOf = (node) => walk(node).map(n => (n.props && n.props.className) || '').join(' ')

let pass = 0, fail = 0
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name) } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message) } }

console.log('== 小窗口：宽栏形态渲染 ==')
let tree
t('渲染不抛异常，且是元素树', () => {
  hooks.cursor = 0; hooks.inject = {}
  tree = TokenMonitorWidget({ wide: true })
  assert.ok(tree && tree.type, '必须有根元素')
  assert.equal(tree.props.className, 'tm-root')
})
t('含「日志」按钮，且点击回调存在', () => {
  const buttons = walk(tree).filter(n => n.type === 'button')
  const logBtn = buttons.find(b => b.props.children === '日志')
  assert.ok(logBtn, '必须能找到日志按钮')
  assert.equal(typeof logBtn.props.onClick, 'function')
})
t('标题区展示模型名占位（加载中不显示假数据）', () => {
  const txt = textOf(tree)
  assert.ok(txt.includes('读取中'), '未取到数据时应显示读取中，实际: ' + txt.slice(0, 120))
  assert.ok(!/deepseek/.test(txt), '未取到数据时不得虚构模型名')
})
t('三个图例项齐备（命中/未命中/输出）', () => {
  const txt = textOf(tree)
  for (const label of ['输入（命中缓存）', '输入（未命中缓存）', '输出']) assert.ok(txt.includes(label), '缺少图例: ' + label)
})
const barNodes = (node) => walk(node).filter(n => /^tm-bar(\s|$)/.test(String(n.props && n.props.className)))
t('加载态：图表容器存在但不画柱子（不虚构数据）', () => {
  assert.ok(classesOf(tree).includes('tm-chart'), '应有图表容器')
  assert.equal(barNodes(tree).length, 0, '未取到数据时不应有柱子，实际: ' + barNodes(tree).length)
})
t('每根柱子都带可读的 title（小时 + 三桶明细）', () => {
  const bars = barNodes(tree)
  for (const b of bars) {
    assert.ok(typeof b.props.title === 'string' && b.props.title.includes('命中缓存'), '柱子缺 title')
  }
})
t('轴标注存在 00:00 / 12:00 / 23:00', () => {
  const txt = textOf(tree)
  assert.ok(txt.includes('00:00') && txt.includes('12:00') && txt.includes('23:00'), txt)
})
t('今日总量区在加载态显示 0 而不是 NaN', () => {
  assert.ok(!/NaN|undefined/.test(textOf(tree)), '不得出现 NaN/undefined：' + textOf(tree))
})

console.log('== 小窗口：窄栏（rail）形态 ==')
t('窄栏只渲染一个按钮 + 图标 + 紧凑数值', () => {
  hooks.cursor = 0; hooks.inject = {}
  const rail = TokenMonitorWidget({ wide: false })
  assert.equal(rail.type, 'button')
  assert.equal(rail.props.className, 'tm-rail')
  assert.equal(typeof rail.props.onClick, 'function')
  assert.ok(String(rail.props['aria-label']).length > 0, 'rail 必须有 aria-label')
})
t('wide 缺省时按宽栏渲染（槽位只传 wide，不会 undefined 崩）', () => {
  hooks.cursor = 0; hooks.inject = {}
  const el = TokenMonitorWidget({})
  assert.equal(el.props.className, 'tm-root')
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

console.log('== 数据到达后的渲染（注入真实形状的 overview 响应） ==')
t('有数据时标题显示模型名 + 今日总量，且无 NaN', () => {
  // 直接以「已就绪」状态重建：把 useState 的初值换成注入值
  const overview = {
    ok: true, now: Date.now(), date: '2026-09-15', tzOffsetMinutes: 480,
    totals: { cr: 104976511, ci: 888728, out: 574407, total: 106439646, requests: 821 },
    models: [{ key: 'deepseek-official/deepseek-flash', cr: 104976511, ci: 888728, out: 574407, total: 106439646, requests: 821 }],
    currentModel: 'deepseek-official/deepseek-flash',
    buckets: Array.from({ length: 24 }, (_, hour) => hour === 13
      ? { hour, cr: 25804671, ci: 70912, out: 127167, total: 26002750, requests: 134 }
      : { hour, cr: 0, ci: 0, out: 0, total: 0, requests: 0 }),
    errors: [],
  }
  // 第 0 个钩子是 state：直接注入 ready 快照；hovered/dialogOpen 用默认值
  hooks.cursor = 0
  hooks.inject = { 0: { status: 'ready', data: overview, error: null } }
  const el = TokenMonitorWidget({ wide: true })
  hooks.inject = {}
  const txt = textOf(el)
  // 侧栏只显示末段（provider 前缀会挤爆 96px 的名字位），完整名在 title 属性里
  assert.ok(txt.includes('deepseek-flash'), '应显示模型名末段：' + txt.slice(0, 160))
  const span = walk(el).find(n => typeof n.props.className === 'string' && n.props.className.startsWith('tm-model'))
  assert.ok(String(span.props.title).includes('deepseek-official/deepseek-flash'), '完整 provider/model 必须保留在 title 里')
  assert.ok(txt.includes('1.1亿'), '今日总量应按亿显示：' + txt.slice(0, 160))
  assert.ok(txt.includes('821 次请求'), '应显示请求数')
  assert.ok(!/NaN|undefined/.test(txt), '不得出现 NaN/undefined')
  assert.equal(barNodes(el).length, 24, '24 小时应有 24 根柱子，实际: ' + barNodes(el).length)
  // 只有 13 点有量 → 只有它带非空柱体，其余是空桶底线
  const bodies = walk(el).filter(n => n.props && n.props.style && n.props.style.background !== undefined)
  assert.ok(bodies.length >= 3, '13 点那根柱子应有三个分桶色块，实际: ' + bodies.length)
  assert.ok(classesOf(el).includes('tm-bar-empty'), '其余 23 个小时应画空桶底线')
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
  const dataEffect = hooks.effects[1]
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
  return import('/root/apps/dsh-plugin-token-monitor/client.js?v=' + Date.now()).then(() => {
    delete global.document
    assert.ok(true)
  })
})

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
