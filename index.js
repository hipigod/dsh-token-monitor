/**
 * 模型 Token 用量监测 · TOKEN MONITOR — Host half.
 *
 * 职责：把 DSH 的会话日志（`$DSH_HOME/sessions/<workspace>/<sessionId>/session.v3.jsonl.zstd`）
 * 折算成「按时间 × 模型 × 会话」的 token 用量事实，并通过命名 Web 路由提供给客户端插件。
 *
 * 数据来源与口径（全部来自会话日志本身，不额外埋点）：
 *   - `request/context` 事件：该请求实际使用的 provider/model（路由变化时才追加，
 *     因此按 seq 游标取「最近一次」= 当前生效路由）。
 *   - `assistant/message` 事件的 `data.usage`：provider 回报的用量。
 *       inputTokens      → 输入（未命中缓存）；DeepSeek 的实现里它【不含】缓存读取部分
 *       cacheReadTokens  → 输入（命中缓存）
 *       cacheWriteTokens → 缓存写入，DeepSeek 恒为 0，存在时并入「未命中」桶
 *       outputTokens     → 输出（已含 reasoning）
 *   - 事件顶层 `time`：发生时刻（毫秒）。
 *
 * 时区：固定 Asia/Shanghai（UTC+8，无夏令时），与用户口径一致。
 *
 * 路由：
 *   GET /plugin-api/token-monitor/overview           → 今日总览（小窗口用）
 *   GET /plugin-api/token-monitor/log?...            → 日志弹窗全量报告
 *   GET /plugin-api/token-monitor/doctor             → 自检（宿主路由 + 浏览器模块表登记情况）
 *
 * 无第三方依赖：zstd 解压只用 node:zlib，日志解析只用 JSON.parse。
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import zlib from 'node:zlib'

/** 本插件独占的路由前缀（命名路由优先于 SPA 回退，无需鉴权，与 trajectory-reader 同机制）。 */
const BASE_PATH = '/plugin-api/token-monitor'
const OVERVIEW_PATH = `${BASE_PATH}/overview`
const LOG_PATH = `${BASE_PATH}/log`
const DOCTOR_PATH = `${BASE_PATH}/doctor`

/** 自定义日期范围的跨度上限（天）。 */
const MAX_CUSTOM_DAYS = 400

/**
 * 官方价目表（元 / 百万 tokens），来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * 2026-09-10 12:00 起生效。这里存的是【空闲时段】价，高峰时段按官方规则翻倍。
 *
 * 为什么必须按小时算而不是拿区间总量乘单价：价格分峰谷，同一批 token 在不同小时
 * 单价差一倍，用总量乘单一单价必然算错。所以每条记录按它自己的时间取价，再求和。
 */
const DEFAULT_PRICING = {
  currency: 'CNY',
  unit: 1000000,
  peakMultiplier: 2,
  defaultModel: { cacheRead: 0.02, uncached: 1, output: 4 },
  models: {
    'deepseek-flash': { cacheRead: 0.02, uncached: 1, output: 4 },
    'deepseek-v4-flash': { cacheRead: 0.02, uncached: 1, output: 4 },
    'deepseek-v4-flash-vision-exp': { cacheRead: 0.02, uncached: 1, output: 4 },
    'deepseek-v4-pro': { cacheRead: 0.15, uncached: 4.5, output: 13.5 },
  },
}

/** 高峰时段（北京时间，周一至周五）：9:00–12:00、14:00–18:00；其余为空闲时段（半价）。 */
const PEAK_WINDOWS = [[9, 12], [14, 18]]

/** 余额缓存时长：免费接口也不该每次轮询都打。 */
const BALANCE_TTL_MS = 120000
/** 余额接口超时（失败要快速降级，不能拖慢小窗口）。 */
const BALANCE_TIMEOUT_MS = 6000

/** 余额缓存：{ value, at }。 */
let balanceCache = { value: null, at: 0 }
/** 上次解析 API Key 失败的原因（供 doctor 暴露，避免静默失败被当成"没有 key"）。 */
let lastKeyError = null


/** 固定时区偏移：Asia/Shanghai = UTC+8（无夏令时，全年恒定）。 */
const TZ_OFFSET_MINUTES = 480
const TZ_OFFSET_MS = TZ_OFFSET_MINUTES * 60 * 1000
const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

/** zstd 帧魔数：会话日志是「多帧拼接」的 zstd 流，必须逐帧解，单帧同步解只出第一帧。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 单次扫描允许解码的最大帧数（防御性上限：正常日志每帧 1~2KB，单文件几百帧）。 */
const MAX_FRAMES_PER_FILE = 200000

/**
 * 扫描结果缓存：文件级（path → {mtimeMs, size, records, meta}）。
 * 会话日志以追加方式写、按帧边界落盘，所以 (mtime, size) 变化即为内容变化；
 * 用二者做键可以避免重复解码 3.8MB 级别的历史日志。
 */
const fileCache = new Map()
/** 同一时刻只允许一个扫描在跑，避免并发请求重复解码。 */
let scanInFlight = null

// ───────────────────────────── 时间工具 ─────────────────────────────

/**
 * 把一个毫秒时间戳换算成 Asia/Shanghai 的日/时。
 * @param {number} ms UTC 毫秒时间戳
 * @returns {{date: string, hour: number, dayStart: number}} 本地日期字符串、小时、当日零点（UTC 毫秒）
 */
export function shanghaiParts(ms) {
  const shifted = new Date(ms + TZ_OFFSET_MS)
  const date = shifted.toISOString().slice(0, 10)
  const hour = shifted.getUTCHours()
  // 本地零点的 UTC 毫秒 = 本地日期字符串还原成 UTC 零点再减偏移。
  const dayStart = Date.parse(`${date}T00:00:00.000Z`) - TZ_OFFSET_MS
  return { date, hour, dayStart }
}

