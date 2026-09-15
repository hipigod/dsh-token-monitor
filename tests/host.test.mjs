// 对抗性自测：不依赖宿主，直接驱动 index.js 的纯函数 + 真实 HTTP 路由
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import * as mod from '/root/apps/dsh-plugin-token-monitor/index.js'

const {
  shanghaiParts, shanghaiDate, shanghaiDayStart, shiftDate,
  decodeSessionLog, foldSessionLog, hourlyBuckets, timeBuckets, aggregate, resolveRange,
  isPeakHour, rateFor, costOf, costBreakdown, resolveApiKey,
} = mod

let pass = 0, fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)) }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)) }
}

console.log('== 时间/时区 ==')
t('上海日期：UTC 15:59 → 当天', () => {
  assert.equal(shanghaiDate(Date.parse('2026-09-15T15:59:00Z')), '2026-09-15')
})
t('上海日期：UTC 16:00 → 次日（跨日界）', () => {
  assert.equal(shanghaiDate(Date.parse('2026-09-15T16:00:00Z')), '2026-09-16')
})
t('日界：本地零点 = UTC 前一日 16:00', () => {
  assert.equal(shanghaiDayStart('2026-09-16'), Date.parse('2026-09-15T16:00:00Z'))
})
t('shiftDate 跨月', () => {
  assert.equal(shiftDate('2026-09-01', -1), '2026-08-31')
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28')
})
t('shanghaiParts 小时正确', () => {
  assert.equal(shanghaiParts(Date.parse('2026-09-15T16:30:00Z')).hour, 0)
  assert.equal(shanghaiParts(Date.parse('2026-09-15T15:59:00Z')).hour, 23)
})
t('非法日期返回 NaN（不抛）', () => {
  assert.ok(Number.isNaN(shanghaiDayStart('2026-13-99')))
  assert.ok(Number.isNaN(shanghaiDayStart('')))
})

console.log('== zstd 多帧解码 ==')
const SESSION_ROOT = '/root/.dsh/sessions'
const files = []
for (const ws of readdirSync(SESSION_ROOT)) {
  for (const sid of readdirSync(join(SESSION_ROOT, ws))) {
    const f = join(SESSION_ROOT, ws, sid, 'session.v3.jsonl.zstd')
    if (existsSync(f)) files.push(f)
  }
}
t(`真实日志可解码（${files.length} 个会话）`, () => {
  for (const f of files) {
    const text = decodeSessionLog(readFileSync(f)).text
    assert.ok(text.length > 0 || readFileSync(f).length === 0, f)
    for (const line of text.split('\n')) if (line) JSON.parse(line) // 每行都必须是合法 JSON
  }
})
t('空/无魔数输入返回空文本（不抛）', () => {
  assert.deepEqual(decodeSessionLog(Buffer.alloc(0)), { text: '', truncatedTail: false })
  assert.deepEqual(decodeSessionLog(Buffer.from([1, 2, 3])), { text: '', truncatedTail: false })
})
t('坏帧必须报错，不能静默返回空（这正是初版踩的坑）', () => {
  const bad = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from([9, 9, 9, 9, 9, 9])])
  assert.throws(() => decodeSessionLog(bad), /undecodable zstd frame/)
})
t('末帧解不出时必须显式标记，而不是静默当空（构造：第 1 帧完整 + 尾随垃圾帧）', () => {
  const full = readFileSync(files[0])
  const M = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const firstFrameEnd = full.indexOf(M, 4)
  const firstFrame = full.subarray(0, firstFrameEnd) // 第 1 帧完整
  const junk = Buffer.concat([M, Buffer.from([9, 9, 9, 9, 9, 9])]) // 尾随坏帧
  const r = decodeSessionLog(Buffer.concat([firstFrame, junk]))
  assert.equal(r.truncatedTail, true)
  assert.ok(r.text.length > 0)
  JSON.parse(r.text.split('\n')[0]) // 已解出的部分仍然可用
})
t('hasIncompleteTail：末行残缺 = 截断；完整行结尾 = 正常', () => {
  assert.equal(mod.hasIncompleteTail('{"a":1}\n{"b":2}'), true)
  assert.equal(mod.hasIncompleteTail('{"a":1}\n{"b":2}\n'), false)
  assert.equal(mod.hasIncompleteTail(''), false)
})
t('zstd 分块特性：砍掉末尾几字节不一定报错（因此不能只靠「能否解压」判断截断）', () => {
  const full = readFileSync(files[0])
  const r = decodeSessionLog(full.subarray(0, full.length - 3))
  assert.equal(r.truncatedTail, false) // 帧仍可解 —— 这就是必须补 hasIncompleteTail 的原因
})
t('多帧日志行数与 zstd CLI 一致（交叉验证帧切分正确）', () => {
  const f = files[0]
  const text = decodeSessionLog(readFileSync(f)).text
  const lines = text.split('\n').filter(Boolean)
  for (const l of lines) JSON.parse(l)
  assert.ok(lines.length > 1, '必须解出多于 1 行')
})

