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

console.log('== 浮窗：位置（会话列表下方、页脚上方）==')
const f = await page.evaluate(() => {
  const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) } }
  const float = document.querySelector('.tm-float')
  const sidebar = document.querySelector('[class*="sidebar"]')
  const foot = document.querySelector('[class*="footArea"]')
  const region = document.querySelector('[class*="regionArea"]')
  const model = float && float.querySelector('.tm-model')
  const btn = float && [...float.querySelectorAll('button')].find(b => b.innerText.trim() === '日志')
  const minBtn = float && float.querySelector('button[aria-label="最小化"]')
  return {
    hasFloat: !!float,
    float: box(float), sidebar: box(sidebar), foot: box(foot), region: box(region),
    model: model && model.innerText,
    modelTitle: model && model.getAttribute('title'),
    total: float && float.querySelector('.tm-total-value') && float.querySelector('.tm-total-value').innerText,
    money: [...document.querySelectorAll('.tm-money-item')].map(n => n.innerText.replace(/\n/g, ' ')),
    moneyTitle: (document.querySelector('.tm-money-item') || {}).title || '',
    hasLog: !!btn, hasMin: !!minBtn,
    barCount: document.querySelectorAll('.tm-bar').length,
    bandCells: document.querySelectorAll('.tm-band-cell').length,
    bandPeak: document.querySelectorAll('.tm-band-cell[data-band="2"]').length,
    bandIdle: document.querySelectorAll('.tm-band-cell[data-band="1"]').length,
    legend: [...document.querySelectorAll('.tm-legend-item')].map(n => n.innerText.replace(/\n/g, ' ')),
    axisLabels: [...document.querySelectorAll('.tm-axis span')].map(n => n.innerText),
    // 位置关系：会话列表下方（不压住列表可见区）+ 页脚上方
    inSidebarX: !!(float && sidebar && float.getBoundingClientRect().left >= sidebar.getBoundingClientRect().left - 1
      && float.getBoundingClientRect().right <= sidebar.getBoundingClientRect().right + 1),
    aboveFoot: !!(float && foot && float.getBoundingClientRect().bottom <= foot.getBoundingClientRect().top + 1),
  }
})
ok('浮窗已渲染（不再是侧栏 footer 里的一行）', () => {
  assert.equal(f.hasFloat, true, '未找到 .tm-float')
  assert.ok(f.float.w >= 160 && f.float.h >= 140, '浮窗尺寸异常（应能容纳头部+总量+花费+图例）: ' + JSON.stringify(f.float))
})
ok('横向落在侧边栏内', () => assert.equal(f.inSidebarX, true, JSON.stringify({ float: f.float, sidebar: f.sidebar })))
ok('纵向在页脚上方（不再被 Cordis Plugin 区挤占）', () => {
  assert.equal(f.aboveFoot, true, `浮窗底 ${f.float.bottom} 应 <= 页脚顶 ${f.foot && f.foot.y}`)
})
ok('位于会话列表区域下方，不压住列表顶部', () => {
  assert.ok(f.region, '未找到 regionArea')
  assert.ok(f.float.y > f.region.y + 40, `浮窗顶 ${f.float.y} 应明显低于区域顶 ${f.region.y}`)
})
ok('头部右上角有【日志】与【最小化】', () => {
  assert.equal(f.hasLog, true, '缺日志按钮')
  assert.equal(f.hasMin, true, '缺最小化按钮')
})
ok('显示模型名 + 今日总量 + 花费 + 余额', () => {
  assert.ok(f.model && f.model.length > 0, '模型名为空')
  assert.ok(/[0-9]/.test(f.total), '总量无数字: ' + f.total)
  assert.equal(f.money.length, 2, '应有花费与余额两项: ' + JSON.stringify(f.money))
  const cost = f.money[0].replace(/[^0-9.]/g, '')
  assert.ok(Number(cost) > 0, '今日花费应大于 0: ' + f.money[0])
  assert.ok(/高峰|空闲/.test(f.moneyTitle), '花费悬浮应给出峰谷分解: ' + f.moneyTitle)
})
ok('直方图 24 柱 + 峰谷带 24 格且峰谷都有', () => {
  assert.equal(f.barCount, 24, '实际 ' + f.barCount)
  assert.equal(f.bandCells, 24, '峰谷带实际 ' + f.bandCells)
  assert.ok(f.bandPeak > 0 && f.bandIdle > 0, `峰谷应都有: 峰 ${f.bandPeak} 谷 ${f.bandIdle}`)
})
ok('三桶图例齐备 + 轴标注', () => {
  assert.equal(f.legend.length, 3, JSON.stringify(f.legend))
  assert.deepEqual(f.axisLabels, ['00:00', '12:00', '23:00'])
})

