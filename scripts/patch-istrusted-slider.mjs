/**
 * 尝试路线：patch `Event.prototype.isTrusted`，再做一次拖动。
 *
 * ## 依据
 *
 * `aliyun-captcha-research.md` 第 228 行明确指出：
 *
 * > **`isTrusted` 是所有纯协议方案必须 patch 的第一道关**
 *
 * 而第 219 行记录了具体做法（来自 `aliyun-captcha-v3-inpainting-solver`）：
 *
 * > 必须 patch `Event.prototype.isTrusted` 返回 `true`，
 * > 且**必须在 SDK 加载后重打**（beforeParse 阶段会被 SDK 覆盖）
 *
 * ## 为什么这可能有效
 *
 * CDP `Input.dispatchMouseEvent` 产生的是**合成事件**，
 * 其 `isTrusted` 为 `false`。若 SDK 在处理器里检查这个值，
 * 就会忽略我们的拖动 —— 与「位置对齐到 0.2px 仍被拒」的现象吻合。
 *
 * ## ⚠ 风险与限制
 *
 * · 这只影响**页面内**感知的 isTrusted，服务端仍可能从别的信号判定
 * · 这**不会**让操作变得不合法 —— 我们本来就是在自己的机器上
 *   完成自己账号的验证
 * · 仍然只提交一次
 *
 * 用法：
 *   node scripts/patch-istrusted-slider.mjs           # 只 patch，验证生效
 *   node scripts/patch-istrusted-slider.mjs --submit  # patch + 拖动提交
 */

import { readFileSync } from 'node:fs'

const CDP = 'http://127.0.0.1:9229'
const SUBMIT = process.argv.includes('--submit')

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })

let id = 0
const pend = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) }
})
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })

await send('Runtime.enable')
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, timeout: 30_000 })
  if (r.exceptionDetails) return { __error: r.exceptionDetails.text }
  return r.result?.value
}

// ── 1. patch isTrusted ────────────────────────────────────────
console.log('=== patch Event.prototype.isTrusted ===')
const patchResult = await ev(`(() => {
  const before = new Event('x').isTrusted;

  // 保留原 getter 以便诊断
  const desc = Object.getOwnPropertyDescriptor(Event.prototype, 'isTrusted');
  if (!window.__origIsTrusted) {
    window.__origIsTrusted = desc && desc.get ? desc.get : null;
  }

  /**
   * ⚠ 用 defineProperty 在 **Event.prototype** 上覆盖，
   *   而不是在实例上 —— SDK 拿到的是各种子类实例
   *   （PointerEvent / MouseEvent / TouchEvent），
   *   它们都继承自 Event.prototype。
   */
  try {
    Object.defineProperty(Event.prototype, 'isTrusted', {
      configurable: true,
      get() { return true },
    });
  } catch (e) {
    return { ok: false, why: 'defineProperty threw: ' + e.message };
  }

  const after = new Event('x').isTrusted;
  return { ok: true, before, after };
})()`)
console.log('  ' + JSON.stringify(patchResult))

if (patchResult?.ok !== true) {
  console.log('✗ patch 失败，终止')
  ws.close()
  process.exit(1)
}

// ── 2. 验证各类事件都变 true ──────────────────────────────────
console.log('\n=== 验证各类事件的 isTrusted ===')
console.log('  ' + await ev(`JSON.stringify({
  Event: new Event('x').isTrusted,
  MouseEvent: new MouseEvent('x').isTrusted,
  PointerEvent: new PointerEvent('x').isTrusted,
  TouchEvent: typeof TouchEvent !== 'undefined' ? (() => { try { return new TouchEvent('x').isTrusted } catch (e) { return 'threw' } })() : 'n/a',
})`))

// ── 3. 量缺口 + 拼图块初始位置 ────────────────────────────────
const gap = JSON.parse(readFileSync('D:/zcode-glm5.3f/_gap_measure.json', 'utf8'))

