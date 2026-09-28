/**
 * ★★★ 脱壳验证：能否用**任意 headless Chromium** 产出被上游接受的 captcha？
 *
 * ## 为什么这个实验决定架构方向
 *
 * 桥的源码说「captcha 只能在**渲染进程**里跑（需 DOM + 阿里云 SDK）」。
 * 前几轮把「渲染进程」误读成「**ZCode 的**渲染进程」——
 * 但证据显示它只需要「**任意**有 DOM 的 Chromium」：
 *
 *   1. `CAPTCHA-PORT-VERDICT.md` 实测：captcha 模块
 *      **零 Electron API、零 Node API**（`ipcRenderer=0`、`require(=0`）
 *   2. 同一文档实测：**开源版磁盘上根本没有 captcha 代码**
 *      （整个 assets/ 与源码树全是 0 命中）
 *   3. 现在能跑，靠的是 `oss-inject-captcha-real.mjs` **动态注入** SDK
 *
 * ⇒ 若本实验成功，**整个 Electron 壳就可以去掉**。
 *
 * ## 本脚本做什么
 *
 * 连任意 CDP 端点 → 动态加载官方 SDK → 建 DOM 容器 →
 * `initAliyunCaptcha` + `startTracelessVerification` → 拿 param。
 *
 * **全程不碰 ZCode。**
 *
 * 用法：node bench/probe-captcha-standalone.mjs [cdp端口]
 */

import { writeFileSync } from "node:fs";

const PORT = process.argv[2] ?? "9444";
const CDP = `http://127.0.0.1:${PORT}`;
const OUT = "D:/zcode-glm5.3f/bench/_captcha-standalone-param.txt";

/** 极简 CDP 客户端（WebSocket 由 Node 22+ 内置）。 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id != null && this.pending.has(m.id)) {
        const q = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? q.reject(new Error(JSON.stringify(m.error))) : q.resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

console.log(`连接 CDP: ${CDP}`);
const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (page === undefined) {
  console.error("找不到 page 类型的目标");
  process.exit(1);
}
console.log(`目标页面: ${page.url}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", reject);
});
const cdp = new Cdp(ws);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");

/** 求值辅助（必须在导航之前定义 —— 导航后要用它确认 URL）。 */
const ev = async (expression) => {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout: 90_000,
  });
  if (r.exceptionDetails) {
    return { __error: r.exceptionDetails.text ?? "exception", detail: r.exceptionDetails };
  }
  return r.result?.value;
};

/**
 * ★ 必须先导航到一个**普通 HTTP 页面**（2026-09-28 实测踩到）。
 *
 * ## 第一次为什么失败
 *
 * 默认 page 目标是 `edge://sync-confirmation-dialog/` —— **浏览器内部页**。
 * 在它上面注入 SDK 报：
 *
 * ```
 * TypeError: Failed to set the 'src' property on 'HTMLScriptElement':
 *            This document requires 'TrustedScriptURL' assignment.
 * ```
 *
 * 这是 Edge 对**内部页**强制开启的 Trusted Types 策略 ——
 * 内部页不允许动态插入外部脚本。
 *
 * ## 对策
 *
 * 导航到一个普通页面（本地 HTTP 最稳，无 CSP）。这里用本机已有的
 * `_srv.mjs`（8899）上的一个空白页；若它没在跑，用 `about:blank` 兜底
 * （`about:blank` 没有 Trusted Types 限制，但 origin 是 null，
 * 某些情况下 SDK 会挑剔，所以优先 HTTP）。
 */
const NAV_TARGET = "http://127.0.0.1:8899/builder.html";
console.log(`\n导航到普通 HTTP 页面: ${NAV_TARGET}`);
await cdp.send("Page.navigate", { url: NAV_TARGET });
await new Promise((resolve) => setTimeout(resolve, 3000));
const cur = await ev("location.href");
console.log("  当前 URL: " + JSON.stringify(cur));

// ── 0. 先看环境 ────────────────────────────────────────────────
const env = await ev(`({
  ua: navigator.userAgent,
  origin: location.origin,
  hasInit: typeof window.initAliyunCaptcha,
  languages: navigator.languages,
  webdriver: navigator.webdriver,
})`);
console.log("\n=== 环境 ===");
console.log(JSON.stringify(env, null, 2));