console.log('== 浮窗：拖动与最小化 ==')
const head = await page.$('.tm-float-head')
const hb = await head.boundingBox()
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
await page.mouse.down()
await page.mouse.move(hb.x + hb.width / 2 + 60, hb.y + hb.height / 2 + 40, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(600)
const dragged = await page.evaluate(() => {
  const r = document.querySelector('.tm-float').getBoundingClientRect()
  return { x: Math.round(r.x), y: Math.round(r.y) }
})
ok('拖动后位置真的变了', () => {
  assert.ok(Math.abs(dragged.x - f.float.x) > 30 || Math.abs(dragged.y - f.float.y) > 20,
    `拖动无效: ${JSON.stringify(f.float)} → ${JSON.stringify(dragged)}`)
})
// 双击头部回到默认锚点
await page.mouse.dblclick(dragged.x + 80, dragged.y + 10)
await page.waitForTimeout(600)
const restored = await page.evaluate(() => {
  const r = document.querySelector('.tm-float').getBoundingClientRect()
  const foot = document.querySelector('[class*="footArea"]')
  return { x: Math.round(r.x), bottom: Math.round(r.bottom), footTop: foot ? Math.round(foot.getBoundingClientRect().top) : null }
})
ok('双击头部回到默认锚点（页脚上方）', () => {
  assert.ok(restored.footTop === null || restored.bottom <= restored.footTop + 1,
    `未回到锚点: ${JSON.stringify(restored)}`)
})
// 最小化 → 胶囊 → 还原
await page.click('button[aria-label="最小化"]')
await page.waitForTimeout(600)
const pill = await page.evaluate(() => {
  const el = document.querySelector('.tm-pill')
  const foot = document.querySelector('[class*="footArea"]')
  return {
    exists: !!el,
    floatGone: !document.querySelector('.tm-float'),
    text: el ? el.innerText.replace(/\n/g, ' ') : '',
    aboveFoot: !!(el && foot && el.getBoundingClientRect().bottom <= foot.getBoundingClientRect().top + 1),
  }
})
ok('最小化后变成小胶囊，浮窗消失', () => {
  assert.equal(pill.exists, true, '未找到 .tm-pill')
  assert.equal(pill.floatGone, true, '浮窗应消失')
  assert.ok(/[0-9]/.test(pill.text), '胶囊应显示数字: ' + pill.text)
  assert.equal(pill.aboveFoot, true, '胶囊也应在页脚上方')
})
await page.click('.tm-pill')
await page.waitForTimeout(600)
const back = await page.evaluate(() => !!document.querySelector('.tm-float'))
ok('点胶囊可还原浮窗', () => assert.equal(back, true))

console.log('== 日志弹窗 ==')
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.tm-float button')].find(b => b.innerText.trim() === '日志')
  if (btn === undefined) throw new Error('浮窗里找不到【日志】按钮，实际按钮: ' + [...document.querySelectorAll('.tm-float button')].map(b => b.innerText.trim()).join('/'))
  btn.click()
})
await page.waitForTimeout(3500)

// 矮视口回归（用户实测场景）：笔记本 + 浏览器工具栏后可用高度可能只有 ~550px，
// 弹窗内容比视口高，必须「不越界 + 内层可滚 + 尾部可达」，否则就是被裁掉。
const small = await context.newPage()
await small.setViewportSize({ width: 1280, height: 560 })
await small.goto(`${base}/?${token}`, { waitUntil: 'domcontentloaded', timeout: 40000 })
await small.waitForTimeout(5000)
await small.evaluate(() => {
  const btn = [...document.querySelectorAll('.tm-float button')].find(b => b.innerText.trim() === '日志')
  if (btn === undefined) throw new Error('矮视口：浮窗里找不到【日志】按钮')
  btn.click()
})
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
  widget: !!document.querySelector('.tm-float'),
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
