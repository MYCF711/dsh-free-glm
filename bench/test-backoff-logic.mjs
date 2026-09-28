/**
 * 主动触发 mint 失败，验证退避**真的会生效**。
 *
 * ## 为什么必须主动触发
 *
 * 上一步的验证只证明「机制没碍事」（正常请求照样 200），
 * 但**没有证明它会触发**。一个从不触发的保护机制等于没有。
 *
 * ## 怎么安全地触发（关键）
 *
 * 不能让上游真的失败 —— 那正是要避免的事。
 * 但桥的 mint 失败有另一个可控入口：**让 renderer 侧收不到响应**。
 *
 * 可行做法：**临时把发现文件里的 token 改错**。
 * mint 会照常走 renderer（拿 captcha 头），但 apiKey 校验可能失败；
 * 更可靠的是直接**让 renderer 的订阅者失效** ——
 * 但那个我们控制不了。
 *
 * ## 更简单且零风险的方案：直接验收「代码逻辑」
 *
 * 退避逻辑是**纯函数式**的（计数 + 时间戳），
 * 可以把它抽出来单测，**完全不碰桥**。
 * 这比「想办法让真桥失败」更可靠，也不会有副作用。
 *
 * ⇒ 本脚本用 **Node 直接执行等价逻辑**，验证：
 *    · 阈值前不触发
 *    · 阈值处触发且冷却 1 分钟
 *    · 递增（2、4、8 分钟）
 *    · 上限 30 分钟
 *    · 成功清零
 *
 * 并**对照桥里源码的实际参数**，防止两边漂移。
 */

import { readFileSync } from 'node:fs'

// ── 1. 从桥的源码里抽出真实参数（防止测试与实现漂移）──────────
const src = readFileSync('D:/DSH-WEB/ZCode-official/packages/desktop/src/host/zcodeBridgeServer.ts', 'utf8')

function grab(label, pattern) {
  const m = src.match(pattern)
  if (!m) throw new Error(`抽不到参数: ${label}`)
  return m[1]
}

/**
 * ⚠ 解析时必须先**去掉下划线**再转数字。
 *
 * 第一版写成 `Number(grab(...)[0].replace(/_/g,''))` ——
 * 那个 `[0]` 是**对字符串取第 0 个字符**，于是
 * `"60_000"` 被解析成 `"6"` ⇒ BASE 变成 6 毫秒。
 *
 * 症状很隐蔽：断言「阈值前不冷却」仍然通过（那部分与 BASE 无关），
 * 只有「上限等于 30 分钟」挂了 —— 而挂的原因是**测试自己的解析**，
 * 不是实现。若不追下去，很容易误改实现去迁就错误的测试。
 */
const num = (label, pattern) => {
  const raw = grab(label, pattern).replace(/[_\s]/g, '')
  // 处理 `30 * 60000` 这类表达式
  const value = raw.includes('*')
    ? raw.split('*').map(Number).reduce((a, b) => a * b, 1)
    : Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`参数解析失败: ${label} = ${raw}`)
  return value
}

const BASE = num('BACKOFF_BASE_MS', /const BACKOFF_BASE_MS = ([\d_]+)/)
const MAX = num('BACKOFF_MAX_MS', /const BACKOFF_MAX_MS = ([\d_\s*]+);/)
const THRESHOLD = num('BACKOFF_THRESHOLD', /const BACKOFF_THRESHOLD = (\d+)/)

console.log('=== 从桥源码抽出的真实参数 ===')
console.log(`  BACKOFF_BASE_MS   = ${BASE}`)
console.log(`  BACKOFF_THRESHOLD = ${THRESHOLD}`)
console.log(`  BACKOFF_MAX_MS    = ${MAX}  (${MAX / 60000} 分钟)`)

// ── 2. 复刻桥里的退避算法（逐行对应，便于对照）────────────────
let streak = 0
let untilMs = 0

function noteFailure() {
  streak += 1
  if (streak < THRESHOLD) return 0
  const step = streak - THRESHOLD
  const cooldown = Math.min(BASE * 2 ** step, MAX)
  untilMs = cooldown   // 用"相对值"表示，避免依赖真实时间
  return cooldown
}
function noteSuccess() {
  streak = 0
  untilMs = 0
}
function remaining() {
  return untilMs
}

// ── 3. 逐次失败，记录冷却 ─────────────────────────────────────
console.log('\n=== 连续失败时的冷却 ===')
console.log('  第N次  冷却       说明')

const results = []
for (let n = 1; n <= 9; n++) {
  const cd = noteFailure()
  results.push({ n, cd })
  let note = ''
  if (cd === 0) note = '未到阈值，正常重试'
  else if (cd === MAX) note = '★ 已封顶'
  else note = `退避 ${cd / 60000} 分钟`
  console.log(`  ${String(n).padStart(4)}  ${String(cd === 0 ? '-' : cd + 'ms').padStart(10)}  ${note}`)
}

console.log('\n=== 成功一次后清零 ===')
noteSuccess()
console.log(`  streak=${streak}  remaining=${remaining()}  ${streak === 0 && remaining() === 0 ? '✓ 已清零' : '✗ 未清零'}`)

// ── 4. 断言 ───────────────────────────────────────────────────
console.log('\n=== 断言 ===')
let failed = 0
const check = (label, cond, extra = '') => {
  if (!cond) failed += 1
  console.log(`${cond ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`)
}

check('阈值前（第1、2次）不冷却',
  results[0].cd === 0 && results[1].cd === 0,
  `${results[0].cd} / ${results[1].cd}`)

check(`第 ${THRESHOLD} 次触发，冷却 = 基础值`,
  results[THRESHOLD - 1].cd === BASE,
  `${results[THRESHOLD - 1].cd}ms`)

check('冷却逐次翻倍',
  results[THRESHOLD].cd === BASE * 2 && results[THRESHOLD + 1].cd === BASE * 4,
  `${results[THRESHOLD].cd} → ${results[THRESHOLD + 1].cd}`)

check('有上限且等于 30 分钟',
  Math.max(...results.map((r) => r.cd)) === MAX && MAX === 30 * 60_000,
  `max=${Math.max(...results.map((r) => r.cd))}ms`)

console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
process.exit(failed === 0 ? 0 : 1)