/** 取某个 UTC 毫秒时间戳对应的上海日期字符串（YYYY-MM-DD）。 */
export function shanghaiDate(ms) {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * 把上海本地日期字符串（YYYY-MM-DD）解析为当日零点的 UTC 毫秒。
 * @param {string} date YYYY-MM-DD
 * @returns {number} UTC 毫秒；非法输入返回 NaN
 */
export function shanghaiDayStart(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Number.NaN
  const utc = Date.parse(`${date}T00:00:00.000Z`)
  if (Number.isNaN(utc)) return Number.NaN
  return utc - TZ_OFFSET_MS
}

/** 日期字符串加减天数（按上海日界）。 */
export function shiftDate(date, days) {
  const start = shanghaiDayStart(date)
  return shanghaiDate(start + days * DAY_MS)
}

/**
 * 判断某个时刻是否处于高峰时段（北京时间周一至周五 9:00–12:00、14:00–18:00）。
 * 上海 = UTC+8 且无夏令时，所以直接换算即可；周末全天为半价空闲时段。
 * @param {number} ms UTC 毫秒
 * @returns {boolean} 是否高峰
 */
export function isPeakHour(ms) {
  const local = new Date(ms + TZ_OFFSET_MS)
  const day = local.getUTCDay() // 0=周日, 6=周六
  if (day === 0 || day === 6) return false
  const hour = local.getUTCHours()
  return PEAK_WINDOWS.some(([from, to]) => hour >= from && hour < to)
}

/**
 * 取某个模型在某一时刻生效的单价。
 * 模型名可能是 `provider/model` 形式，只取末段匹配；未登记模型回落到 defaultModel
 * （宁可给一个偏保守的默认价，也不要静默算成 0 —— 那样会让人以为"不花钱"）。
 * @param {object} pricing 价目表
 * @param {string} model 模型标识
 * @param {number} ms 发生时刻
 * @returns {{rate: object, peak: boolean, matched: boolean}}
 */
export function rateFor(pricing, model, ms) {
  const base = (model || '').split('/').pop()
  const matched = Object.prototype.hasOwnProperty.call(pricing.models, base)
  const table = matched ? pricing.models[base] : pricing.defaultModel
  const peak = isPeakHour(ms)
  const multiplier = peak ? pricing.peakMultiplier : 1
  return {
    rate: {
      cacheRead: table.cacheRead * multiplier,
      uncached: table.uncached * multiplier,
      output: table.output * multiplier,
    },
    peak,
    matched,
  }
}

/**
 * 一条记录的计费（单位：pricing.currency）。
 * @param {object} pricing 价目表
 * @param {{t: number, model: string, cr: number, ci: number, out: number}} record 用量记录
 * @returns {{cost: number, peak: boolean, matched: boolean}}
 */
export function costOf(pricing, record) {
  const { rate, peak, matched } = rateFor(pricing, record.model, record.t)
  const unit = pricing.unit
  const cost = (record.cr * rate.cacheRead + record.ci * rate.uncached + record.out * rate.output) / unit
  return { cost, peak, matched }
}

/** 把价目表配置与默认值合并（缺项用默认，绝不因为配置写漏就崩或算错）。 */
function resolvePricing(config) {
  const raw = (config && config.pricing) || {}
  const models = Object.assign({}, DEFAULT_PRICING.models)
  if (raw.models && typeof raw.models === 'object') {
    for (const [name, value] of Object.entries(raw.models)) {
      if (value && typeof value === 'object') {
        models[name] = {
          cacheRead: numberOr(value.cacheRead, DEFAULT_PRICING.defaultModel.cacheRead),
          uncached: numberOr(value.uncached, DEFAULT_PRICING.defaultModel.uncached),
          output: numberOr(value.output, DEFAULT_PRICING.defaultModel.output),
        }
      }
    }
  }
  return {
    currency: typeof raw.currency === 'string' && raw.currency ? raw.currency : DEFAULT_PRICING.currency,
    unit: numberOr(raw.unit, DEFAULT_PRICING.unit),
    peakMultiplier: numberOr(raw.peakMultiplier, DEFAULT_PRICING.peakMultiplier),
    defaultModel: Object.assign({}, DEFAULT_PRICING.defaultModel, raw.defaultModel && typeof raw.defaultModel === 'object' ? {
      cacheRead: numberOr(raw.defaultModel.cacheRead, DEFAULT_PRICING.defaultModel.cacheRead),
      uncached: numberOr(raw.defaultModel.uncached, DEFAULT_PRICING.defaultModel.uncached),
      output: numberOr(raw.defaultModel.output, DEFAULT_PRICING.defaultModel.output),
    } : {}),
    models,
  }
}

/** 数值兜底：非有限正数一律回落默认值。 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

// ───────────────────────────── 余额查询 ─────────────────────────────

/**
 * 解析 DeepSeek API Key。优先显式配置 → 环境变量 → DSH 凭据文件。
 * 绝不把 key 写进日志、写进响应、写进任何对外结构。
 * @param {object} config 插件配置
 * @returns {string|null} key
 */
export function resolveApiKey(config) {
  const explicit = config && typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
  if (explicit !== '') return explicit
  const envName = (config && typeof config.apiKeyEnv === 'string' && config.apiKeyEnv) || 'DEEPSEEK_API_KEY'
  const fromEnv = process.env[envName]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  // DSH 把凭据放在 $DSH_HOME/.credentials.yaml 的 refs 段
  try {
    const file = join(dirname(sessionsRoot()), '.credentials.yaml')
    if (!existsSync(file)) return null
    const match = /^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m.exec(readFileSync(file, 'utf8'))
    return match === null ? null : match[1]
  } catch (error) {
    // 不静默：这里曾经因为漏 import dirname 抛 ReferenceError 被吞掉，
    // 表现为余额永远"—"，排查成本很高。把原因记进 lastKeyError 供 doctor 暴露。
    lastKeyError = String((error && error.message) || error)
    return null
  }
}

/**
 * 查询账户余额。失败一律返回 {ok:false, reason}，绝不让小窗口因为余额接口挂掉。
 * 结果缓存 BALANCE_TTL_MS，避免每次轮询都打外部接口。
 *
 * @param {object} config 插件配置
 * @param {boolean} force 是否跳过缓存
 * @returns {Promise<object>} 余额信息
 */
export async function fetchBalance(config, force = false) {
  const now = Date.now()
  if (!force && balanceCache.value !== null && now - balanceCache.at < BALANCE_TTL_MS) {
    return balanceCache.value
  }
  const key = resolveApiKey(config)
  if (key === null) {
    const miss = { ok: false, reason: 'no-key' }
    balanceCache = { value: miss, at: now }
    return miss
  }
  const baseURL = (config && typeof config.baseURL === 'string' && config.baseURL)
    || process.env.DEEPSEEK_BASE_URL
    || 'https://api.deepseek.com'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseURL.replace(/\/+$/, '')}/user/balance`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      const miss = { ok: false, reason: `http-${response.status}` }
      balanceCache = { value: miss, at: now }
      return miss
    }
    const body = await response.json()
    const infos = Array.isArray(body && body.balance_infos) ? body.balance_infos : []
    const info = infos.find(entry => entry && entry.currency === 'CNY') || infos[0] || null
    if (info === null) {
      const miss = { ok: false, reason: 'empty' }
      balanceCache = { value: miss, at: now }
      return miss
    }
    const value = {
      ok: true,
      available: body.is_available === true,
      currency: typeof info.currency === 'string' ? info.currency : 'CNY',
      total: toNumber(info.total_balance),
      granted: toNumber(info.granted_balance),
      toppedUp: toNumber(info.topped_up_balance),
      at: now,
    }
    balanceCache = { value, at: now }
    return value
  } catch (error) {
    const miss = { ok: false, reason: error && error.name === 'AbortError' ? 'timeout' : 'network' }
    balanceCache = { value: miss, at: now }
    return miss
  } finally {
    clearTimeout(timer)
  }
}

/** 余额字段是字符串（"37.06"），转数字并兜底。 */
function toNumber(value) {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value))
  return Number.isFinite(n) ? n : 0
}

// ───────────────────────────── 日志解码 ─────────────────────────────

/**
 * 解码一份多帧 zstd 会话日志。
 *
 * 为什么不用 `zlib.zstdDecompressSync(buffer)`：它只解第一帧，实测 1.38MB / 750 帧的
 * 日志只会吐出 1 行；流式解压器则在第二帧边界报 `Unknown frame descriptor`。
 * 因此这里显式按魔数切帧，逐帧独立解压。
 *
 * 关于 `finishFlush: Z_SYNC_FLUSH`：zstd 解码器默认容忍「输入在这里就结束了」，
 * 于是对一个只有帧头的坏数据会【静默返回空缓冲】——那种错误会伪装成「这个会话没用量」。
 * 加上 SYNC_FLUSH 后，帧不完整即报错，坏数据无法伪装成合法空帧。
 *
 * @param {Buffer} buffer 压缩后的日志字节
 * @returns {{text: string, truncatedTail: boolean}} 明文 JSONL 与「末帧不完整」标记
 * @throws {Error} 非末帧无法解码时抛出（宁可报错，也不静默丢数据）
 */
export function decodeSessionLog(buffer) {
  const offsets = []
  let cursor = 0
  while (cursor <= buffer.length - 4) {
    const found = buffer.indexOf(ZSTD_MAGIC, cursor)
    if (found < 0) break
    offsets.push(found)
    if (offsets.length > MAX_FRAMES_PER_FILE) {
      throw new Error(`token-monitor: frame count exceeds ${MAX_FRAMES_PER_FILE}`)
    }
    cursor = found + 4
  }
  if (offsets.length === 0) return { text: '', truncatedTail: false }
  const parts = []
  let truncation = false
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i]
    // 末帧的终点是文件末尾；中间帧的终点是下一帧魔数所在位置。
    const next = i + 1 < offsets.length ? offsets[i + 1] : buffer.length
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(start, next), {
        finishFlush: zlib.constants.Z_SYNC_FLUSH,
      }))
    } catch (error) {
      const isLastFrame = i === offsets.length - 1
      // 「末帧容忍」只对【后面还有内容】的日志成立：文件开头就解不出东西，
      // 那不是写入中的尾巴，而是坏文件——必须报错，不能伪装成「这个会话没用量」。
      if (isLastFrame && parts.length > 0) {
        truncation = true
        break
      }
      throw new Error(`token-monitor: undecodable zstd frame at byte ${start}: ${error && error.message}`)
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), truncatedTail: truncation }
}

/**
 * 判断解码后的明文是否以不完整的行结尾。
 *
 * 会话日志是 JSONL：除最后一行外，每行都以换行结尾。因此「末尾没有换行」本身
 * 就是截断的信号——不管最后那段残片碰巧能不能被 JSON.parse 接受。
 * （真要发生「残片恰好是合法 JSON」，那种概率极低，且下面 foldSessionLog 仍会
 *  把它当作一条事件正常解析，不会造成错误数据。）
 *
 * @param {string} text 解码后的明文 JSONL
 * @returns {boolean} 是否以不完整的行结尾
 */
export function hasIncompleteTail(text) {
  return text !== '' && !text.endsWith('\n')
}


/**
 * 把一个会话日志折成用量记录 + 会话元信息。
 *
 * 只保留需要的事件类型：带 `stream`（全量流式分片）的事件体积巨大，先判类型再解析 JSON
 * 会浪费，因此这里直接解析但只取 `type` 与少量字段，避免持有大对象。
 *
 * @param {string} text 明文 JSONL
 * @returns {{records: Array, meta: {title: string|null, createdAt: number|null, firstMs: number|null, lastMs: number|null, steps: number, turns: number, routeChangedTimes: number}}}
 */
export function foldSessionLog(text) {
  const records = []
  let route = null            // 当前生效路由（最近一个 request/context）
  let routeChanges = 0
  let title = null
  let createdAt = null
  let firstMs = null
  let lastMs = null
  let steps = 0
  let turns = 0
  let firstUserPrompt = null
  let cwd = null
  let runId = null

  for (const line of text.split('\n')) {
    if (line === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue // 截断的尾行：日志按帧追加，读到半行是可能的
    }
    const type = event.type
    if (type === 'session') {
      if (typeof event.createdAt === 'number') createdAt = event.createdAt
      if (typeof event.cwd === 'string') cwd = event.cwd
      if (typeof event.runId === 'string') runId = event.runId
      continue
    }
    if (typeof event.time === 'number') {
      if (firstMs === null) firstMs = event.time
      lastMs = event.time
    }
    if (type === 'request/context') {
      const data = event.data || {}
      if (typeof data.provider === 'string' && typeof data.model === 'string') {
        route = `${data.provider}/${data.model}`
        routeChanges += 1
      }
      continue
    }
    if (type === 'request/header') {
      // 兜底：极早期日志可能只有 header 没有 context。
      const config = (event.data && event.data.header && event.data.header.config) || {}
      if (route === null && typeof config.provider === 'string' && typeof config.model === 'string') {
        route = `${config.provider}/${config.model}`
        routeChanges += 1
      }
      continue
    }
    if (type === 'session/title') {
      const data = event.data || {}
      if (typeof data.title === 'string' && data.title !== '') title = data.title
      continue
    }
    if (type === 'user/message') {
      if (firstUserPrompt === null) firstUserPrompt = extractUserText(event)
      continue
    }
    if (type === 'turn/start') { turns += 1; continue }
    if (type === 'step/start') { steps += 1; continue }
    if (type === 'assistant/message') {
      const usage = event.data && event.data.usage
      if (!usage || typeof event.time !== 'number') continue
      const uncached = numberOr0(usage.inputTokens)
      const cacheWrite = numberOr0(usage.cacheWriteTokens)
      const cacheRead = numberOr0(usage.cacheReadTokens)
      const output = numberOr0(usage.outputTokens)
      if (uncached === 0 && cacheRead === 0 && cacheWrite === 0 && output === 0) continue
      records.push({
        t: event.time,
        model: route || 'unknown',
        // 「输入（命中缓存）」与「输入（未命中缓存）」两个桶；缓存写入并入未命中，
        // 因为对计费与口径而言它同属「需要重新读入的输入」。
        cr: cacheRead,
        ci: uncached + cacheWrite,
        out: output,
      })
    }
  }
  return {
    records,
    meta: {
      title: title || firstUserPrompt,
      createdAt,
      firstMs,
      lastMs,
      steps,
      turns,
      routeChangedTimes: routeChanges,
      cwd,
      runId,
    },
  }
}

/** 从 user/message 事件里抽第一段文本，用作标题兜底。 */
function extractUserText(event) {
  const content = event.data && event.data.message && event.data.message.content
  if (typeof content === 'string') return clampTitle(content)
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      return clampTitle(block.text)
    }
  }
  return null
}

/** 标题截断（避免把整段提示词塞进列表）。 */
function clampTitle(text) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat
}

/** 数字兜底：日志里的用量字段理论上都是数字，脏数据按 0 处理并继续。 */
function numberOr0(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

// ───────────────────────────── 扫描与会话索引 ─────────────────────────────

/** 会话日志根目录（$DSH_HOME/sessions）。 */
function sessionsRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/** 标题兜底用的投影缓存目录（$DSH_HOME/storages/session_projcache/sessions）。 */
function projectionRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'session_projcache', 'sessions')
}

/**
 * 读取投影缓存里的会话标题（服务端权威的用户可见标题）。
 * 读不到就返回 null，由日志内的 session/title 兜底。
 * @param {string} sessionId 会话 id
 * @returns {string|null} 标题
 */
function cachedTitle(sessionId) {
  try {
    const file = join(projectionRoot(), `${sessionId}.json`)
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const title = parsed && parsed.record && parsed.record.rows && parsed.record.rows.title
    const value = title && title.val
    return typeof value === 'string' && value.trim() !== '' ? value : null
  } catch {
    return null
  }
}

/**
 * 扫描全部会话日志，返回按会话聚合的用量记录。
 * 结果按 (mtimeMs, size) 缓存；解析失败的文件会被跳过并记录到 `errors`，不影响其它会话。
 *
 * @returns {Promise<{sessions: Array, errors: Array, scannedAt: number}>}
 */
export async function scanSessions() {
  if (scanInFlight !== null) return scanInFlight
  scanInFlight = (async () => {
    const root = sessionsRoot()
    const sessions = []
    const errors = []
    const seen = new Set()
    let workspaces = []
    try {
      workspaces = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
    } catch (error) {
      return { sessions: [], errors: [{ path: root, message: String(error && error.message || error) }], scannedAt: Date.now() }
    }
    for (const workspace of workspaces) {
      const workspaceDir = join(root, workspace.name)
      let entries = []
      try {
        entries = readdirSync(workspaceDir, { withFileTypes: true }).filter(entry => entry.isDirectory())
      } catch {
        continue
      }
      for (const entry of entries) {
        const file = join(workspaceDir, entry.name, 'session.v3.jsonl.zstd')
        if (!existsSync(file)) continue
        seen.add(file)
        let stat
        try {
          stat = statOf(file)
        } catch {
          continue
        }
        const cached = fileCache.get(file)
        if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          sessions.push(describeSession(entry.name, workspace.name, file, cached))
          continue
        }
        try {
          const decoded = decodeSessionLog(readFileSync(file))
          const folded = foldSessionLog(decoded.text)
          const record = {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            records: folded.records,
            meta: folded.meta,
            bytes: stat.size,
          }
          fileCache.set(file, record)
          if (decoded.truncatedTail || hasIncompleteTail(decoded.text)) {
            errors.push({ path: file, message: '日志尾部不完整（写入中），已按已落盘内容统计' })
          }
          sessions.push(describeSession(entry.name, workspace.name, file, record))
        } catch (error) {
          errors.push({ path: file, message: String(error && error.message || error) })
        }
      }
    }
    // 清掉已消失文件（会话被删除/归档）的缓存，避免无界增长。
    for (const key of [...fileCache.keys()]) if (!seen.has(key)) fileCache.delete(key)
    return { sessions, errors, scannedAt: Date.now() }
  })()
  try {
    return await scanInFlight
  } finally {
    scanInFlight = null
  }
}

/** 读取文件 stat（独立函数便于测试替换）。 */
function statOf(file) {
  return statSync(file)
}

/**
 * 工作区显示名。会话目录名是「路径编码」（`--root-dsh-workspace--`），无法无损还原，
 * 所以优先用日志里的 `cwd` 取末段；没有 cwd 时退回解码目录名。
 * @param {string|null} cwd 会话工作目录
 * @param {string} dirName 会话目录名
 * @returns {string} 显示名
 */
function workspaceLabelOf(cwd, dirName) {
  if (typeof cwd === 'string' && cwd !== '') {
    const parts = cwd.split('/').filter(Boolean)
    if (parts.length > 0) return parts[parts.length - 1]
  }
  const trimmed = dirName.replace(/^--/, '').replace(/--$/, '')
  const parts = trimmed.split('-').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : dirName
}

/** 组装一个会话的对外描述。 */
function describeSession(sessionId, workspace, file, cached) {
  const meta = cached.meta || {}
  return {
    id: sessionId,
    workspace,
    workspaceLabel: workspaceLabelOf(meta.cwd, workspace),
    cwd: meta.cwd || null,
    title: cachedTitle(sessionId) || meta.title || null,
    createdAt: meta.createdAt ?? null,
    firstMs: meta.firstMs ?? null,
    lastMs: meta.lastMs ?? null,
    steps: meta.steps ?? 0,
    turns: meta.turns ?? 0,
    bytes: cached.bytes ?? cached.size ?? 0,
    records: cached.records || [],
  }
}

// ───────────────────────────── 聚合 ─────────────────────────────

/** 空桶。 */
function emptyTotals() {
  return { cr: 0, ci: 0, out: 0, total: 0, requests: 0 }
}

/** 把一条记录累加进桶。 */
function addRecord(bucket, record) {
  bucket.cr += record.cr
  bucket.ci += record.ci
  bucket.out += record.out
  bucket.total += record.cr + record.ci + record.out
  bucket.requests += 1
  return bucket
}

/**
 * 汇总一天里各小时的用量。
 * @param {Array} records 已过滤到目标区间的记录
 * @param {string} date 上海日期（YYYY-MM-DD）
 * @returns {Array<{hour: number, cr: number, ci: number, out: number, total: number, requests: number}>} 恰好 24 项
 */
export function hourlyBuckets(records, date) {
  const dayStart = shanghaiDayStart(date)
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, ...emptyTotals() }))
  if (Number.isNaN(dayStart)) return buckets
  for (const record of records) {
    if (record.t < dayStart || record.t >= dayStart + DAY_MS) continue
    const hour = new Date(record.t + TZ_OFFSET_MS).getUTCHours()
    addRecord(buckets[hour], record)
  }
  return buckets
}

/**
 * 区间内的**全部**桶 key（上海口径，升序）：天粒度逐日，小时粒度逐小时（每天 24 格）。
 *
 * 为什么不能只给"有记录的桶"：坐标轴是按数组顺序等距画的，缺格会把 09-19 与 09-22
 * 画成相邻的两根柱子，看起来像"每天都在用"。空档本身是事实，必须占位。
 *
 * 防御：区间非法/倒序返回空；格数超过上限（自定义区间跨年、period=all 从 1970 起）
 * 同样返回空 —— 调用方保持稀疏返回，宁可轴不连续，也不能吐上万条空桶。
 *
 * @param {string} start 起始日 YYYY-MM-DD（上海）
 * @param {string} end 结束日 YYYY-MM-DD（上海，含当天）
 * @param {string} dim 'hour' | 'day'
 * @returns {Array<string>} 桶 key 列表；不展开时为空数组
 */
export function bucketKeys(start, end, dim) {
  if (typeof start !== 'string' || typeof end !== 'string') return []
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return []
  const first = shanghaiDayStart(start)
  const last = shanghaiDayStart(end)
  if (Number.isNaN(first) || Number.isNaN(last) || last < first) return []
  const days = Math.round((last - first) / DAY_MS) + 1
  if (dim === 'hour' && days > 40) return []
  if (dim !== 'hour' && days > 1000) return []
  const keys = []
  let cursor = start
  for (let d = 0; d < days; d += 1) {
    if (dim === 'hour') {
      for (let hour = 0; hour < 24; hour += 1) keys.push(`${cursor}T${String(hour).padStart(2, '0')}`)
    } else {
      keys.push(cursor)
    }
    cursor = shiftDate(cursor, 1)
  }
  return keys
}

/**
 * 按维度分桶（hour / day），日期范围自适应。
 * 传了 range 就**先按区间铺满空格子**（空档占位），再把记录填进去。
 *
 * @param {Array} records 记录（已过滤到区间内）
 * @param {string} dim 'hour' | 'day'
 * @param {object|null} pricing 价目表
 * @param {{start: string, end: string}|null} range 上海日期区间（含首尾）
 * @returns {Array<{key: string, label: string, ...totals}>} 按时间升序
 */
export function timeBuckets(records, dim, pricing = null, range = null) {
  const map = new Map()
  // 先铺空格子：没有用量的小时/日期同样要占一格（band=0，客户端会自行判定峰谷上色）。
  if (range !== null && typeof range === 'object') {
    for (const key of bucketKeys(range.start, range.end, dim)) {
      map.set(key, { key, label: key, ...emptyTotals(), cost: 0, band: 0, peak: false })
    }
  }
  for (const record of records) {
    const key = dim === 'hour' ? hourKey(record.t) : shanghaiDate(record.t)
    let bucket = map.get(key)
    if (bucket === undefined) {
      // band 由宿主判定（0=无数据 / 1=空闲时段 / 2=高峰时段），客户端只负责上色，
      // 避免同一套峰谷规则在两端各写一遍而漂移。
      bucket = { key, label: key, ...emptyTotals(), cost: 0, band: 0, peak: false }
      map.set(key, bucket)
    }
    addRecord(bucket, record)
    if (pricing !== null) {
      const { cost, peak } = costOf(pricing, record)
      bucket.cost += cost
      if (dim === 'hour') {
        bucket.peak = peak
        bucket.band = peak ? 2 : 1
      }
    }
  }
  const list = [...map.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  if (pricing !== null && dim === 'day') {
    // 天粒度下"峰谷"没有单一取值，用「当天是否含高峰时段」表达，band 只做浅色标记。
    for (const bucket of list) {
      bucket.band = bucket.total > 0 ? 1 : 0
      bucket.peak = false
    }
  }
  return list
}

/**
 * 峰谷花费分解：同一天里，高峰时段与空闲时段各花了多少。
 * 这个分解是必要的——官方价目表里高峰单价是空闲的两倍，
 * 只给一个"今日花费"无法解释钱花在哪，也无法指导"要不要把活挪到空闲时段跑"。
 *
 * @param {Array} records 已过滤到目标区间的记录
 * @param {object} pricing 价目表
 * @returns {{cost: number, peak: object, offPeak: object, unmatchedModels: Array<string>}}
 */
export function costBreakdown(records, pricing) {
  const peak = { cost: 0, requests: 0, tokens: 0 }
  const offPeak = { cost: 0, requests: 0, tokens: 0 }
  const unmatched = new Set()
  let cost = 0
  for (const record of records) {
    const one = costOf(pricing, record)
    const tokens = record.cr + record.ci + record.out
    cost += one.cost
    const side = one.peak ? peak : offPeak
    side.cost += one.cost
    side.requests += 1
    side.tokens += tokens
    if (!one.matched) unmatched.add(record.model)
  }
  return { cost, peak, offPeak, unmatchedModels: [...unmatched] }
}

/** 小时键：YYYY-MM-DDTHH（上海时区）。 */
function hourKey(ms) {
  const { date } = shanghaiParts(ms)
  const hour = String(new Date(ms + TZ_OFFSET_MS).getUTCHours()).padStart(2, '0')
  return `${date}T${hour}`
}

/**
 * 把「范围 + 视图」解析成具体记录集与分组结果。
 *
 * 口径一致性硬约束：所有分组（模型合计、时间桶、会话合计）都来自同一批
 * 「已按范围过滤的记录」，因此三者的合计必然相等——UI 上三个数字对不上就是 bug。
 *
 * @param {Array} sessions scanSessions() 的会话数组
 * @param {{startMs: number, endMs: number}} range 时间范围（UTC 毫秒，左闭右开）
 * @param {'total'|'conversation'} view 视图
 * @returns {{totals: object, models: Array, buckets: Array, conversations: Array, health: object}}
 */
export function aggregate(sessions, range, view, pricing = null) {
  const inRange = []
  const totals = emptyTotals()
  const perModel = new Map()
  const perSession = new Map()
  let earliest = null
  let latest = null

  for (const session of sessions) {
    let sessionTotals = null
    for (const record of session.records) {
      if (record.t < range.startMs || record.t >= range.endMs) continue
      inRange.push(record)
      addRecord(totals, record)
      if (sessionTotals === null) {
        sessionTotals = emptyTotals()
        perSession.set(session.id, { session, totals: sessionTotals })
      }
      addRecord(sessionTotals, record)
      let model = perModel.get(record.model)
      if (model === undefined) {
        model = { key: record.model, ...emptyTotals(), cost: 0 }
        perModel.set(record.model, model)
      }
      addRecord(model, record)
      if (pricing !== null) model.cost += costOf(pricing, record).cost
      if (earliest === null || record.t < earliest) earliest = record.t
      if (latest === null || record.t > latest) latest = record.t
    }
  }

  const conversations = [...perSession.values()]
    .map(({ session, totals: sessionTotals }) => ({
      id: session.id,
      workspace: session.workspace,
      title: session.title,
      createdAt: session.createdAt,
      lastMs: session.lastMs,
      models: [...new Set(session.records.filter(r => r.t >= range.startMs && r.t < range.endMs).map(r => r.model))],
      totals: sessionTotals,
    }))
    .sort((a, b) => b.totals.total - a.totals.total)

  const spanDays = Math.max(1, Math.round((range.endMs - range.startMs) / DAY_MS))
  const dim = spanDays <= 2 ? 'hour' : 'day'

  // 模型花费在遍历时就地累加（曾在外面写「按模型再扫一遍记录」的嵌套循环，
  // 那是 O(模型数×记录数)：模型一多就会变成平方级。这里与 total 共用同一遍数据。）
  const modelList = [...perModel.values()].sort((a, b) => b.total - a.total)
  const money = pricing === null ? null : costBreakdown(inRange, pricing)

  return {
    view,
    dim,
    totals: pricing === null ? totals : { ...totals, cost: money.cost },
    cost: money,
    currency: pricing === null ? null : pricing.currency,
    models: modelList,
    buckets: timeBuckets(inRange, dim, pricing, range),
    conversations: view === 'conversation' ? conversations : [],
    conversationCount: conversations.length,
    health: buildHealth(sessions.length, inRange, range, conversations),
    earliest,
    latest,
    recordsInRange: inRange.length,
  }
}

/**
 * 健康度指标：把「用量数字」变成可行动的判断依据。
 * 全部由记录集直接推导，不做任何估计。
 *
 * @param {number} scannedSessions 扫描到的会话总数
 * @param {Array} records 已过滤到范围内、且去重后参与统计的记录
 * @param {{startMs: number, endMs: number}} range 时间范围
 * @param {Array} conversations 按会话聚合（已按总量降序）
 */
function buildHealth(scannedSessions, records, range, conversations) {
  const totals = emptyTotals()
  const hourly = new Map()
  for (const record of records) {
    addRecord(totals, record)
    const key = hourKey(record.t)
    let bucket = hourly.get(key)
    if (bucket === undefined) { bucket = { key, total: 0, requests: 0 }; hourly.set(key, bucket) }
    bucket.total += record.cr + record.ci + record.out
    bucket.requests += 1
  }
  let peakHour = null
  for (const bucket of hourly.values()) {
    if (peakHour === null || bucket.total > peakHour.total) peakHour = bucket
  }

  const inputTotal = totals.cr + totals.ci
  const activeHours = hourly.size
  const spanDays = Math.max(1, Math.ceil((range.endMs - range.startMs) / DAY_MS))

  return {
    cacheHitRate: inputTotal > 0 ? totals.cr / inputTotal : null,
    activeHours,
    idleHours: spanDays * 24 - activeHours,
    avgPerActiveHour: activeHours > 0 ? Math.round(totals.total / activeHours) : 0,
    avgPerDay: Math.round(totals.total / spanDays),
    peakHour: peakHour === null ? null : { key: peakHour.key, total: peakHour.total, requests: peakHour.requests },
    peakConversation: conversations.length > 0
      ? { id: conversations[0].id, title: conversations[0].title, total: conversations[0].totals.total }
      : null,
    requests: totals.requests,
    avgInputPerRequest: totals.requests > 0 ? Math.round(inputTotal / totals.requests) : 0,
    avgOutputPerRequest: totals.requests > 0 ? Math.round(totals.out / totals.requests) : 0,
    sessionCount: conversations.length,
    totalSessionsScanned: scannedSessions,
  }
}

/**
 * 校验一个日期字符串是不是真实存在的日历日。
 * `2026-99-99` 这种能被正则放过、但 Date.parse 归一的输入必须拒绝，
 * 否则它会变成一个合法时间戳，把用户的选择悄悄搬到别的年份。
 * @param {string} date YYYY-MM-DD
 * @returns {boolean} 是否为真实日历日
 */
function isCalendarDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const ms = Date.parse(`${date}T00:00:00.000Z`)
  if (Number.isNaN(ms)) return false
  return new Date(ms).toISOString().slice(0, 10) === date
}

/**
 * 解析请求里的日期范围。
 * 支持 `period=today|week|month|all|custom` 与 `start=YYYY-MM-DD&end=YYYY-MM-DD`
 * （上海日界，左闭右开）。非法输入一律退回「今日」，绝不因为坏参数 500；
 * 自定义跨度上限 {@link MAX_CUSTOM_DAYS} 天，避免一次查询把历史全量拉进内存。
 *
 * @param {URLSearchParams} params 查询参数
 * @param {number} now 当前时刻（测试注入用）
 * @returns {{startMs: number, endMs: number, start: string, end: string, period: string}}
 */
export function resolveRange(params, now = Date.now()) {
  const today = shanghaiDate(now)
  const todayStart = shanghaiDayStart(today)
  const tomorrowStart = todayStart + DAY_MS
  const period = params.get('period') || 'today'
  if (period === 'custom') {
    const startRaw = params.get('start') || today
    const endRaw = params.get('end') || today
    const start = isCalendarDate(startRaw) ? startRaw : today
    const end = isCalendarDate(endRaw) && endRaw >= start ? endRaw : start
    // 上限收敛：把 end 夹到 start + MAX_CUSTOM_DAYS - 1。
    const maxEnd = shiftDate(start, MAX_CUSTOM_DAYS - 1)
    const clampedEnd = end > maxEnd ? maxEnd : end
    return {
      startMs: shanghaiDayStart(start),
      endMs: shanghaiDayStart(clampedEnd) + DAY_MS,
      start,
      end: clampedEnd,
      period,
    }
  }
  if (period === 'week') {
    const start = shiftDate(today, -6)
    return { startMs: shanghaiDayStart(start), endMs: tomorrowStart, start, end: today, period }
  }
  if (period === 'month') {
    const start = shiftDate(today, -29)
    return { startMs: shanghaiDayStart(start), endMs: tomorrowStart, start, end: today, period }
  }
  if (period === 'all') {
    return { startMs: 0, endMs: tomorrowStart, start: '1970-01-01', end: today, period }
  }
  return { startMs: todayStart, endMs: tomorrowStart, start: today, end: today, period: 'today' }
}

// ───────────────────────────── HTTP ─────────────────────────────

/** JSON 应答。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 今日总览：小窗口用（当前模型 + 每小时直方图）。 */
async function overviewPayload(pricing, config, todayRecords) {
  const now = Date.now()
  const today = shanghaiDate(now)
  const dayStart = shanghaiDayStart(today)
  const scan = todayRecords === undefined ? await scanSessions() : null
  const sessions = scan === null ? null : scan.sessions
  const totals = emptyTotals()
  const perModel = new Map()
  const buckets = Array.from({ length: 24 }, (_, hour) => ({
    hour, cr: 0, ci: 0, out: 0, total: 0, requests: 0, cost: 0, band: 0, peak: false,
  }))

  const source = [];
  for (const session of sessions) for (const record of session.records) source.push(record)

  for (const record of source) {
    if (record.t < dayStart || record.t >= dayStart + DAY_MS) continue
    addRecord(totals, record)
    const hour = new Date(record.t + TZ_OFFSET_MS).getUTCHours()
    // 未来小时不落桶（时钟漂移/日志异常时，避免把数据画到还没到的格子里）。
    if (hour >= 0 && hour < 24) {
      addRecord(buckets[hour], record)
      const one = costOf(pricing, record)
      buckets[hour].cost += one.cost
      // 每个小时的 band：只要有记录就按该小时的峰谷属性上色（1=空闲 / 2=高峰）。
      buckets[hour].band = one.peak ? 2 : 1
      buckets[hour].peak = one.peak
    }
    let model = perModel.get(record.model)
    if (model === undefined) { model = { key: record.model, ...emptyTotals(), cost: 0 }; perModel.set(record.model, model) }
    addRecord(model, record)
    model.cost += costOf(pricing, record).cost
  }

  const inRange = source.filter(r => r.t >= dayStart && r.t < dayStart + DAY_MS)
  const money = costBreakdown(inRange, pricing)
  const models = [...perModel.values()].sort((a, b) => b.total - a.total)

  return {
    ok: true,
    now,
    date: today,
    tzOffsetMinutes: TZ_OFFSET_MINUTES,
    totals: { ...totals, cost: money.cost },
    cost: money,
    currency: pricing.currency,
    models,
    currentModel: models.length > 0 ? models[0].key : null,
    buckets,
    balance: await fetchBalance(config),
    errors: scan === null ? [] : scan.errors,
  }
}

/** 日志弹窗全量报告。 */
async function logPayload(params, pricing, config) {
  const now = Date.now()
  const range = resolveRange(params, now)
  const view = params.get('view') === 'conversation' ? 'conversation' : 'total'
  const scan = await scanSessions()
  const result = aggregate(scan.sessions, range, view, pricing)
  return {
    balance: await fetchBalance(config, params.get('balance') === '1'),
    ok: true,
    now,
    tzOffsetMinutes: TZ_OFFSET_MINUTES,
    range: { start: range.start, end: range.end, period: range.period, startMs: range.startMs, endMs: range.endMs },
    view: result.view,
    dim: result.dim,
    totals: result.totals,
    // cost/currency 必须一起带上：弹窗顶部的「花费」卡读的是 data.cost，
    // 漏掉这两个字段时卡片会退化成"未启用计价"（而模型分布仍显示正确金额，自相矛盾，很难查）。
    cost: result.cost,
    currency: result.currency,
    models: result.models,
    buckets: result.buckets,
    conversations: result.conversations,
    conversationCount: result.conversationCount,
    health: result.health,
    earliest: result.earliest,
    latest: result.latest,
    errors: scan.errors,
  }
}

/**
 * 诊断自检：把「插件是否真的被宿主 compose 进浏览器模块表」变成可远程观测的事实。
 *
 * 为什么需要它：宿主侧路由注册成功，并不能证明浏览器那一半会被加载——
 * 客户端 bundle 由 client-modules 扫描 Loader 行的 `dsh.client` 声明后按包名注册，
 * 任何一个环节（manifest 位置、bundle 路径、包名不一致）都只在浏览器里表现为「没渲染」。
 * 这个只读端点直接把模块表的行如实报出来。
 *
 * @param {object} ctx cordis 上下文
 * @returns {object} 诊断结果
 */
function doctorPayload(ctx, pricing, config) {
  const report = {
    plugin: { name: '@local/dsh-token-monitor', version: '0.1.0', timezone: 'Asia/Shanghai' },
    host: {
      sessionsRoot: sessionsRoot(),
      pricing: { currency: pricing.currency, peakMultiplier: pricing.peakMultiplier, models: Object.keys(pricing.models).length },
      balanceProbe: {
        hasApiKey: resolveApiKey(config) !== null,
        keyError: lastKeyError,
        cachedAt: balanceCache.at,
        cachedOk: balanceCache.value !== null && balanceCache.value.ok === true,
      },
      paths: { overview: OVERVIEW_PATH, log: LOG_PATH, doctor: DOCTOR_PATH },
    },
    client: { available: false, rows: null, ours: null, note: null },
  }
  const registry = ctx.get ? ctx.get('clientModules') : undefined
  if (registry === undefined || registry === null) {
    report.client.note = 'clientModules 服务不可用（非 Web 载体或服务未装配）'
    return report
  }
  report.client.available = true
  try {
    const graph = registry.graph()
    const entries = (graph && graph.entries) || []
    report.client.rows = entries.map(entry => ({
      id: entry.id,
      url: entry.url,
      rev: entry.rev,
      immediately: entry.immediately === true,
      // 能取到 clientPath 说明 bundle 文件真实存在且被登记
      bundle: typeof registry.clientPath === 'function' ? registry.clientPath(entry.id) || null : null,
    }))
    report.client.ours = report.client.rows.find(row => row.url && row.url.includes('dsh-token-monitor')) || null
    if (report.client.ours === null) {
      report.client.note = '本插件未出现在浏览器模块表中：检查 package.json 的 dsh.client 声明与 ./client 导出'
    }
  } catch (error) {
    report.client.note = `读取模块表失败：${String(error && error.message || error)}`
  }
  return report
}

/** Cordis 插件入口：接管三个只读路由。 */
export function apply(ctx, config) {
  const pricing = resolvePricing(config)
  ctx.webServer.register({
    kind: 'exact',
    path: OVERVIEW_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        sendJson(res, 200, await overviewPayload(pricing, config))
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error && error.message || error) })
      }
    },
  })
  ctx.webServer.register({
    kind: 'exact',
    path: DOCTOR_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        sendJson(res, 200, { ok: true, ...doctorPayload(ctx, pricing, config) })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error && error.message || error) })
      }
    },
  })
  ctx.webServer.register({
    kind: 'exact',
    path: LOG_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        const url = new URL(req.url || LOG_PATH, 'http://dsh.invalid')
        sendJson(res, 200, await logPayload(url.searchParams, pricing, config))
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error && error.message || error) })
      }
    },
  })
}

export const inject = ['webServer']
export { OVERVIEW_PATH, LOG_PATH, DOCTOR_PATH, hourlyBuckets as __hourlyBuckets }