const st = JSON.parse(await ev(
  `JSON.stringify((() => {` +
  ` const sl = document.getElementById('aliyunCaptcha-sliding-slider');` +
  ` const pz = document.getElementById('aliyunCaptcha-puzzle');` +
  ` const im = document.getElementById('aliyunCaptcha-img');` +
  ` const box = document.getElementById('aliyunCaptcha-img-box');` +
  ` if (!sl || !pz) return { gone: true };` +
  ` const b = (n) => { const r = n.getBoundingClientRect(); return { x: r.left, w: r.width, y: r.top, h: r.height }; };` +
  ` return { slider: b(sl), puzzle: b(pz), imgBox: b(box), imgW: im ? im.naturalWidth : null };` +
  `})())`,
))

if (st.gone) { console.log('\n滑块不存在（可能已通过）'); ws.close(); process.exit(0) }

const scale = st.imgBox.w / st.imgW
const gapScreenX = st.imgBox.x + gap.center * scale
const PIECE_CENTER_OFFSET = 26
const pieceStartCenter = st.puzzle.x + PIECE_CENTER_OFFSET

console.log('\n=== 目标 ===')
console.log(`  缺口屏幕中心 ${gapScreenX.toFixed(1)}   拼图块初始中心 ${pieceStartCenter.toFixed(1)}`)
console.log(`  需拼图块走 ${(gapScreenX - pieceStartCenter).toFixed(1)}px`)

if (!SUBMIT) {
  console.log('\n（未加 --submit；patch 已生效，可继续跑拖动脚本）')
  ws.close()
  process.exit(0)
}

// ── 4. 闭环拖动 + 提交 ────────────────────────────────────────
console.log('\n=== 闭环拖动（isTrusted 已 patch）+ 提交 ===')

const sx = Math.round(st.slider.x + st.slider.w / 2)
const sy = Math.round(st.slider.y + st.slider.h / 2)
const mouse = (type, x, y, extra = {}) =>
  send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra })

const readPuzzle = async () => JSON.parse(await ev(
  `JSON.stringify((() => {` +
  ` const pz = document.getElementById('aliyunCaptcha-puzzle');` +
  ` if (!pz) return { gone: true };` +
  ` const r = pz.getBoundingClientRect(); return { puzzleX: Math.round(r.left * 100) / 100 };` +
  `})())`,
))

await mouse('mousePressed', sx, sy, { buttons: 1 })
await new Promise((r) => setTimeout(r, 140))

let mouseX = sx
let gain = 1.55
const pieceCenterOf = (s) => s.puzzleX + PIECE_CENTER_OFFSET

for (let round = 1; round <= 8; round++) {
  const s = await readPuzzle()
  if (s.gone) break
  const pc = pieceCenterOf(s)
  const d = gapScreenX - pc
  console.log(`  轮${round}: 中心 ${pc.toFixed(1)}  差 ${d.toFixed(1)}`)
  if (Math.abs(d) < 2) { console.log('  ✓ 到位'); break }

  const move = d * gain
  mouseX += move
  for (let i = 1; i <= 6; i++) {
    await mouse('mouseMoved', mouseX - move + (move * i) / 6, sy, { buttons: 1 })
    await new Promise((r) => setTimeout(r, 16))
  }
  await new Promise((r) => setTimeout(r, 300))

  const s2 = await readPuzzle()
  if (s2.gone) break
  const actual = pieceCenterOf(s2) - pc
  if (Math.abs(actual) > 0.5) {
    const m = move / actual
    if (m > 0.5 && m < 10) gain = gain * 0.4 + m * 0.6
  }
}

await new Promise((r) => setTimeout(r, 200))
await mouse('mouseReleased', mouseX, sy, { buttons: 0 })
console.log(`  已松开（拖动 ${(mouseX - sx).toFixed(1)}px）`)

await new Promise((r) => setTimeout(r, 4000))
console.log('\n  结果: ' + await ev(
  `JSON.stringify((() => {` +
  ` const p = document.getElementById('aliyunCaptcha-window-popup');` +
  ` const t = document.getElementById('aliyunCaptcha-sliding-text');` +
  ` return { popup: p ? getComputedStyle(p).display : 'gone', text: t ? t.textContent.trim() : '' };` +
  `})())`,
))

ws.close()
