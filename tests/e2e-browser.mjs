/**
 * 真·端到端：用无头 Chromium 打开真实 GUI，断言「小窗口真的渲染出来了」。
 *
 * 为什么必须有这一层：宿主路由 200、模块表里有行，都**不等于**浏览器里会出现东西。
 * 以下三类问题只有真浏览器能抓到，且都实际发生过（见 README「已修缺陷」）：
 *   1. client.js 注册 id 与包名不一致 → boot 直接抛 "loaded without registering"
 *   2. Modal 卡片宽度被 ui-primitives 的 width:min(380px,100%) 卡住 → 宽内容被裁掉
 *   3. 长模型名与【日志】按钮重叠（flex 子项不收缩，光写 ellipsis 没用）
 *
 * 用法：
 *   TOKEN=$(grep -oE 'token=[A-Za-z0-9_-]+' /var/log/dsh-web.log | tail -1)
 *   node tests/e2e-browser.mjs "$TOKEN"
 *
 * 依赖：系统 playwright（/usr/lib/node_modules/playwright）+ chromium。
 */
import { chromium } from '/usr/lib/node_modules/playwright/index.mjs'
import { strict as assert } from 'node:assert'

const token = process.argv[2]
assert.ok(token, '缺少 token 参数：node tests/e2e-browser.mjs "<token=...>"')
const base = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080'
let pass = 0, fail = 0
const ok = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name) } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message) } }

const browser = await chromium.launch({ headless: true })
// 全新 context：空缓存 + 空 cookie jar，等价于用户「清缓存后第一次打开」。
// 只复用 page 会漏掉「首次 boot 失败」这类问题（PR #1 事故就是这么漏掉的）。
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await context.newPage()
const errs = []
const badRequests = []
page.on('pageerror', e => errs.push(String(e.message).slice(0, 300)))
page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)) })
page.on('response', r => { if (r.status() >= 400) badRequests.push('HTTP ' + r.status() + ' ' + r.url().slice(0, 100)) })
page.on('requestfailed', r => badRequests.push('FAILED ' + r.url().slice(0, 100)))
await page.goto(`${base}/?${token}`, { waitUntil: 'domcontentloaded', timeout: 40000 })
await page.waitForTimeout(4000)

// 前置条件：token 有效且应用已渲染出宿主骨架。
// 不做这一步的话，token 过期会以 "Cannot read properties of null (reading 'getBoundingClientRect')"
// 崩掉——看起来像测试自身有问题，容易被当成噪音放过（假绿灯更糟）。
const gate = await page.evaluate(() => ({
  body: (document.body.innerText || '').slice(0, 200),
  hasBoot: typeof window.__DSH_BOOT__ !== 'undefined',
  hasRoot: !!document.querySelector('#root, [data-dsh-root], ._root_'),
}))
if (gate.body.includes('authentication required') || !gate.hasBoot) {
  console.error('\n[前置条件不满足] 拿到的不是应用页面，而是登录页/空壳。')
  console.error('  页面文本: ' + gate.body.replace(/\n/g, ' '))
  console.error('  原因：boot URL 里的 token 已失效（或 dsh web 刚重启过）。')
  console.error('  修复：TOKEN=$(grep -oE "token=[A-Za-z0-9_-]+" /var/log/dsh-web.log | tail -1) && node tests/e2e-browser.mjs "$TOKEN"')
  console.error('  注意：token 只在 dsh web 启动时打印一次，会过期；上面取的是最近一次启动的 token，通常仍有效。\n')
  await browser.close()
  process.exit(2)
}

await page.waitForTimeout(3000)

