/**
 * 闭环迭代拖动 —— **先验证收敛性，不提交**。
 *
 * ## 思路（不依赖任何拟合常数）
 *
 * 已知：
 *   · 缺口在屏幕上的中心 x（由图像测量 + 缩放换算）
 *   · 拼图块**当前**内容中心 x（每步实时读 DOM）
 *
 * 迭代：
 *   1. 按下
 *   2. 读拼图块位置 → 算差值 `d = 缺口x − 拼图块x`
 *   3. 若 |d| < 2px → 收敛，可以松开
 *      否则把鼠标再向右移 `d`，等动画稳定，回到 2
 *   4. **本轮不松开** —— 直接拖回起点释放，只观察收敛性
 *
 * 为什么这样可行：滑块的位移与拼图块位置之间是**单调**关系
 *（拖得越多、拼图块越靠右），所以简单迭代必然收敛。
 * 唯一要处理的是**非线性**（不能一次到位），迭代天然解决。
 *
 * ## 安全设计
 *
 * 本脚本**不提交**。它验证的只有一件事：迭代能否稳定收敛到 |d| < 2。
 * 收敛性确认后，才写另一个脚本真提交。
 */

const CDP = 'http://127.0.0.1:9229'

import { readFileSync } from 'node:fs'
const gap = JSON.parse(readFileSync('D:/zcode-glm5.3f/_gap_measure.json', 'utf8'))

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

const read = async () => JSON.parse(await ev(
  `JSON.stringify((() => {` +
  ` const sl = document.getElementById('aliyunCaptcha-sliding-slider');` +
  ` const pz = document.getElementById('aliyunCaptcha-puzzle');` +
  ` const im = document.getElementById('aliyunCaptcha-img');` +
  ` const box = document.getElementById('aliyunCaptcha-img-box');` +
  ` if (!sl || !pz) return { gone: true };` +
  ` const b = (n) => { const r = n.getBoundingClientRect(); return { x: r.left, w: r.width }; };` +
  ` return { slider: b(sl), puzzle: b(pz), imgBox: b(box), imgW: im ? im.naturalWidth : null };` +
  `})())`,
))

const st = await read()
if (st.gone) { console.log('滑块不存在'); ws.close(); process.exit(0) }

const scale = st.imgBox.w / st.imgW
const gapScreenX = st.imgBox.x + gap.center * scale
/** 拼图块内容在其容器内的偏移（前面量到不透明区 x=2..50） */
const PIECE_LEFT = 2
const PIECE_W = 49
const pieceCenter = (s) => s.puzzle.x + PIECE_LEFT + PIECE_W / 2

console.log('=== 目标 ===')
console.log(`  缺口屏幕中心 x = ${gapScreenX.toFixed(1)}`)
console.log(`  拼图块内容中心 = ${pieceCenter(st).toFixed(1)}`)
console.log(`  差 = ${(gapScreenX - pieceCenter(st)).toFixed(1)}`)

const startX = Math.round(st.slider.x + st.slider.w / 2)
const startY = Math.round(st.slider.y + st.slider.h / 2)
const mouse = (type, x, y, extra = {}) =>
  send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra })

console.log('\n=== 闭环迭代（不松开）===')
console.log('  轮次  鼠标X    拼图块中心X   差值d    动作')

await mouse('mousePressed', startX, startY, { buttons: 1 })
await new Promise((r) => setTimeout(r, 100))

let mouseX = startX
let converged = false

for (let round = 1; round <= 10; round++) {
  const s = await read()
  const pc = pieceCenter(s)
  const d = gapScreenX - pc

  if (Math.abs(d) < 2) {
    console.log(
      `  ${String(round).padStart(3)}  ${String(Math.round(mouseX)).padStart(6)}  ` +
      `${pc.toFixed(1).padStart(11)}  ${d.toFixed(1).padStart(6)}   ✓ 收敛`,
    )
    converged = true
    break
  }

  /**
   * ⚠ 不能直接移 `d`：位移 → 拼图块位置是**非线性的**（实测放大率 0.43→0.86 递增）。
   *   一步移 `d` 会过冲。故用**阻尼**：只移 `d × 0.7`，
   *   让多轮迭代逐步逼近，既稳又不会来回振荡。
   */
  const step = d * 0.7
  mouseX += step
  console.log(
    `  ${String(round).padStart(3)}  ${String(Math.round(mouseX)).padStart(6)}  ` +
    `${pc.toFixed(1).padStart(11)}  ${d.toFixed(1).padStart(6)}   移 ${step.toFixed(1)}`,
  )

  // 分几小步移动（避免被识别为跳变）
  const from = mouseX - step
  for (let i = 1; i <= 6; i++) {
    await mouse('mouseMoved', from + (step * i) / 6, startY, { buttons: 1 })
    await new Promise((r) => setTimeout(r, 18))
  }
  // 等动画稳定（实测有缓动）
  await new Promise((r) => setTimeout(r, 450))
}

console.log(`\n  收敛: ${converged ? '✓ 是' : '✗ 否（10 轮内未收敛）'}`)
if (converged) {
  const s = await read()
  console.log(`  最终拼图块中心 = ${pieceCenter(s).toFixed(1)}   目标 = ${gapScreenX.toFixed(1)}`)
}

// ── 拖回起点释放（不提交）────────────────────────────────────
console.log('\n=== 复位（不提交）===')
const back = mouseX - startX
for (let i = 6; i >= 0; i--) {
  await mouse('mouseMoved', startX + (back * i) / 6, startY, { buttons: 1 })
  await new Promise((r) => setTimeout(r, 18))
}
await mouse('mouseReleased', startX, startY, { buttons: 0 })
await new Promise((r) => setTimeout(r, 600))
const fin = await read()
console.log(`  复位后拼图块 x = ${fin.gone ? 'gone' : fin.puzzle.x}`)

ws.close()