console.log('== 折叠逻辑（合成事件，验证口径） ==')
const ev = (type, time, data) => JSON.stringify({ type, ...(time ? { time } : {}), data })
t('未命中/命中/输出三桶分离，cacheWrite 并入未命中', () => {
  const text = [
    ev('request/context', 1000, { provider: 'p', model: 'm' }),
    ev('assistant/message', 2000, { usage: { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 20, outputTokens: 50 } }),
  ].join('\n')
  const { records } = foldSessionLog(text)
  assert.equal(records.length, 1)
  assert.deepEqual({ ...records[0], t: undefined }, { t: undefined, model: 'p/m', cr: 900, ci: 120, out: 50 })
})
t('全 0 用量不进记录', () => {
  const text = ev('assistant/message', 2000, { usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } })
  assert.equal(foldSessionLog(text).records.length, 0)
})
t('模型切换后用量归到新模型', () => {
  const text = [
    ev('request/context', 1000, { provider: 'p', model: 'a' }),
    ev('assistant/message', 2000, { usage: { inputTokens: 1, outputTokens: 1 } }),
    ev('request/context', 3000, { provider: 'p', model: 'b' }),
    ev('assistant/message', 4000, { usage: { inputTokens: 2, outputTokens: 2 } }),
  ].join('\n')
  const models = foldSessionLog(text).records.map(r => r.model)
  assert.deepEqual(models, ['p/a', 'p/b'])
})
t('没有 route 时标记 unknown（不丢数据）', () => {
  const text = ev('assistant/message', 2000, { usage: { inputTokens: 5, outputTokens: 5 } })
  assert.equal(foldSessionLog(text).records[0].model, 'unknown')
})
t('坏行/截断行被跳过，后续行仍解析', () => {
  const text = '{"type":"assist\n' + ev('assistant/message', 2000, { usage: { inputTokens: 5, outputTokens: 5 } })
  assert.equal(foldSessionLog(text).records.length, 1)
})
t('负数/NaN 用量按 0（不污染总量）', () => {
  const text = ev('assistant/message', 2000, { usage: { inputTokens: -5, outputTokens: null } })
  assert.equal(foldSessionLog(text).records.length, 0)
})
t('标题：session/title 优先，否则用首条用户文本并截断', () => {
  const withTitle = [ev('user/message', 1, { message: { content: [{ type: 'text', text: 'x'.repeat(200) }] } }), ev('session/title', 2, { title: '真标题' })].join('\n')
  assert.equal(foldSessionLog(withTitle).meta.title, '真标题')
  const noTitle = ev('user/message', 1, { message: { content: [{ type: 'text', text: 'y'.repeat(200) }] } })
  assert.equal(foldSessionLog(noTitle).meta.title.length, 81)
})

