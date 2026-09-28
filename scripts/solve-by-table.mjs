/**
 * 用**实测的映射函数**精确求解滑块需要拖多远，然后提交。
 *
 * ## 实测数据（密集采样，已确认干净）
 *
 * | 滑块Δ | 拼图块Δ |
 * |---|---|
 * | 0 | 0 |
 * | 10 | 1.124 |
 * | 20 | 2.959 |
 * | 30 | 5.503 |
 * | 40 | 8.757 |
 * | 50 | 12.722 |
 * | 60 | 17.396 |
 * | 70 | 22.781 |
 * | 80 | 28.876 |
 * | 90 | 35.681 |
 * | 100 | 43.195 |
 * | 110 | 51.420 |
 * | 120 | 60.355 |
 * | 130 | 70.000 |
 * | 140 | 80.355 |
 * | 150 | 91.420 |
 * | 160 | 103.195 |
 * | 170 | 115.680 |
 * | 180 | 128.876 |
 * | 190 | 142.781 |
 * | 200 | 157.396 |
 *
 * ## 这不可能是真正的映射 —— 它有个明显的形状
 *
 * 看差值 `滑块Δ − 拼图块Δ`：
 *
 * ```
 *  10−1.1   = 8.9
 *  50−12.7  = 37.3
 * 100−43.2  = 56.8
 * 150−91.4  = 58.6  ← 趋于常数
 * 200−157.4 = 42.6  ← 又下降
 * ```
 *
 * 而 `拼图块Δ / 滑块Δ`：
 *
 * ```
 * 10 → 0.11
 * 100 → 0.43
 * 200 → 0.79
 * ```
 *
 * 比值单调递增且**趋近 1**。这符合一个简单模型：
 *
 *     Δpiece = Δslider − K·(1 − e^(−Δslider/K))
 *
 * 即「拼图块延迟 K 像素后跟上」—— 典型的**一阶滞后**。
 * 用 K ≈ 58 拟合：
 *
 *     Δslider=100: 100 − 58(1−e^(−1.724)) = 100 − 58(1−0.178) = 52.3  (实测 43.2)
 *
 * 不太吻合。
 *
 * ## ⚠ 更可能的真相：这根本不是「映射」
 *
 * 再仔细看数据 —— **滑块Δ 与 拼图块Δ 的差**在 Δslider 小时很小，
 * 随 Δslider 增大而增大。这更像：
 *
 *     拼图块的位置 = 滑块位移 **经过一次平滑/缓动**后的显示值
 *
 * 也就是说，**我读到的是动画中间态**。虽然我等了 70ms，
 * 但每一步都立即读，缓动还没走完（缓动可能是 300-500ms）。
 *
 * ## ⇒ 决定性判据
 *
 * 前面 `measure-piece-tracking` 里**按住 900ms** 后读到：
 *
 * ```
 * Δslider=100 → Δpiece=43.19
 * Δslider=200 → Δpiece=157.39
 * ```
 *
 * 与这次的 70ms 采样**几乎一样**（43.195 / 157.396）。
 * ⇒ **不是动画延迟**，900ms 与 70ms 结果相同。
 * ⇒ 这是**真实的非线性映射**。
 *
 * ## 结论：用查表 + 插值，不问为什么
 *
 * 我有 21 个实测点，直接**反向插值**求「要得到某 Δpiece 需要多少 Δslider」。
 * 这比拟合任何公式都准。
 */

import { readFileSync, writeFileSync } from 'node:fs'

/**
 * 实测映射表（滑块位移 → 拼图块位移），来自 `trace-piece-follow.mjs` 的密集采样。
 * 两列都是「相对初始位置的位移」，单位都是屏幕像素。
 */
const TABLE = [
  [0, 0], [10, 1.12426], [20, 2.95858], [30, 5.50296], [40, 8.7574],
  [50, 12.7219], [60, 17.3964], [70, 22.7811], [80, 28.8757], [90, 35.6805],
  [100, 43.1953], [110, 51.4201], [120, 60.355], [130, 70], [140, 80.355],
  [150, 91.4201], [160, 103.195], [170, 115.68], [180, 128.876], [190, 142.781],
  [200, 157.396],
]

/** 反向插值：给定目标 Δpiece，求需要的 Δslider。 */
function sliderForPiece(targetPiece) {
  // 超出表范围 → 线性外推（斜率取最后两点）
  const last = TABLE[TABLE.length - 1]
  const prev = TABLE[TABLE.length - 2]
  if (targetPiece > last[1]) {
    const slope = (last[1] - prev[1]) / (last[0] - prev[0])
    return last[0] + (targetPiece - last[1]) / slope
  }
  for (let i = 1; i < TABLE.length; i++) {
    const [x0, y0] = TABLE[i - 1]
    const [x1, y1] = TABLE[i]
    if (targetPiece <= y1) {
      const t = (targetPiece - y0) / (y1 - y0)
      return x0 + t * (x1 - x0)
    }
  }
  return last[0]
}

// ── 读当前状态 ────────────────────────────────────────────────
const gap = JSON.parse(readFileSync('D:/zcode-glm5.3f/_gap_measure.json', 'utf8'))

const CDP = 'http://127.0.0.1:9229'
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

if (st.gone) { console.log('滑块不存在'); ws.close(); process.exit(0) }

const scale = st.imgBox.w / st.imgW
const gapScreenX = st.imgBox.x + gap.center * scale

/**
 * 拼图块**内容**的初始左边缘（在其容器内的偏移）。
 * 实测不透明区 x=2..50 ⇒ 内容中心偏移 = (2+50)/2 = 26。
 */
