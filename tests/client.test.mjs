// 客户端纯函数测试：把 client.js 装进假模块加载器后直接调用其内部工具
import { strict as assert } from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 包根目录（从本文件位置推导，克隆到哪都能跑）。 */
const PKG = dirname(dirname(fileURLToPath(import.meta.url)))

global.window = {
  __ModuleLoader__: {
    load(reg) {
      global.__reg = reg
    },
  },
}
await import(`file://${join(PKG, 'client.js')}`)
const m = global.__reg.factory((spec) => {
  if (spec === 'react') return { useState: (v) => [v, () => {}], useEffect: () => {}, createElement: () => null }
  if (spec === 'react/jsx-runtime') return { jsx: (...a) => a, jsxs: (...a) => a, Fragment: 'f' }
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return { Modal: () => null, IconRefreshOutline14: () => null, IconDataOutline16: () => null }
  throw new Error('unexpected require: ' + spec)
})

let pass = 0, fail = 0
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name) } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message) } }
const i = m.__internals

console.log('== 数字格式 ==')
t('fmtCompact 边界', () => {
  assert.equal(i.fmtCompact(0), '0')
  assert.equal(i.fmtCompact(999), '999')
  assert.equal(i.fmtCompact(1000), '1k')
  assert.equal(i.fmtCompact(1200), '1.2k')
  assert.equal(i.fmtCompact(999999), '1000k')
  assert.equal(i.fmtCompact(1000000), '1M')
  assert.equal(i.fmtCompact(1234567), '1.2M')
  assert.equal(i.fmtCompact(1500000000), '1.5B')
  assert.equal(i.fmtCompact(undefined), '0')
  assert.equal(i.fmtCompact(NaN), '0')
})
t('fmtZh 万/亿 分档', () => {
  assert.equal(i.fmtZh(0), '0')
  assert.equal(i.fmtZh(9999), '9,999')
  assert.equal(i.fmtZh(10000), '1万')
  assert.equal(i.fmtZh(123456), '12.3万')
  assert.equal(i.fmtZh(100000000), '1亿')
})
t('fmtPercent 空值显示 —', () => {
  assert.equal(i.fmtPercent(null), '—')
  assert.equal(i.fmtPercent(undefined), '—')
  assert.equal(i.fmtPercent(0), '0.0%')
  assert.equal(i.fmtPercent(0.1234), '12.3%')
})
t('fmtFull 千分位', () => {
  assert.equal(i.fmtFull(1234567), '1,234,567')
  assert.equal(i.fmtFull(0), '0')
})

console.log('== 桶标签 ==')
t('小时桶 → HH:00，天桶 → M/D', () => {
  assert.equal(i.bucketLabel('2026-09-16T07', 'hour'), '07:00')
  assert.equal(i.bucketLabel('2026-09-16', 'day'), '9/16')
  assert.equal(i.bucketLabel('2026-12-01', 'day'), '12/1')
})
t('小时悬浮标签是闭区间', () => {
  assert.equal(i.bucketFullLabel('2026-09-16T07', 'hour'), '2026-09-16 07:00–07:59')
  assert.equal(i.bucketFullLabel('2026-09-16', 'day'), '2026-09-16（当日）')
})
t('坏 key 不炸', () => {
  assert.equal(i.bucketLabel(undefined, 'hour'), '')
  assert.equal(i.bucketLabel('garbage', 'hour'), 'garbage')
  assert.equal(i.bucketFullLabel('garbage', 'hour'), 'garbage')
})