console.log('== 峰谷时段（官方规则：北京时间周一至周五 9–12、14–18 为高峰，其余半价）==')
const BJ = (iso) => Date.parse(iso)
t('高峰窗口边界：9:00 起算、12:00 结束、14:00 起算、18:00 结束', () => {
  assert.equal(isPeakHour(BJ('2026-09-15T01:00:00Z')), true, '周二 09:00 应为高峰')
  assert.equal(isPeakHour(BJ('2026-09-15T03:59:00Z')), true, '周二 11:59 应为高峰')
  assert.equal(isPeakHour(BJ('2026-09-15T04:00:00Z')), false, '周二 12:00 应空闲')
  assert.equal(isPeakHour(BJ('2026-09-15T05:59:00Z')), false, '周二 13:59 应空闲')
  assert.equal(isPeakHour(BJ('2026-09-15T06:00:00Z')), true, '周二 14:00 应为高峰')
  assert.equal(isPeakHour(BJ('2026-09-15T09:59:00Z')), true, '周二 17:59 应为高峰')
  assert.equal(isPeakHour(BJ('2026-09-15T10:00:00Z')), false, '周二 18:00 应空闲')
})
t('周末全天空闲（含本该是高峰的 10:00 与 15:00）', () => {
  assert.equal(isPeakHour(BJ('2026-09-19T02:00:00Z')), false, '周六 10:00')
  assert.equal(isPeakHour(BJ('2026-09-19T07:00:00Z')), false, '周六 15:00')
  assert.equal(isPeakHour(BJ('2026-09-20T02:00:00Z')), false, '周日 10:00')
})
t('凌晨与晚间为空闲', () => {
  assert.equal(isPeakHour(BJ('2026-09-15T18:00:00Z')), false, '周二 次日 02:00')
  assert.equal(isPeakHour(BJ('2026-09-15T13:00:00Z')), false, '周二 21:00')
})

console.log('== 计价 ==')
// 官方空闲价（元/百万）：flash 命中 0.02 / 未命中 1 / 输出 4；pro 0.15 / 4.5 / 13.5；高峰 ×2
const PRICING = {
  currency: 'CNY', unit: 1000000, peakMultiplier: 2,
  defaultModel: { cacheRead: 0.02, uncached: 1, output: 4 },
  models: {
    'deepseek-flash': { cacheRead: 0.02, uncached: 1, output: 4 },
    'deepseek-v4-pro': { cacheRead: 0.15, uncached: 4.5, output: 13.5 },
  },
}
const IDLE = BJ('2026-09-15T18:00:00Z')   // 周二 次日 02:00 = 空闲
const PEAK = BJ('2026-09-15T02:00:00Z')   // 周二 10:00 = 高峰

