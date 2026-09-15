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
t('apply/inject 形状正确（slots 依赖）', () => {
  assert.equal(typeof m.apply, 'function')
  assert.deepEqual(m.inject, ['slots'])
})
t('apply 走 slots.inject 等待槽位声明，注册进 sidebar.footer.action 且带 id/order', () => {
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
  assert.equal(injectedName, 'sidebar.footer.action')
  assert.equal(registered.opts.name, 'sidebar.footer.action')
  assert.equal(registered.opts.id, 'token-monitor')
  assert.equal(typeof registered.opts.order, 'number')
  assert.equal(registered.component, i.TokenMonitorWidget)
})

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