console.log('== 峰谷时段带（缺陷 9：没有用量的格子不能用「当前小时」上色）==')
t('bandOf：周一至周五 9–12 / 14–18 为高峰，周末全天空闲', () => {
  // 2026-09-17 是周四，2026-09-19 是周六；入参是 UTC 瞬时，所以上海本地 09:00 = UTC 01:00。
  assert.equal(i.bandOf(Date.UTC(2026, 8, 17, 9) - 8 * 3600000), 2)
  assert.equal(i.bandOf(Date.UTC(2026, 8, 17, 12) - 8 * 3600000), 1, '12:00 已过上午高峰')
  assert.equal(i.bandOf(Date.UTC(2026, 8, 17, 14) - 8 * 3600000), 2)
  assert.equal(i.bandOf(Date.UTC(2026, 8, 17, 18) - 8 * 3600000), 1, '18:00 已过下午高峰')
  assert.equal(i.bandOf(Date.UTC(2026, 8, 19, 10) - 8 * 3600000), 1, '周六应为空闲')
})
t('bandOfKey：按桶自己那个小时判定，解析不出返回 0', () => {
  assert.equal(i.bandOfKey('2026-09-17T09'), 2)
  assert.equal(i.bandOfKey('2026-09-17T00'), 1)
  assert.equal(i.bandOfKey('2026-09-17T17'), 2)
  assert.equal(i.bandOfKey('2026-09-19T10'), 1, '周六')
  assert.equal(i.bandOfKey('2026-09-17'), 1, '天桶兜底为浅色')
  assert.equal(i.bandOfKey('garbage'), 0)
  assert.equal(i.bandOfKey(undefined), 0)
})
t('峰谷带：没用量的小时按「那一格自己那个小时」上色（金标准向量，与运行时刻无关）', () => {
  const buckets = Array.from({ length: 24 }, (_, h) => ({ key: `2026-09-17T${String(h).padStart(2, '0')}`, band: 0 }))
  const tree = i.PeakBand({ buckets, hours: 24 })
  const cells = tree[1].children
  assert.equal(cells.length, 24)
  const bands = cells.map((cell) => cell[1]['data-band'])
  const expected = Array.from({ length: 24 }, (_, h) => (((h >= 9 && h < 12) || (h >= 14 && h < 18)) ? 2 : 1))
  assert.deepEqual(bands, expected, '旧实现用 Date.now()，跑在非高峰时刻会把整条带涂成同一色')
})
t('峰谷带：连 key 都没有时退到「今天第 i 个小时」', () => {
  const tree = i.PeakBand({ buckets: [], hours: 24 })
  const bands = tree[1].children.map((cell) => cell[1]['data-band'])
  const dayStart = i.shanghaiDayStartMs(Date.now())
  const expected = Array.from({ length: 24 }, (_, h) => i.bandOf(dayStart + h * 3600000))
  assert.deepEqual(bands, expected)
})
t('shanghaiDayStartMs：上海当日零点（naive UTC+8 的日界）', () => {
  // 2026-09-17 07:30 上海 = 2026-09-16 23:30 UTC → 当日零点应是 2026-09-16 16:00 UTC
  assert.equal(i.shanghaiDayStartMs(Date.UTC(2026, 8, 16, 23, 30)), Date.UTC(2026, 8, 16, 16, 0))
})

console.log('== 日期工具（上海口径） ==')
t('shanghaiToday 用宿主给的偏移', () => {
  assert.equal(i.shanghaiToday(480), new Date(Date.now() + 480 * 60000).toISOString().slice(0, 10))
  assert.equal(i.shanghaiToday(undefined), new Date(Date.now() + 480 * 60000).toISOString().slice(0, 10))
})
t('shiftDateString 跨月/跨年', () => {
  assert.equal(i.shiftDateString('2026-09-01', -1), '2026-08-31')
  assert.equal(i.shiftDateString('2026-01-01', -1), '2025-12-31')
  assert.equal(i.shiftDateString('2026-09-16', -6), '2026-09-10')
})
t('fmtAgo 分档', () => {
  const now = Date.parse('2026-09-16T12:00:00Z')
  assert.equal(i.fmtAgo(now - 30000, now), '刚刚')
  assert.equal(i.fmtAgo(now - 5 * 60000, now), '5 分钟前')
  assert.equal(i.fmtAgo(now - 3 * 3600000, now), '3 小时前')
  assert.equal(i.fmtAgo(now - 3 * 86400000, now), '3 天前')
  assert.equal(i.fmtAgo(null, now), '—')
})

