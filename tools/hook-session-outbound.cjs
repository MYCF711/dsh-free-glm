/**
 * 抓取开源版实例发往 zcode.z.ai 的真实请求头。
 *
 * 用途：确认「会话链路」发出的请求是否带客户端签名头
 * （X-Client-Sig / X-Client-Pow / X-Client-Nonce / X-App-Id）。
 *
 * 这决定了 3012 的根因：若会话链路带签名而桥裸发不带，则签名就是风控判据。
 *
 * 做法：hook globalThis.fetch，把发往 zcode.z.ai 的请求头落到 jsonl。
 * 用 NODE_OPTIONS=--require 预加载（在 electron 主进程之前生效）。
 */
const fs = require("node:fs");
const path = require("node:path");

const OUT = path.join(__dirname, "_session-outbound.jsonl");
const originalFetch = globalThis.fetch;

function normalizeHeaders(input) {
  const out = {};
  try {
    if (input == null) return out;
    if (typeof input.forEach === "function" && typeof input.get === "function") {
      // Headers 实例
      input.forEach((value, key) => {
        out[key] = value;
      });
      return out;
    }
    if (Array.isArray(input)) {
      for (const pair of input) {
        if (Array.isArray(pair) && pair.length >= 2) out[String(pair[0])] = String(pair[1]);
      }
      return out;
    }
    if (typeof input === "object") {
      for (const [k, v] of Object.entries(input)) out[k] = String(v);
    }
  } catch {
    // 抓包失败不影响主流程
  }
  return out;
}

globalThis.fetch = function patchedFetch(input, init) {
  try {
    const url =
      typeof input === "string" ? input : input && typeof input.url === "string" ? input.url : "";
    if (url.includes("zcode.z.ai")) {
      const headers = normalizeHeaders(init && init.headers ? init.headers : (input && input.headers));
      const sigKeys = Object.keys(headers).filter((k) => /client-sig|client-pow|client-nonce|app-id|client-ts|sign-verified/i.test(k));
      fs.appendFileSync(
        OUT,
        JSON.stringify({
          at: Date.now(),
          url,
          method: (init && init.method) || "GET",
          signatureHeaders: sigKeys,
          allHeaderNames: Object.keys(headers),
          // 只记录签名头的值（脱敏其它）：签名值本身不是机密，且是排查必需品
          values: Object.fromEntries(sigKeys.map((k) => [k, headers[k]])),
        }) + "\n",
      );
    }
  } catch {
    // 忽略
  }
  return originalFetch.apply(this, arguments);
};

// 也在 undici 层挂一次（有些 SDK 绕开 globalThis.fetch）
try {
  const undici = require("undici");
  if (undici && typeof undici.fetch === "function") {
    const origUndici = undici.fetch;
    undici.fetch = function (input, init) {
      try {
        const url = typeof input === "string" ? input : input && input.url;
        if (typeof url === "string" && url.includes("zcode.z.ai")) {
          const headers = normalizeHeaders(init && init.headers);
          const sigKeys = Object.keys(headers).filter((k) => /client-sig|client-pow|client-nonce|app-id|client-ts/i.test(k));
          fs.appendFileSync(
            OUT,
            JSON.stringify({ at: Date.now(), via: "undici", url, signatureHeaders: sigKeys, values: Object.fromEntries(sigKeys.map((k) => [k, headers[k]])) }) + "\n",
          );
        }
      } catch {
        // 忽略
      }
      return origUndici.apply(this, arguments);
    };
  }
} catch {
  // undici 可能不可用
}

fs.appendFileSync(OUT, JSON.stringify({ at: Date.now(), event: "hook-installed" }) + "\n");
