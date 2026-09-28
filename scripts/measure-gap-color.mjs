/**
 * 用**颜色**定位缺口（而不是方差）。
 *
 * ## 上一版为什么错
 *
 * 用「列方差低」当判据，结果选中了图片最右侧的**平坦天空**
 * （x=269..295，方差 448）—— 天空本来就很平，与缺口无关。
 *
 * ## 缺口真正的特征：它是**半透明灰块**
 *
 * 实测：缺口处的颜色是**低饱和度的灰白**（约 RGB 200,205,215 一带），
 * 而背景是**高饱和度的蓝天/白云**。
 *
 * 判据改为：
 *   ① 饱和度低（max−min 通道差小）
 *   ② 亮度中等偏亮
 *   ③ 该列上满足 ①② 的像素**占比高**（形成连续的竖直条带）
 *
 * 这个判据对「蓝天」不成立（蓝色饱和度高），对「白云」也不完全成立
 * （白云虽亮但边缘渐变），所以能区分开。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('D:/zcode-glm5.3f/_jsh/')
const { PNG } = require('pngjs')

const png = PNG.sync.read(readFileSync('D:/zcode-glm5.3f/_cap_bg.png'))
const { width: W, height: H, data } = png
console.log(`背景图 ${W}×${H}`)

/** 逐像素算「灰白度」：饱和度低 且 亮度不太暗。 */
const isGreyish = new Uint8Array(W * H)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4
    const r = data[p], g = data[p + 1], b = data[p + 2]
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    const sat = mx - mn               // 通道差 = 饱和度代理
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    // 灰白：饱和度低（<28）且亮度在 140..245
    isGreyish[y * W + x] = sat < 28 && lum > 140 && lum < 246 ? 1 : 0
  }
}

/** 逐列统计灰白像素占比。 */
const ratio = new Float32Array(W)
for (let x = 0; x < W; x++) {
  let c = 0
  for (let y = 0; y < H; y++) c += isGreyish[y * W + x]
  ratio[x] = c / H
}

/** 打印占比曲线的高峰（辅助判断） */
const peaks = []
for (let x = 2; x < W - 2; x++) {
  if (ratio[x] > 0.25 && ratio[x] >= ratio[x - 1] && ratio[x] >= ratio[x + 1]) {
    peaks.push({ x, r: ratio[x] })
  }
}
peaks.sort((a, b) => b.r - a.r)
console.log('\n灰白占比最高的列:')
for (const p of peaks.slice(0, 10)) {
  console.log(`  x=${String(p.x).padStart(3)}  占比 ${(p.r * 100).toFixed(0)}%`)
}

/**
 * 找**连续区间**：占比持续 > 0.35 的那一段就是缺口。
 *
 * 缺口高约 50px（拼图块 52×200 里内容只占 50 高），
 * 而背景 200 高 —— 所以缺口列的最高占比约 50/200 = 25%。
 * 若阈值设太高会找不到，故取 0.22。
 */
const THRESH = 0.22
const runs = []
let s = -1
for (let x = 0; x <= W; x++) {
  const ok = x < W && ratio[x] > THRESH
  if (ok) { if (s < 0) s = x }
  else if (s >= 0) { runs.push([s, x - 1]); s = -1 }
}
console.log(`\n占比 > ${THRESH} 的连续区间:`)
for (const [a, b] of runs) {
  let best = 0
  for (let x = a; x <= b; x++) best = Math.max(best, ratio[x])
  console.log(`  x=${a}..${b}  宽 ${b - a + 1}  峰值占比 ${(best * 100).toFixed(0)}%`)
}

/**
 * 选最像缺口的一段：宽度接近拼图块（52px）。
 */
const pieceW = 52
const scored = runs
  .map(([a, b]) => {
    const w = b - a + 1
    let mx = 0, sum = 0
    for (let x = a; x <= b; x++) { mx = Math.max(mx, ratio[x]); sum += ratio[x] }
    return { a, b, w, peak: mx, avg: sum / w, err: Math.abs(w - pieceW) / pieceW }
  })
  .filter((r) => r.w >= pieceW * 0.5)
  .sort((p, q) => (p.err + (1 - p.peak)) - (q.err + (1 - q.peak)))

if (scored.length === 0) {
  console.log('\n✗ 未找到缺口（灰白段）')
  process.exit(1)
}

const best = scored[0]
console.log(`\n★ 判定缺口: x=${best.a}..${best.b}  宽 ${best.w}  峰值占比 ${(best.peak * 100).toFixed(0)}%`)
console.log(`  中心 x = ${(best.a + best.b) / 2}`)

writeFileSync('D:/zcode-glm5.3f/_gap_measure.json', JSON.stringify({
  left: best.a, right: best.b, center: (best.a + best.b) / 2, width: best.w,
  peakRatio: best.peak,
}, null, 2))
console.log('  已落盘 _gap_measure.json')