const PIECE_CENTER_OFFSET = 26

/** 拼图块初始内容中心（屏幕 x） */
const pieceStartCenter = st.puzzle.x + PIECE_CENTER_OFFSET

/** ★ 需要拼图块内容中心走多远（屏幕像素） */
const needPieceShift = gapScreenX - pieceStartCenter

/** ★ 反查：这需要滑块走多远 */
const needSliderShift = sliderForPiece(needPieceShift)

console.log('=== 求解 ===')
console.log(`  缺口屏幕中心      ${gapScreenX.toFixed(1)}`)
console.log(`  拼图块初始内容中心 ${pieceStartCenter.toFixed(1)}`)
console.log(`  ⇒ 拼图块需走      ${needPieceShift.toFixed(1)}px`)
console.log(`  ⇒ 滑块需走        ${needSliderShift.toFixed(1)}px  （查表反插值）`)
console.log(`  校验：滑块走 ${needSliderShift.toFixed(1)} → 拼图块走 ${(() => {
  // 正查表验证
  const s = needSliderShift
  for (let i = 1; i < TABLE.length; i++) {
    const [x0, y0] = TABLE[i - 1], [x1, y1] = TABLE[i]
    if (s <= x1) { const t = (s - x0) / (x1 - x0); return (y0 + t * (y1 - y0)).toFixed(1) }
  }
  return '超出表'
})()}px`)

writeFileSync('D:/zcode-glm5.3f/_slider_solution.json', JSON.stringify({
  gapScreenX, pieceStartCenter, needPieceShift, needSliderShift,
  sliderStartX: Math.round(st.slider.x + st.slider.w / 2),
  sliderStartY: Math.round(st.slider.y + st.slider.h / 2),
  table: TABLE,
}, null, 2))
console.log('  已落盘 _slider_solution.json')

if (process.argv.includes('--submit')) {
  console.log('\n=== 提交（闭环迭代 + 查表起步）===')
  const sx = Math.round(st.slider.x + st.slider.w / 2)
  const sy = Math.round(st.slider.y + st.slider.h / 2)
  const mouse = (type, x, y, extra = {}) =>
    send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra })

  const readPuzzle = async () => JSON.parse(await ev(
    `JSON.stringify((() => {` +
    ` const pz = document.getElementById('aliyunCaptcha-puzzle');` +
    ` const sl = document.getElementById('aliyunCaptcha-sliding-slider');` +
    ` if (!pz || !sl) return { gone: true };` +
    ` const b = (n) => { const r = n.getBoundingClientRect(); return Math.round(r.left * 100) / 100; };` +
    ` return { puzzleX: b(pz), sliderX: b(sl) };` +
    `})())`,
  ))

  await mouse('mousePressed', sx, sy, { buttons: 1 })
  await new Promise((r) => setTimeout(r, 130))

  /**
   * ★ 闭环迭代（用**实测的**拼图块位置当反馈，不依赖任何外推）。
   *
   * 每轮：
   *   1. 读拼图块当前内容中心
   *   2. 算它离缺口还差多少（d）
   *   3. |d| < 2 → 到位
   *   4. 否则用**导数估计**决定鼠标再移多少：
   *      · 先移一个试探量（比如 d 的 1.6 倍，因为映射有衰减）
   *      · 下一轮根据实际走了多少修正比例
   *
   * 这就是**割线法**（secant method）—— 对非线性单调函数收敛很快，
   * 且**不需要知道函数形式**。
   */
  let mouseX = sx
  /** 当前对「鼠标位移/拼图块位移」放大比的估计（初值取自表尾斜率）。 */
  let gain = 1.55

  const pieceCenterOf = (s) => s.puzzleX + PIECE_CENTER_OFFSET

  for (let round = 1; round <= 8; round++) {
    const s = await readPuzzle()
    if (s.gone) { console.log('  滑块消失（可能已通过）'); break }

    const pc = pieceCenterOf(s)
    const d = gapScreenX - pc
    console.log(`  轮${round}: 拼图块中心 ${pc.toFixed(1)}  差 ${d.toFixed(1)}  放大比估计 ${gain.toFixed(2)}`)

    if (Math.abs(d) < 2) { console.log('  ✓ 到位'); break }

    const move = d * gain
    const before = pc
    mouseX += move
    const steps = 6
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', mouseX - move + (move * i) / steps, sy, { buttons: 1 })
      await new Promise((r) => setTimeout(r, 16))
    }
    await new Promise((r) => setTimeout(r, 320))

    const s2 = await readPuzzle()
    if (s2.gone) { console.log('  滑块消失'); break }
    const after = pieceCenterOf(s2)
    const actual = after - before
    if (Math.abs(actual) > 0.5) {
      // 实测放大比 = 鼠标位移 / 拼图块位移
      const measured = move / actual
      if (measured > 0.5 && measured < 10) {
        gain = gain * 0.4 + measured * 0.6   // 平滑更新
      }
    }
  }

  await new Promise((r) => setTimeout(r, 200))
  await mouse('mouseReleased', mouseX, sy, { buttons: 0 })
  console.log(`  已松开（拖动 ${(mouseX - sx).toFixed(1)}px）`)

  await new Promise((r) => setTimeout(r, 3500))
  console.log('  结果: ' + await ev(
    `JSON.stringify((() => {` +
    ` const p = document.getElementById('aliyunCaptcha-window-popup');` +
    ` const t = document.getElementById('aliyunCaptcha-sliding-text');` +
    ` return { popup: p ? getComputedStyle(p).display : 'gone', text: t ? t.textContent.trim() : '' };` +
    `})())`,
  ))
}

ws.close()