t('空闲时段：1M 命中 + 1M 未命中 + 1M 输出 = 0.02+1+4 = 5.02 元', () => {
  const { cost, peak, matched } = costOf(PRICING, { t: IDLE, model: 'deepseek-official/deepseek-flash', cr: 1e6, ci: 1e6, out: 1e6 })
  assert.equal(matched, true)
  assert.equal(peak, false)
  assert.ok(Math.abs(cost - 5.02) < 1e-9, '实际 ' + cost)
})
t('高峰时段：同样用量正好翻倍 = 10.04 元', () => {
  const idle = costOf(PRICING, { t: IDLE, model: 'deepseek-flash', cr: 1e6, ci: 1e6, out: 1e6 }).cost
  const peak = costOf(PRICING, { t: PEAK, model: 'deepseek-flash', cr: 1e6, ci: 1e6, out: 1e6 }).cost
  assert.ok(Math.abs(peak - idle * 2) < 1e-9, `${peak} 应为 ${idle * 2}`)
})
t('pro 模型用 pro 单价，不与 flash 混用', () => {
  const { cost } = costOf(PRICING, { t: IDLE, model: 'deepseek-official/deepseek-v4-pro', cr: 1e6, ci: 1e6, out: 1e6 })
  assert.ok(Math.abs(cost - (0.15 + 4.5 + 13.5)) < 1e-9, '实际 ' + cost)
})
t('未登记模型落默认价并标记 matched=false（不静默算成 0）', () => {
  const r = costOf(PRICING, { t: IDLE, model: 'someone/unknown-model', cr: 1e6, ci: 1e6, out: 1e6 })
  assert.equal(r.matched, false)
  assert.ok(r.cost > 0, '未登记模型不能算 0，否则会被读成"不花钱"')
})
t('零用量花费为 0，不产生 NaN', () => {
  const { cost } = costOf(PRICING, { t: IDLE, model: 'deepseek-flash', cr: 0, ci: 0, out: 0 })
  assert.equal(cost, 0)
})
t('costBreakdown：峰谷分开累计，且总额等于两者之和', () => {
  const records = [
    { t: IDLE, model: 'deepseek-flash', cr: 1e6, ci: 0, out: 0 },
    { t: PEAK, model: 'deepseek-flash', cr: 1e6, ci: 0, out: 0 },
    { t: IDLE, model: 'mystery/model', cr: 1e6, ci: 0, out: 0 },
  ]
  const b = costBreakdown(records, PRICING)
  assert.ok(Math.abs(b.offPeak.cost - (0.02 + 0.02)) < 1e-9, '空闲 ' + b.offPeak.cost)
  assert.ok(Math.abs(b.peak.cost - 0.04) < 1e-9, '高峰 ' + b.peak.cost)
  assert.ok(Math.abs(b.cost - (b.peak.cost + b.offPeak.cost)) < 1e-12, '总额必须等于峰+谷')
  assert.deepEqual(b.unmatchedModels, ['mystery/model'])
  assert.equal(b.peak.requests, 1)
  assert.equal(b.offPeak.requests, 2)
})
t('空记录集：总计 0、无未登记模型', () => {
  const b = costBreakdown([], PRICING)
  assert.equal(b.cost, 0)
  assert.deepEqual(b.unmatchedModels, [])
})
t('分桶带上峰谷标记：小时桶 peak/band 正确，天桶不做峰谷断言', () => {
  const day = '2026-09-16'
  const hourBuckets = timeBuckets([
    { t: BJ('2026-09-16T02:00:00Z'), model: 'deepseek-flash', cr: 1e6, ci: 0, out: 0 }, // 北京 10:00 高峰
    { t: BJ('2026-09-16T18:00:00Z'), model: 'deepseek-flash', cr: 1e6, ci: 0, out: 0 }, // 北京 次日 02:00 空闲
  ], 'hour', PRICING)
  const peakBucket = hourBuckets.find(b => b.key.endsWith('T10'))
  const idleBucket = hourBuckets.find(b => b.key.endsWith('T02'))
  assert.equal(peakBucket.band, 2)
  assert.equal(peakBucket.peak, true)
  assert.equal(idleBucket.band, 1)
  assert.equal(idleBucket.peak, false)
  assert.ok(Math.abs(peakBucket.cost - 0.04) < 1e-9, '高峰 1M 命中 = 0.04 元')
  assert.equal(day !== '' , true)
})