console.log('== 导出契约 ==')
t('注册 id 必须等于包名（不等于包名 → 浏览器 boot 直接抛 "loaded without registering"）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(join(PKG, 'client.js'), 'utf8')
  const declared = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).name
  const found = /id:\s*["']([^"']+)["']/.exec(src)
  assert.ok(found, 'client.js 必须声明 __ModuleLoader__.load({id})')
  assert.equal(found[1], declared, '注册 id 与 package.json 的 name 必须一致，否则模块表的 arrive() 会失败')
  assert.equal(global.__reg.id, declared, '实际加载时注册的 id 也必须是包名')
})
t('API 路径与宿主一致', () => {
  assert.equal(i.API_OVERVIEW, '/plugin-api/token-monitor/overview')
  assert.equal(i.API_LOG, '/plugin-api/token-monitor/log')
})
t('皮肤样式表声明 data-plugin 归属（不写就会被别的模块 claimStyles 认领，再随它的 HMR 重建被删掉）', async () => {
  const { readFileSync } = await import('node:fs')
  const declared = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).name
  assert.equal(i.PLUGIN_ID, declared, 'PLUGIN_ID 必须是包名')
  assert.equal(i.PLUGIN_ID, global.__reg.id, 'PLUGIN_ID 与注册 id 必须同一个值')
  // 假节点：属性表 + 文本内容，够 ensureStyle 做「归属核对 / 内容核对」。
  const nodes = []
  const realDocument = global.document
  global.document = {
    head: { appendChild: (node) => { nodes.push(node) } },
    createElement: () => ({
      attrs: {},
      textContent: '',
      setAttribute(k, v) { this.attrs[k] = v },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null },
    }),
    querySelector: () => (nodes.length === 0 ? null : nodes[0]),
  }
  try {
    i.ensureStyle()
    assert.equal(nodes.length, 1, '应注入一张样式表')
    const injected = nodes[0]
    assert.equal(injected.getAttribute('data-plugin'), declared, 'data-plugin 必须是包名（client-modules 只认领 style:not([data-plugin])）')
    assert.equal(injected.getAttribute('data-plugin-css'), i.CSS_TAG, 'data-plugin-css 是去重键')
    i.ensureStyle()
    assert.equal(nodes.length, 1, '已存在时不得重复注入（幂等）')
    // 归属被别的模块 claim 走（预修复版本遗留在页面里的表 / 外部改写）→ 必须抢回来。
    // 不抢的话，认领方一旦被 HMR 重建，removeOwnedStyles 会连坐删掉这张表 —— 就是用户实测的故障。
    injected.setAttribute('data-plugin', '@deepseek-ai/dsh-client-ui-sidebar')
    i.ensureStyle()
    assert.equal(injected.getAttribute('data-plugin'), declared, '归属被改写后必须抢回')
    assert.equal(nodes.length, 1, '抢回归属不得再注入一张（皮肤重复）')
    // 只清内容不删节点 = 皮肤同样没了 → 补回内容
    injected.textContent = ''
    i.ensureStyle()
    assert.ok(injected.textContent.length > 100, '内容被清空必须补回')
  } finally {
    if (realDocument === undefined) delete global.document
    else global.document = realDocument
  }
})
t('样式自愈：样式表被外部删除后被观察器补回', () => {
  const realDocument = global.document
  const realObserver = global.MutationObserver
  let observed = null
  let disconnected = false
  let exists = false
  global.document = {
    head: { appendChild: () => { exists = true } },
    createElement: () => ({ setAttribute() {}, getAttribute: () => null, textContent: 'x' }),
    querySelector: () => (exists ? { setAttribute() {}, getAttribute: () => null, textContent: 'x' } : null),
  }
  global.MutationObserver = class {
    constructor(fn) { this.callback = fn }
    observe(node, options) { observed = { node, options } }
    disconnect() { disconnected = true }
  }
  try {
    const observer = i.watchStyle()
    assert.ok(observer, '应返回观察器')
    assert.equal(observed.node, global.document.head, '必须观察 document.head')
    assert.equal(observed.options.childList, true, '必须观察 childList')
    exists = false
    observer.callback()
    assert.equal(exists, true, '样式表被删后必须补回')
    observer.disconnect()
    assert.equal(disconnected, true, '必须能随 fiber 一起回收')
  } finally {
    if (realDocument === undefined) delete global.document
    else global.document = realDocument
    if (realObserver === undefined) delete global.MutationObserver
    else global.MutationObserver = realObserver
  }
})
t('head 尚未就绪时退一步观察 documentElement（head 出现后仍能补皮肤）', () => {
  const realDocument = global.document
  const realObserver = global.MutationObserver
  let observed = null
  global.document = { head: null, documentElement: { name: 'html' } }
  global.MutationObserver = class {
    constructor(fn) { this.callback = fn }
    observe(node, options) { observed = { node, options } }
    disconnect() {}
  }
  try {
    const observer = i.watchStyle()
    assert.ok(observer, 'head 缺失时也必须返回观察器（否则永远没人重试注入）')
    assert.equal(observed.node, global.document.documentElement, '应退一步观察 documentElement')
    assert.equal(observed.options.childList, true)
  } finally {
    if (realDocument === undefined) delete global.document
    else global.document = realDocument
    if (realObserver === undefined) delete global.MutationObserver
    else global.MutationObserver = realObserver
  }
})
t('没有 MutationObserver 的环境降级为只在 apply 时注入，不抛异常', () => {
  const realObserver = global.MutationObserver
  delete global.MutationObserver
  try {
    assert.equal(i.watchStyle(), null)
  } finally {
    if (realObserver !== undefined) global.MutationObserver = realObserver
  }
})
t('apply/inject 形状正确（slots 依赖）', () => {
  assert.equal(typeof m.apply, 'function')
  assert.deepEqual(m.inject, ['slots'])
})
t('apply 走 slots.inject 等待槽位声明，注册进 shell.overlay 且带 id/order', () => {
  let registered = null
  let injectedName = null
  const ctx = {
    effect: (fn) => { fn() },
    slots: {
      inject: (name, fn) => { injectedName = name; return fn() },
      register: (opts, component) => { registered = { opts, component }; return () => {} },
    },
  }
  m.apply(ctx)
  assert.equal(injectedName, 'shell.overlay')
  assert.equal(registered.opts.name, 'shell.overlay')
  assert.equal(registered.opts.id, 'token-monitor')
  assert.equal(typeof registered.opts.order, 'number')
  assert.equal(registered.component, i.TokenMonitorWidget)
})

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