console.log('== 应用整体挂载（这一层是 PR #1 事故的直接护栏）==')
const boot = await page.evaluate(() => {
  const entries = (window.__DSH_BOOT__ && window.__DSH_BOOT__.entries) || []
  return {
    entries: entries.length,
    ids: entries.map(e => e.id),
    moduleLoader: typeof window.__ModuleLoader__,
    // 「整个应用不挂载」时的可见症状：只剩插件加载失败横幅，侧栏/新会话按钮都没了
    pluginFailBanner: /Failed to load plugins/i.test(document.body.innerText || ''),
    appMounted: [...document.querySelectorAll('button')].some(b => /New Session/i.test(b.innerText)),
  }
})
ok('页面无 JS 错误', () => assert.deepEqual(errs, [], '错误: ' + errs.join(' | ')))
ok('无 4xx/5xx 与加载失败请求', () => assert.deepEqual(badRequests, [], '异常请求: ' + badRequests.join(' | ')))
ok('boot 图非空（55 行左右）', () => assert.ok(boot.entries > 40, '实际 ' + boot.entries))
ok('模块表含 @local/dsh-token-monitor', () => assert.ok(boot.ids.includes('@local/dsh-token-monitor'), '实际: ' + boot.ids.filter(i => !i.startsWith('@deepseek-ai/')).join(',')))
ok('应用真的挂载了（不是只剩失败横幅）', () => {
  assert.equal(boot.pluginFailBanner, false, '出现 "Failed to load plugins" —— 有插件把整个应用拖垮了')
  assert.equal(boot.appMounted, true, '侧栏 / New Session 未渲染')
})

console.log('== 小窗口 ==')
const w = await page.evaluate(() => {
  const model = document.querySelector('.tm-model')
  const btn = [...document.querySelectorAll('.tm-root button')].find(b => b.innerText.trim() === '日志')
  if (!model || !btn) return { missing: true, body: (document.body.innerText || '').slice(0, 300) }
  const r = (n) => n.getBoundingClientRect()
  const m = r(model), g = r(btn)
  return {
    missing: false,
    hasRoot: !!document.querySelector('.tm-root'),
    model: model.innerText,
    modelTitle: model.getAttribute('title'),
    total: document.querySelector('.tm-total-value').innerText,
    barCount: document.querySelectorAll('.tm-bar').length,
    legend: [...document.querySelectorAll('.tm-legend-item')].map(n => n.innerText.replace(/\n/g, ' ')),
    axisLabels: [...document.querySelectorAll('.tm-axis span')].map(n => n.innerText),
    overlap: !(m.right <= g.x || g.right <= m.x || m.bottom <= g.y || g.bottom <= m.y),
    modelWidth: Math.round(m.width),
    money: [...document.querySelectorAll('.tm-money-item')].map(n => n.innerText.replace(/\n/g, ' ')),
    moneyTitle: (document.querySelector('.tm-money-item') || {}).title || '',
    balanceText: [...document.querySelectorAll('.tm-money-item')].map(n => n.innerText).find(t => /余额/.test(t)) || '',
    bandCells: document.querySelectorAll('.tm-band-cell').length,
    bandPeak: document.querySelectorAll('.tm-band-cell[data-band="2"]').length,
    bandIdle: document.querySelectorAll('.tm-band-cell[data-band="1"]').length,
    sameRowAsSettings: (() => {
      const fa = document.querySelector('[class*="footerActions"]')
      const sa = document.querySelector('[class*="settingsArea"]')
      return !!(fa && sa && (fa.compareDocumentPosition(sa) & Node.DOCUMENT_POSITION_FOLLOWING))
    })(),
  }
})
ok('小窗口已渲染', () => assert.ok(!w.missing && w.hasRoot, '未找到 .tm-root / 元素缺失；页面文本: ' + (w.body || '')))
ok('显示模型名 + 今日总量', () => {
  assert.ok(w.model.length > 0, '模型名为空')
  assert.ok(/[0-9]/.test(w.total), '总量无数字: ' + w.total)
  assert.ok(w.modelTitle.includes('/'), '完整 provider/model 应保留在 title: ' + w.modelTitle)
})
ok('直方图 24 根柱子', () => assert.equal(w.barCount, 24, '实际 ' + w.barCount))
ok('三桶图例齐备', () => assert.equal(w.legend.length, 3, JSON.stringify(w.legend)))
ok('模型名与【日志】按钮不重叠', () => assert.equal(w.overlap, false, '矩形相交'))
ok('模型名宽度随容器自适应（不是被硬压成固定 96px）', () => {
  assert.ok(w.modelWidth >= 96, '名字宽度应 >= 保底 96px，实际 ' + w.modelWidth)
  assert.ok(w.modelWidth <= 190, '名字宽度应 <= 上限 190px，实际 ' + w.modelWidth)
})
ok('位于设置按钮上方', () => assert.equal(w.sameRowAsSettings, true))
ok('轴标注 00:00 / 12:00 / 23:00', () => assert.deepEqual(w.axisLabels, ['00:00', '12:00', '23:00']))
ok('显示今日花费与余额', () => {
  assert.equal(w.money.length, 2, '应有两项：花费 + 余额，实际 ' + JSON.stringify(w.money))
  assert.ok(/今日花费/.test(w.money[0]), '第一项应是今日花费: ' + w.money[0])
  assert.ok(/余额/.test(w.money[1]), '第二项应是余额: ' + w.money[1])
  // 花费必须有真实数字（不是 — 或 0）
  const cost = w.money[0].replace(/[^0-9.]/g, '')
  assert.ok(Number(cost) > 0, '今日花费应大于 0，实际: ' + w.money[0])
  // 余额允许是「—」（接口不可用时降级），若给了数字则必须能解析
  const bal = w.money[1].replace(/[^0-9.]/g, '')
  assert.ok(/—/.test(w.money[1]) || Number(bal) >= 0, '余额格式异常: ' + w.money[1])
  assert.ok(/高峰|空闲/.test(w.moneyTitle), '花费悬浮应给出峰谷分解: ' + w.moneyTitle)
})
ok('峰谷时段带：24 格且峰/谷都有（颜色能区分开）', () => {
  assert.equal(w.bandCells, 24, '时段带应 24 格，实际 ' + w.bandCells)
  assert.ok(w.bandPeak > 0, '应有高峰格')
  assert.ok(w.bandIdle > 0, '应有空闲格')
  assert.equal(w.bandPeak + w.bandIdle, 24, '每格都应有明确峰谷属性')
})