// ── 1. 加载官方 SDK ────────────────────────────────────────────
console.log("\n=== 1. 动态加载 AliyunCaptcha.js ===");
const load = await ev(`(async () => {
  if (typeof window.initAliyunCaptcha === 'function') return 'already-loaded';
  return await new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
    s.onload = () => resolve('loaded: ' + typeof window.initAliyunCaptcha);
    s.onerror = () => resolve('script-error');
    document.head.appendChild(s);
    setTimeout(() => resolve('timeout: ' + typeof window.initAliyunCaptcha), 30000);
  });
})()`);
console.log("  " + JSON.stringify(load));

if (typeof load === "string" && load.includes("script-error")) {
  console.log("\n✗ SDK 加载失败（可能是网络或 CSP）");
  ws.close();
  process.exit(1);
}

// ── 2. 初始化 + 无感验证 ────────────────────────────────────────
console.log("\n=== 2. initAliyunCaptcha + startTracelessVerification ===");
const result = await ev(`(async () => {
  const mk = (id, css) => {
    if (!document.getElementById(id)) {
      const d = document.createElement('div');
      d.id = id; d.setAttribute('style', css); document.body.appendChild(d);
    }
  };
  mk('zc-standalone-container','position:fixed;left:0;top:0;z-index:2147483647;height:0;width:0;overflow:visible');
  mk('zc-standalone-element','height:0;width:0;overflow:hidden');
  let btn = document.getElementById('zc-standalone-button');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'zc-standalone-button';
    btn.setAttribute('style','position:fixed;left:0;top:0;height:0;width:0;opacity:0');
    document.body.appendChild(btn);
  }

  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok:false, why:'timeout-60s' }), 60000);
    const done = (o) => { clearTimeout(timer); resolve(o) };
    try {
      window.AliyunCaptchaConfig = { region: 'cn', prefix: 'no8xfe' };
      window.initAliyunCaptcha({
        SceneId: '11xygtvd',
        mode: 'popup',
        language: 'cn',
        showErrorTip: false,
        element: '#zc-standalone-element',
        button: '#zc-standalone-button',
        getInstance: (inst) => {
          try {
            if (typeof inst.startTracelessVerification === 'function') inst.startTracelessVerification();
            else done({ ok:false, why:'no-startTracelessVerification' });
          } catch (e) { done({ ok:false, why:'start-threw:' + e.message }) }
        },
        success: (p) => done({ ok:true, len: String(p||'').length, param: String(p||'') }),
        fail: (e) => done({ ok:false, why:'fail', detail: JSON.stringify(e).slice(0,300) }),
        onError: (e) => done({ ok:false, why:'onError', detail: String(e?.message ?? e).slice(0,300) }),
      });
    } catch (e) { done({ ok:false, why:'init-threw:' + e.message }) }
  });
})()`);

console.log("  ok=" + result?.ok + "  len=" + (result?.len ?? "-") + "  why=" + (result?.why ?? "-"));
if (result?.detail) console.log("  detail: " + result.detail);

if (result?.ok && result.param) {
  writeFileSync(OUT, result.param);
  console.log(`\n✅ 拿到 param（${result.len} 字符）已落盘: ${OUT}`);
  console.log("   前 80 字符: " + result.param.slice(0, 80));
  try {
    const j = JSON.parse(Buffer.from(result.param, "base64").toString("utf8"));
    console.log("\n   解码结构:");
    console.log("     keys        = " + Object.keys(j).join(", "));
    console.log("     sceneId     = " + j.sceneId);
    console.log("     isSign      = " + j.isSign);
    console.log("     securityToken 长度 = " + String(j.securityToken ?? "").length);
  } catch (e) {
    console.log("   解码失败: " + e.message);
  }
  console.log("\n★ 结论：captcha **不依赖 ZCode 壳** —— 任意 headless Chromium 即可。");
  console.log("  下一步：把这个 param 直接打上游，看是否 200。");
} else {
  console.log("\n✗ 未拿到 param");
}

ws.close();
