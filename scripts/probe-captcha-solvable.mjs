/**
 * 尝试在 ZCode renderer 里**程序化完成**降级的滑块验证。
 *
 * ## 背景
 *
 * captcha 已从「无感验证」降级为「滑块验证」——前者静默通过、
 * 后者需要拖动。目前 ZCode 的弹窗一直挂着，所有 mint 请求 20 秒超时。
 *
 * ## 思路
 *
 * 滑块验证的本质是「把滑块拖到缺口位置」。两条路：
 *
 * A. **识别缺口位置**（看图算 x 坐标）—— 需要图像处理，工作量大
 * B. **直接调 SDK 的验证接口** —— 若 SDK 暴露了可编程的完成入口
 *
 * 本脚本**只做只读探测**：先看清 SDK 暴露了什么，
 * 再决定走哪条路。**不盲目模拟拖动** —— 拖错会进一步降低信誉。
 *
 * 只读，不导航、不改页面。
 */

const CDP = 'http://127.0.0.1:9229'

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
console.log(`目标: ${page.url.slice(0, 90)}\n`)

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

const ev = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise, timeout: 30_000,
  })
  if (r.exceptionDetails) return { __error: r.exceptionDetails.text }
  return r.result?.value
}

console.log('=== 1. SDK 全局对象上有哪些可编程入口 ===')
console.log(await ev(`JSON.stringify({
  initAliyunCaptcha: typeof window.initAliyunCaptcha,
  AliyunCaptcha: typeof window.AliyunCaptcha,
  AliyunCaptchaConfig: window.AliyunCaptchaConfig,
  closeFn: typeof window.__CloseAliyunCaptcha,
  clientX: window.AliyunCaptcha_clientX,
}, null, 2)`))

console.log('\n=== 2. AliyunCaptcha 对象的方法/属性 ===')
console.log(await ev(`(() => {
  const a = window.AliyunCaptcha;
  if (!a) return 'null';
  const keys = Object.keys(a);
  return JSON.stringify(keys.slice(0, 40), null, 2);
})()`))

console.log('\n=== 3. 当前弹窗内的 DOM 结构（找滑块与缺口）===')
console.log(await ev(`JSON.stringify((() => {
  const ids = ['aliyunCaptcha-puzzle','aliyunCaptcha-sliding-body','aliyunCaptcha-sliding-slider',
               'aliyunCaptcha-img-box','aliyunCaptcha-sliding-text-box'];
  const out = {};
  for (const i of ids) {
    const el = document.getElementById(i);
    if (!el) { out[i] = 'not-found'; continue; }
    const r = el.getBoundingClientRect();
    out[i] = { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top),
               display: getComputedStyle(el).display };
  }
  return out;
})(), null, 2)`))

console.log('\n=== 4. 缺口/滑块图片的 src ===')
console.log(await ev(`JSON.stringify((() => {
  const imgs = Array.from(document.querySelectorAll('#aliyunCaptcha-puzzle img, #aliyunCaptcha-img-box img'));
  return imgs.map(n => ({ cls: n.className, w: n.naturalWidth, h: n.naturalHeight, src: n.src.slice(0, 90) }));
})(), null, 2)`))

console.log('\n=== 5. 找 SDK 内部的实例（getInstance 回调拿到的那个）===')
console.log(await ev(`(() => {
  // SDK 把它挂在某个全局上；遍历所有 window 属性找带 verify 方法的东西
  const hits = [];
  for (const k of Object.keys(window)) {
    try {
      const v = window[k];
      if (v && typeof v === 'object' && typeof v.startTracelessVerification === 'function') {
        hits.push({ key: k, methods: Object.keys(v).slice(0, 20) });
      }
    } catch { /* 跨域对象跳过 */ }
  }
  return JSON.stringify(hits, null, 2);
})()`))

console.log('\n=== 6. 结论提示 ===')
console.log('  若第 5 步找到实例且有可编程完成入口 → 走路线 B')
console.log('  若只有 DOM（滑块 + 缺口图）→ 需要图像识别定位缺口，走路线 A')

ws.close()
