/**
 * 诊断：`isTrusted` 到底能不能 patch。
 *
 * ## 上一版的结果
 *
 * `Object.defineProperty(Event.prototype, 'isTrusted', {get(){return true}})`
 * 返回成功（没抛错），但读出来仍是 `false`。
 * ⇒ 在 `Event.prototype` 上覆盖**无效**。
 *
 * 可能原因：
 *   · Chromium 在 prototype 上把它定义为**不可配置**，
 *     `defineProperty` 静默失败（非严格模式不抛）
 *   · 或者有更底层（native）的 getter 优先生效
 *
 * ## 本脚本试三条路
 *
 * A. 在 **实例**上 defineProperty（实例自有属性会遮蔽原型 getter）
 * B. 严格模式重试 prototype（确认是否真的静默失败）
 * C. 用 `Object.defineProperty` 前先 `getOwnPropertyDescriptor` 看属性特性
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
  if (r.exceptionDetails) return { __error: r.exceptionDetails.text, detail: r.exceptionDetails }
  return r.result?.value
}

console.log('=== A. prototype 上的属性特性 ===')
console.log(await ev(`(() => {
  const d = Object.getOwnPropertyDescriptor(Event.prototype, 'isTrusted');
  return JSON.stringify(d ? { hasGet: !!d.get, hasValue: 'value' in d, configurable: d.configurable, enumerable: d.enumerable, writable: d.writable } : null);
})()`))

console.log('\n=== B. 在实例上 defineProperty 能否遮蔽 ===')
console.log(await ev(`(() => {
  const e = new MouseEvent('x');
  const before = e.isTrusted;
  try {
    Object.defineProperty(e, 'isTrusted', { configurable: true, value: true });
    return JSON.stringify({ before, after: e.isTrusted, ok: true });
  } catch (err) {
    return JSON.stringify({ before, ok: false, err: err.message });
  }
})()`))

console.log('\n=== C. 严格模式下重试 prototype ===')
console.log(await ev(`(() => {
  'use strict';
  try {
    Object.defineProperty(Event.prototype, 'isTrusted', { configurable: true, get() { return true } });
    return JSON.stringify({ after: new MouseEvent('x').isTrusted });
  } catch (err) {
    return JSON.stringify({ ok: false, err: err.message });
  }
})()`))

console.log('\n=== D. 用 Proxy 包装构造函数？看 SDK 怎么拿事件 ===')
console.log(await ev(`(() => {
  // 检查 SDK 是否真的读 isTrusted（在页面上 hook 一下看有没有被访问）
  const desc = Object.getOwnPropertyDescriptor(Event.prototype, 'isTrusted');
  let accessed = 0;
  if (desc && desc.get) {
    try {
      Object.defineProperty(Event.prototype, 'isTrusted', {
        configurable: true,
        get() { accessed++; return desc.get.call(this); },
      });
    } catch (e) { /* 忽略 */ }
  }
  const e = new MouseEvent('x');
  void e.isTrusted;
  return JSON.stringify({ hookInstalled: true, accessCount: accessed });
})()`))

console.log('\n=== E. 决定性测试：hook getter 后，一次真实拖动时它被读了几次 ===')
console.log(await ev(`(() => {
  window.__isTrustedReads = 0;
  const d = Object.getOwnPropertyDescriptor(Event.prototype, 'isTrusted');
  if (d && d.get) {
    Object.defineProperty(Event.prototype, 'isTrusted', {
      configurable: true,
      get() { window.__isTrustedReads++; return d.get.call(this); },
    });
  }
  return 'hook ready';
})()`))

// 发一次真实鼠标事件，看 hook 是否被触发
const mouse = (type, x, y, extra = {}) =>
  send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra })
await mouse('mousePressed', 470, 480, { buttons: 1 })
await mouse('mouseMoved', 500, 480, { buttons: 1 })
await mouse('mouseReleased', 500, 480, { buttons: 0 })
await new Promise((r) => setTimeout(r, 400))

console.log('  isTrusted 被读次数: ' + await ev('window.__isTrustedReads'))
console.log('  （若为 0 ⇒ SDK 没有在处理器里读它，patch 无意义）')

ws.close()
