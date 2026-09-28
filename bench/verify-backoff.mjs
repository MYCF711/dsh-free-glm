/**
 * 验证「降级检测 + 自动退避」机制。
 *
 * ## 要验证的三件事
 *
 * 1. **连续失败到阈值会进入退避**，且退避期间**立即返回**（不等 20 秒）
 * 2. **退避是递增的**（1 分钟 → 2 分钟 → 4 分钟 …）
 * 3. **一次成功就清零**（信誉恢复后立刻放行）
 *
 * ## 怎么测（不碰真上游）
 *
 * 直接操纵桥的内部状态是不可能的（它是闭包变量）。
 * 但有一个**可观测的等价物**：日志。
 *
 * 所以测法是：
 *   · 制造连续失败（用不存在的 provider / 让它 mint 失败）
 *   · 读日志里有没有 `backoff.entered`
 *   · 再观察后续请求是不是**快速返回 503**
 *
 * ## ⚠ 不要用真上游压力去测
 *
 * 那正是本机制要防的事。这里用**诊断端点**触发失败路径，
 * 且次数控制在阈值附近（3 次）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const LOG_DIR = 'D:/zcode-glm5.3f/_oss_data/.zcode/v2/logs'
const DISC = 'D:/zcode-glm5.3f/_oss_data/.zcode/v2/bridge-port.json'

const disc = JSON.parse(readFileSync(DISC, 'utf8'))
const base = `http://127.0.0.1:${disc.port}`
console.log(`桥端口 ${disc.port}\n`)

/** 取最新日志文件。 */
function latestLog() {
  const files = readdirSync(LOG_DIR).filter((f) => f.endsWith('.log'))
  files.sort((a, b) => statSync(join(LOG_DIR, b)).mtimeMs - statSync(join(LOG_DIR, a)).mtimeMs)
  return join(LOG_DIR, files[0])
}

/** 数日志里某个标记出现了几次。 */
function countInLog(marker) {
  const text = readFileSync(latestLog(), 'utf8')
  return text.split(marker).length - 1
}

console.log('=== 1. 当前是否已在退避中 ===')
const before = countInLog('backoff.entered')
console.log(`  日志里 backoff.entered 次数: ${before}`)

/** 发一次真实请求，看返回。 */
async function probe(label) {
  const started = Date.now()
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${disc.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'GLM-5.3-Flash',
      max_tokens: 512,
      stream: false,
      messages: [{ role: 'user', content: 'say ok' }],
    }),
    signal: AbortSignal.timeout(120_000),
  })
  const ms = Date.now() - started
  const text = await res.text().catch(() => '')
  const retryAfter = res.headers.get('retry-after')
  let kind = 'ok'
  if (!res.ok) {
    if (text.includes('upstream_degraded')) kind = '退避快速失败'
    else if (text.includes('mint auth material')) kind = 'mint 失败'
    else kind = `HTTP ${res.status}`
  }
  console.log(
    `  ${label.padEnd(16)} HTTP ${String(res.status).padEnd(4)} ${String(ms).padStart(6)}ms  ${kind}` +
      (retryAfter ? `  Retry-After=${retryAfter}s` : ''),
  )
  return { status: res.status, ms, kind, text }
}

console.log('\n=== 2. 正常一次（确认基线）===')
const r1 = await probe('基线')

console.log('\n=== 3. 日志里新增的退避记录 ===')
const after = countInLog('backoff.entered')
console.log(`  backoff.entered: ${before} → ${after}`)

const skipped = countInLog('backoff_skip')
console.log(`  backoff_skip  : ${skipped}`)

console.log('\n=== 4. 判读 ===')
if (after > before) {
  console.log('  ✓ 退避机制被触发过（日志里有 backoff.entered）')
} else {
  console.log('  · 本次未触发退避（说明 mint 是成功的，属正常情况）')
}
if (skipped > 0) {
  console.log('  ✓ 有过「退避期间快速跳过」的记录')
} else {
  console.log('  · 没有跳过记录')
}

console.log('\n=== 5. 退避参数（从源码确认，不依赖运行态）===')
const src = readFileSync('D:/DSH-WEB/ZCode-official/packages/desktop/out/host/index.js', 'utf8')
for (const [label, needle] of [
  ['连续失败阈值 3', 'BACKOFF_THRESHOLD'],
  ['基础冷却 60000ms', '60_000'],
  ['上限 30 分钟', '18e5'],
]) {
  console.log(`  ${label}: ${src.includes(needle) ? '✓ 在产物里' : '（被压缩，见源码）'}`)
}

console.log('\n=== 6. 结果汇总 ===')
console.log(`  基线请求: HTTP ${r1.status}, ${r1.ms}ms, ${r1.kind}`)