console.log('== 日志弹窗 ==')
await page.evaluate(() => { [...document.querySelectorAll('.tm-root button')].find(b => b.innerText.trim() === '日志').click() })
await page.waitForTimeout(3500)

// 矮视口回归（用户实测场景）：笔记本 + 浏览器工具栏后可用高度可能只有 ~550px，
// 弹窗内容比视口高，必须「不越界 + 内层可滚 + 尾部可达」，否则就是被裁掉。
const small = await context.newPage()
await small.setViewportSize({ width: 1280, height: 560 })
await small.goto(`${base}/?${token}`, { waitUntil: 'domcontentloaded', timeout: 40000 })
await small.waitForTimeout(5000)
await small.evaluate(() => { [...document.querySelectorAll('.tm-root button')].find(b => b.innerText.trim() === '日志').click() })
await small.waitForTimeout(3000)
const sv = await small.evaluate(() => {
  const card = document.querySelector('[role="dialog"]')
  const inner = card.querySelector('.tm-dialog')
  const cb = card.getBoundingClientRect(), ib = inner.getBoundingClientRect()
  inner.scrollTop = inner.scrollHeight
  const lastSection = [...inner.querySelectorAll('.tm-section-title')].pop()
  return {
    vw: window.innerWidth, vh: window.innerHeight,
    cardOverflowsX: Math.round(cb.right) > window.innerWidth || Math.round(cb.left) < 0,
    cardOverflowsY: Math.round(cb.bottom) > window.innerHeight || Math.round(cb.top) < 0,
    cardW: Math.round(cb.width), cardH: Math.round(cb.height),
    innerScrollable: inner.scrollHeight > inner.clientHeight,
    scrolledTo: Math.round(inner.scrollTop),
    lastSectionReachable: lastSection ? Math.round(lastSection.getBoundingClientRect().bottom) <= Math.round(ib.bottom) + 1 : false,
    docOverflowX: document.documentElement.scrollWidth > window.innerWidth,
  }
})
console.log('  矮视口实测: ' + JSON.stringify(sv))
ok('矮视口(1280x560)：弹窗不越视口', () => {
  assert.equal(sv.cardOverflowsX, false, `横向越界 (card ${sv.cardW}px, vp ${sv.vw}px)`)
  assert.equal(sv.cardOverflowsY, false, `纵向越界 (card ${sv.cardH}px, vp ${sv.vh}px)`)
  assert.equal(sv.docOverflowX, false, '页面出现横向滚动')
})
ok('矮视口：内层可滚且尾部内容可达（不被 overflow:hidden 裁掉）', () => {
  assert.equal(sv.innerScrollable, true, '内容超出却没有滚动容器')
  assert.ok(sv.scrolledTo > 0, '滚动未生效')
  assert.equal(sv.lastSectionReachable, true, '滚到底后最后一段仍不可见')
})
await small.close()
const d = await page.evaluate(() => {
  const card = document.querySelector('[role="dialog"]')
  const inner = card.querySelector('.tm-dialog')
  const cb = card.getBoundingClientRect(), ib = inner.getBoundingClientRect()
  return {
    cardWidth: Math.round(cb.width), innerWidth: Math.round(ib.width),
    overflowX: inner.scrollWidth > inner.clientWidth + 1,
    sections: [...document.querySelectorAll('.tm-section-title')].map(n => n.innerText),
    cardTexts: [...document.querySelectorAll('.tm-card')].map(c => c.innerText.replace(/\n/g, ' | ')),
    tableHeads: [...document.querySelectorAll('.tm-table thead th')].map(n => n.innerText.trim()),
    tableRows: document.querySelectorAll('.tm-table tbody tr').length,
    histCols: document.querySelectorAll('.tm-hist-col').length,
    hasDates: document.querySelectorAll('.tm-date').length,
    text: inner.innerText.slice(0, 200),
  }
})
ok('弹窗打开且宽度不被 380px 卡住', () => assert.ok(d.cardWidth > 900, '卡片宽度 ' + d.cardWidth))
ok('内层不溢出卡片', () => { assert.ok(d.innerWidth <= d.cardWidth, `内层 ${d.innerWidth} > 卡片 ${d.cardWidth}`); assert.equal(d.overflowX, false) })
ok('四个板块齐备', () => assert.deepEqual(d.sections, ['每小时用量', '模型分布', '按对话', '健康度']))
ok('对话明细表有行', () => assert.ok(d.tableRows > 0, '无数据行'))
ok('时间分布有柱', () => assert.ok(d.histCols > 0, '无柱'))
ok('弹窗里有花费与余额卡片，且花费是真实金额', () => {
  const joined = d.cardTexts.join(' || ')
  assert.ok(/花费/.test(joined), '缺少花费卡片: ' + joined.slice(0, 200))
  assert.ok(/余额/.test(joined), '缺少余额卡片: ' + joined.slice(0, 200))
  // 曾经出现「顶部花费卡显示未启用计价 ¥0.0，而模型分布显示 ¥13.01」的自相矛盾
  assert.ok(!/未启用计价/.test(joined), '花费卡退化成未启用计价: ' + joined.slice(0, 260))
  const costCard = d.cardTexts.find(t => /花费/.test(t)) || ''
  const money = costCard.match(/¥\s*([0-9.]+)/)
  assert.ok(money && Number(money[1]) > 0, '花费卡金额应大于 0，实际: ' + costCard)
})
ok('表格有花费列', () => {
  assert.ok(d.tableHeads.includes('花费'), '表头缺"花费"列，实际: ' + JSON.stringify(d.tableHeads))
})
ok('写明时区口径', () => assert.ok(d.text.includes('Asia/Shanghai') || d.text.includes('上海时区')))

// 再硬刷新一次：等价于用户按 F5（本次事故里用户就是在刷新时发现问题）
console.log('== 硬刷新后仍然正常 ==')
await page.reload({ waitUntil: 'domcontentloaded', timeout: 40000 })
await page.waitForTimeout(7000)
const after = await page.evaluate(() => ({
  widget: !!document.querySelector('.tm-root'),
  appMounted: [...document.querySelectorAll('button')].some(b => /New Session/i.test(b.innerText)),
  banner: /Failed to load plugins/i.test(document.body.innerText || ''),
}))
ok('刷新后应用仍挂载且小窗口仍在', () => {
  assert.equal(after.appMounted, true)
  assert.equal(after.banner, false)
  assert.equal(after.widget, true)
})

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
await browser.close()
process.exit(fail === 0 ? 0 : 1)