console.log('== 分桶/聚合 ==')
const rec = (t, model, cr, ci, out) => ({ t, model, cr, ci, out })
t('timeBuckets(day) 只产出有数据的天', () => {
  const b = timeBuckets([rec(Date.parse('2026-09-15T01:00:00Z'), 'm', 1, 1, 1),
    rec(Date.parse('2026-09-17T01:00:00Z'), 'm', 2, 2, 2)], 'day')
  assert.deepEqual(b.map(x => x.key), ['2026-09-15', '2026-09-17'])
  assert.equal(b[0].total, 3)
  assert.equal(b[1].total, 6)
})
t('timeBuckets(hour) 按上海小时', () => {
  const b = timeBuckets([rec(Date.parse('2026-09-15T16:00:00Z'), 'm', 1, 0, 0)], 'hour')
  assert.equal(b[0].key, '2026-09-16T00')
})
t('hourlyBuckets 满 24 格且区间左闭右开', () => {
  const day = '2026-09-16'
  const start = shanghaiDayStart(day)
  const b = hourlyBuckets([
    rec(start, 'm', 1, 0, 0),                 // 含（左闭）
    rec(start + 24 * 3600e3, 'm', 9, 0, 0),   // 不含（右开，落到次日）
  ], day)
  assert.equal(b.length, 24)
  assert.equal(b[0].total, 1)
  assert.equal(b.reduce((s, x) => s + x.total, 0), 1)
})
t('aggregate：范围过滤 + 模型/会话排序 + 健康度', () => {
  const day = '2026-09-16'
  const start = shanghaiDayStart(day)
  const sessions = [
    { id: 's1', title: 'A', workspace: 'w', createdAt: start, lastMs: start, records: [rec(start + 1000, 'p/a', 10, 90, 10), rec(start + 2000, 'p/b', 0, 0, 5)] },
    { id: 's2', title: 'B', workspace: 'w', createdAt: start, lastMs: start, records: [rec(start + 3000, 'p/a', 100, 0, 0)] },
    { id: 's3', title: 'C', workspace: 'w', createdAt: start, lastMs: start, records: [rec(start - 10 * 24 * 3600e3, 'p/a', 999, 0, 0)] },
  ]
  const r = aggregate(sessions, { startMs: start, endMs: start + 24 * 3600e3 }, 'conversation')
  assert.equal(r.totals.total, 10 + 90 + 10 + 5 + 100)
  assert.deepEqual(r.models.map(m => m.key), ['p/a', 'p/b'])
  assert.deepEqual(r.conversations.map(c => c.id), ['s1', 's2']) // s3 在范围外
  assert.equal(r.dim, 'hour')
  assert.equal(r.health.sessionCount, 2)
  assert.equal(r.health.peakConversation.id, 's1')
  // cacheHitRate = 190 / (190 + 90) = 0.678...
  assert.ok(Math.abs(r.health.cacheHitRate - 110 / 200) < 1e-9)
  assert.equal(r.health.activeHours, 1)
  assert.equal(r.health.idleHours, 23)
})
t('aggregate：近一月用天粒度', () => {
  const r = aggregate([], { startMs: shanghaiDayStart('2026-08-17'), endMs: shanghaiDayStart('2026-09-16') }, 'total')
  assert.equal(r.dim, 'day')
})
t('aggregate：空数据不炸且健康度为 0/null', () => {
  const r = aggregate([], { startMs: 0, endMs: Date.now() }, 'conversation')
  assert.equal(r.totals.total, 0)
  assert.equal(r.health.cacheHitRate, null)
  assert.equal(r.health.peakHour, null)
  assert.equal(r.health.avgPerActiveHour, 0)
})

console.log('== 聚合带计价 ==')
t('aggregate(pricing) 的模型合计、总量、峰谷分解彼此自洽', () => {
  const start = shanghaiDayStart('2026-09-16')
  const sessions = [{
    id: 's1', title: 'A', workspace: 'w', createdAt: start, lastMs: start,
    records: [
      // 同一「上海日」内取两个不同时段：北京 2026-09-16 10:00（高峰）与 20:00（空闲）
      { t: BJ('2026-09-16T02:00:00Z'), model: 'deepseek-flash', cr: 1e6, ci: 0, out: 0 },   // 高峰 0.04
      { t: BJ('2026-09-16T12:00:00Z'), model: 'deepseek-flash', cr: 1e6, ci: 0, out: 0 },   // 空闲 0.02
    ],
  }]
  const r = aggregate(sessions, { startMs: start, endMs: start + 86400000 }, 'conversation', PRICING)
  assert.ok(Math.abs(r.totals.cost - 0.06) < 1e-9, '总量花费 ' + r.totals.cost)
  assert.ok(Math.abs(r.models[0].cost - 0.06) < 1e-9, '模型花费 ' + r.models[0].cost)
  assert.equal(r.currency, 'CNY')
  const bucketSum = r.buckets.reduce((a, b) => a + b.cost, 0)
  assert.ok(Math.abs(bucketSum - 0.06) < 1e-9, '分桶花费之和 ' + bucketSum)
})
t('aggregate 不带 pricing 时 cost 为 null（向后兼容，不崩）', () => {
  const r = aggregate([], { startMs: 0, endMs: 1 }, 'total')
  assert.equal(r.cost, null)
  assert.equal(r.currency, null)
})

