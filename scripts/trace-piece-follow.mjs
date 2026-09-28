/**
 * 弄清拼图块到底受什么驱动。
 *
 * ## 矛盾的数据
 *
 * | 实验 | 拖动 | 拼图块 |
 * |---|---|---|
 * | `measure-piece-tracking`（按住 900ms 后读） | 100/150/200/220 | 43/91/157/189 ← **动了** |
 * | `iterate-slider`（每轮读一次） | 越拖越远 | **一直 476.5** ← 没动 |
 *
 * 两次都是 CDP 真实鼠标事件，结果不同。可能原因：
 *
 * A. 拼图块只在**首次**按下-拖动时跟随，之后锁定
 * B. `iterate-slider` 读的时机不对（读到动画起始帧）
 * C. 两个脚本的移动方式不同（前者分 10 步、后者分 6 步）
 *
 * ## 怎么查
 *
 * 在一次按下期间**密集连续采样**拼图块位置（每 50ms 一次），
 * 同时移动鼠标 —— 画出「鼠标位置 vs 拼图块位置」的时序曲线。
 * 这样能一眼看出跟随关系与延迟。
 *
 * 不提交（最后拖回起点释放）。
 */

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

const read = async () => JSON.parse(await ev(
  `JSON.stringify((() => {` +
  ` const pz = document.getElementById('aliyunCaptcha-puzzle');` +
  ` const sl = document.getElementById('aliyunCaptcha-sliding-slider');` +
  ` if (!pz || !sl) return { gone: true };` +
  ` const b = (n) => { const r = n.getBoundingClientRect(); return { x: Math.round(r.left*10)/10, w: Math.round(r.width) }; };` +
  ` return { puzzle: b(pz), slider: b(sl),` +
  `   pzInlineLeft: pz.style.left, pzCssLeft: getComputedStyle(pz).left,` +
  `   pzTransform: getComputedStyle(pz).transform,` +
  `   slCssLeft: getComputedStyle(sl).left };` +
  `})())`,
))

const st0 = await read()
console.log('=== 初始 ===')
console.log('  ' + JSON.stringify(st0))

const startX = Math.round(st0.slider.x + st0.slider.w / 2)
const startY = 479
const mouse = (type, x, y, extra = {}) =>
  send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra })

console.log('\n=== 一次按下期间：密集采样 ===')
await mouse('mousePressed', startX, startY, { buttons: 1 })
await new Promise((r) => setTimeout(r, 100))

console.log('  鼠标X    滑块X    拼图块X   拼图块style.left   transform')
for (let step = 0; step <= 20; step++) {
  const mx = startX + step * 10
  await mouse('mouseMoved', mx, startY, { buttons: 1 })
  await new Promise((r) => setTimeout(r, 70))
  const s = await read()
  if (s.gone) { console.log('    滑块消失'); break }
  console.log(
    `  ${String(mx).padStart(6)}  ${String(s.slider.x).padStart(6)}  ${String(s.puzzle.x).padStart(8)}  ` +
    `${String(s.pzInlineLeft).padStart(14)}   ${s.pzTransform}`,
  )
}

// 复位释放
for (let step = 20; step >= 0; step--) {
  await mouse('mouseMoved', startX + step * 10, startY, { buttons: 1 })
  await new Promise((r) => setTimeout(r, 20))
}
await mouse('mouseReleased', startX, startY, { buttons: 0 })
await new Promise((r) => setTimeout(r, 500))
console.log('\n复位后: ' + JSON.stringify((await read()).puzzle))

ws.close()
