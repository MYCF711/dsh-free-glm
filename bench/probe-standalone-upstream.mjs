/**
 * ★★★ 收尾实验：独立产出的 captcha param 能否**真的被上游接受**？
 *
 * ## 前面的进展
 *
 * 已证明 captcha **不依赖 ZCode 壳**：
 *
 * | 环境 | UA | 结果 |
 * |---|---|---|
 * | ZCode 实例 | `ZCodeDev/41.0.3` Electron/41 | ✅ ok=true |
 * | **最小 Electron**（零 ZCode 代码） | `minielectron/1.0.0` Electron/41 | ✅ **ok=true** |
 * | headless Edge 154 | `HeadlessChrome` Edg/154 | ❌ F001 |
 *
 * ⇒ 判据是 **Electron 内核**，不是 ZCode 这个具体应用。
 *
 * ## 但「拿到 param」≠「上游接受」
 *
 * captcha 只是**附件**。真正让请求通过还需要：
 *   1. 官方身份块 system（解 3012）—— 纯字符串构造，与壳无关
 *   2. 正确的 22 个头 —— 已复刻
 *   3. **有效的 JWT** —— 已有（`injected-jwt.txt`）
 *
 * 本脚本把这三样拼起来，**绕开桥**直接打上游，
 * 用**独立产出的** param。若 200，则脱壳路径完全打通。
 *
 * 用法：node bench/probe-standalone-upstream.mjs
 */

import { readFileSync, existsSync } from "node:fs";

const DATA = "D:\\zcode-glm5.3f\\_oss_data";
const PARAM_FILE = "D:\\zcode-glm5.3f\\bench\\_captcha-standalone-param.txt";
const JWT_FILE = `${DATA}\\.zcode\\v2\\injected-jwt.txt`;
const UPSTREAM = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages";

// ── 材料 ────────────────────────────────────────────────────────
if (!existsSync(PARAM_FILE)) {
  console.error(`缺少 param 文件: ${PARAM_FILE}\n先跑 probe-captcha-standalone.mjs`);
  process.exit(1);
}
const param = readFileSync(PARAM_FILE, "utf8").trim();
console.log(`captcha param: ${param.length} 字符`);

const jwt = existsSync(JWT_FILE) ? readFileSync(JWT_FILE, "utf8").trim() : "";
if (jwt.length === 0) {
  console.error("缺少 JWT（injected-jwt.txt）");
  process.exit(1);
}
console.log(`JWT: ${jwt.length} 字符`);

// ── 身份块（解 3012，与壳无关）──────────────────────────────────
const CLI_PREFIX = "You are ZCode, an interactive coding agent";
const STABLE = [
  "\nYou are an interactive ZCode agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.\n\n# Harness\n- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.\n- Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.\n- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.\n- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.\n- Reference code as `file_path:line_number` — it's clickable.",
].join("");

const body = {
  model: "glm-5.3-flash",
  max_tokens: 4096,
  stream: false,
  system: [
    { type: "text", text: CLI_PREFIX, cache_control: { type: "ephemeral" } },
    { type: "text", text: STABLE, cache_control: { type: "ephemeral" } },
  ],
  messages: [{ role: "user", content: "只回答两个字：正常" }],
};

const headers = {
  "accept-encoding": "gzip",
  "anthropic-version": "2023-06-01",
  authorization: `Bearer ${jwt}`,
  "content-type": "application/json",
  "http-referer": "https://zcode.z.ai",
  "user-agent": "ZCode/3.14.3 ai-sdk/anthropic/3.0.81",
  "x-aliyun-captcha-verify-param": param,
  "x-aliyun-captcha-verify-region": "cn",
  "x-api-key": jwt,
  "x-client-language": "zh-CN",
  "x-client-timezone": "Asia/Shanghai",
  "x-os-category": "windows",
  "x-os-version": "10.0.26200",
  "x-platform": "win32-x64",
  "x-release-channel": "production",
  "x-title": "Z Code@cli",
  "x-zcode-agent": "glm",
  "x-zcode-app-version": "3.14.3",
};

console.log("\n=== 直打上游（未经过桥、未经过 ZCode）===");
console.log(`URL: ${UPSTREAM}`);

const started = Date.now();
let res;
try {
  res = await fetch(UPSTREAM, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
} catch (e) {
  console.error(`网络失败: ${e.message}`);
  process.exit(1);
}
const elapsed = Date.now() - started;
const text = await res.text();

console.log(`\nHTTP ${res.status}   耗时 ${elapsed}ms`);
console.log("响应前 600 字符:");
console.log(text.slice(0, 600));

console.log("\n" + "═".repeat(60));
if (res.status === 200) {
  console.log("✅ 成功 —— 独立产出的 captcha + 纯 HTTP 直打上游，全部通过");
  console.log("   ⇒ **完全不需要 ZCode 壳**");
} else if (res.status === 3012) {
  console.log("✗ 3012（风控）—— 身份块可能不够或指纹不匹配");
} else if (res.status === 3007 || text.includes("3007")) {
  console.log("✗ 3007（captcha 校验失败）—— param 可能已过期或不被接受");
} else if (res.status === 429) {
  console.log("⚠ 429（限流）—— 链路是通的，只是撞了配额");
} else {
  console.log(`⚠ HTTP ${res.status} —— 见上面的响应正文`);
}
console.log("═".repeat(60));