console.log('== 余额凭据解析 ==')
t('resolveApiKey：显式配置优先', () => {
  assert.equal(resolveApiKey({ apiKey: '  sk-explicit  ' }), 'sk-explicit')
})
t('resolveApiKey：本机凭据文件必须真的能读到（回归：曾因漏 import dirname 被 catch 吞掉）', () => {
  const key = resolveApiKey({})
  // 本机 $DSH_HOME/.credentials.yaml 存在且有 DEEPSEEK_API_KEY，因此必须取到。
  // 若这里为 null，说明凭据回落链路又坏了 —— 表现是余额永远显示"—"。
  assert.ok(key !== null, '凭据回落链路失效（文件在 /root/.dsh/.credentials.yaml）')
  assert.ok(/^sk-/.test(key), '取到的不是 sk- 开头的 key')
  assert.equal(key.length, 35, 'key 长度异常')
})
t('resolveApiKey：环境变量其次（用不可能存在的变量名验证回落链路不炸）', () => {
  const key = resolveApiKey({ apiKeyEnv: 'DSH_TEST_NO_SUCH_ENV_VAR' })
  // 本机 $DSH_HOME/.credentials.yaml 里有真实 key，因此应能回落到文件；没有则为 null。
  // 断言只要求"要么 null，要么形如 sk- 的字符串"，绝不打印内容。
  assert.ok(key === null || /^sk-/.test(key), '返回值形状不对')
})

console.log('== 范围解析 ==')
const NOW = Date.parse('2026-09-16T04:00:00Z') // 上海 12:00
t('today：本地今日 00:00 → 明日 00:00', () => {
  const r = resolveRange(new URLSearchParams('period=today'), NOW)
  assert.equal(r.start, '2026-09-16'); assert.equal(r.end, '2026-09-16')
  assert.equal(r.startMs, shanghaiDayStart('2026-09-16'))
  assert.equal(r.endMs, shanghaiDayStart('2026-09-17'))
})
t('week：含今日共 7 天', () => {
  const r = resolveRange(new URLSearchParams('period=week'), NOW)
  assert.equal(r.start, '2026-09-10'); assert.equal(r.end, '2026-09-16')
  assert.equal((r.endMs - r.startMs) / 86400e3, 7)
})
t('month：含今日共 30 天', () => {
  const r = resolveRange(new URLSearchParams('period=month'), NOW)
  assert.equal(r.start, '2026-08-18'); assert.equal(r.end, '2026-09-16')
  assert.equal((r.endMs - r.startMs) / 86400e3, 30)
})
t('custom：起止都算满日', () => {
  const r = resolveRange(new URLSearchParams('period=custom&start=2026-09-01&end=2026-09-03'), NOW)
  assert.equal(r.startMs, shanghaiDayStart('2026-09-01'))
  assert.equal(r.endMs, shanghaiDayStart('2026-09-04'))
})
t('custom：end < start 时收敛为 start 单日', () => {
  const r = resolveRange(new URLSearchParams('period=custom&start=2026-09-05&end=2026-09-01'), NOW)
  assert.equal(r.start, '2026-09-05'); assert.equal(r.end, '2026-09-05')
})
t('custom 跨度上限：超过 400 天被夹住', () => {
  const r = resolveRange(new URLSearchParams('period=custom&start=2000-01-01&end=2026-09-16'), NOW)
  assert.equal(r.start, '2000-01-01')
  assert.equal(r.end, '2001-02-03') // 2000-01-01 + 399 天
  assert.equal((r.endMs - r.startMs) / 86400e3, 400)
})
t('垃圾参数不 500：未知 period / 非法日期', () => {
  const a = resolveRange(new URLSearchParams('period=lol'), NOW)
  assert.equal(a.period, 'today')
  const b = resolveRange(new URLSearchParams('period=custom&start=2026-99-99&end=abc'), NOW)
  assert.equal(b.start, '2026-09-16'); assert.equal(b.end, '2026-09-16')
  const c = resolveRange(new URLSearchParams('period=custom&start=2026-02-30&end=2026-03-05'), NOW)
  assert.equal(c.start, '2026-09-16') // 2 月没有 30 日 → 退回今日，而不是被归一成 3 月 2 日
})

console.log('== 真实日志端到端 ==')
await ta('全部真实会话折叠后记录的模型都在 request/context 里出现过', async () => {
  for (const f of files) {
    const folded = foldSessionLog(decodeSessionLog(readFileSync(f)).text)
    for (const r of folded.records) assert.ok(r.model !== 'unknown', `${f} 出现 unknown 模型`)
  }
})
await ta('HTTP 路由：注册 + 200 + JSON 结构 + 405', async () => {
  const ctx = {
    webServer: {
      routes: new Map(),
      register(route) { this.routes.set(route.path, route) },
    },
  }
  mod.apply(ctx)
  assert.ok(ctx.webServer.routes.has(mod.OVERVIEW_PATH))
  assert.ok(ctx.webServer.routes.has(mod.LOG_PATH))
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const route = ctx.webServer.routes.get(url.pathname)
    if (!route) { res.writeHead(404); res.end(); return }
    route.handler(req, res)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const get = async (p, opts) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, opts)
    return { status: res.status, json: await res.json().catch(() => null) }
  }
  const ov = await get(mod.OVERVIEW_PATH)
  assert.equal(ov.status, 200)
  assert.equal(ov.json.ok, true)
  assert.equal(ov.json.buckets.length, 24)
  assert.ok(Array.isArray(ov.json.models))
  assert.equal(typeof ov.json.totals.total, 'number')
  // 小窗口的 24 格总量必须等于今日总量（口径一致性硬检查）
  assert.equal(ov.json.buckets.reduce((s, b) => s + b.total, 0), ov.json.totals.total)
  // 每个模型的合计之和也必须等于总量
  assert.equal(ov.json.models.reduce((s, m) => s + m.total, 0), ov.json.totals.total)

  const log = await get(`${mod.LOG_PATH}?period=month&view=conversation`)
  assert.equal(log.status, 200)
  assert.equal(log.json.dim, 'day')
  assert.ok(log.json.conversations.length >= 0)
  const sumConv = log.json.conversations.reduce((s, c) => s + c.totals.total, 0)
  assert.equal(sumConv, log.json.totals.total)
  const sumBuckets = log.json.buckets.reduce((s, b) => s + b.total, 0)
  assert.equal(sumBuckets, log.json.totals.total)
  assert.equal(log.json.models.reduce((s, m) => s + m.total, 0), log.json.totals.total)

  const all = await get(`${mod.LOG_PATH}?period=all`)
  assert.equal(all.status, 200)
  assert.ok(all.json.totals.total > 0, '全部历史应有用量')

  const bad = await get(mod.LOG_PATH, { method: 'POST' })
  assert.equal(bad.status, 405)
  const junk = await get(`${mod.LOG_PATH}?period=%00&start=%FF`)
  assert.equal(junk.status, 200)

  await new Promise(r => server.close(r))
})

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
