/**
 * ★★★ 决定性实验：captcha 的判据是「Chromium 内核」还是「具体是哪个浏览器」？
 *
 * ## 已确证的事实（前面的对照实验）
 *
 * ```
 * ZCode 实例（Electron 41，UA 含 ZCodeDev/41.0.3）
 *   → ok=true，param 280 字符，isSign:true，securityToken 128
 *
 * headless Edge（Edg/154.0.4258.37）
 *   → verifyCode: F001（无感验证未通过）
 * ```
 *
 * **同一脚本、同一页面、同一网络** —— 差异只在浏览器身份。
 *
 * ## 但用户提出一个更精确的假设
 *
 * > captcha 你可以用别的浏览器我试了 **chromium** 可以，
 * > **electron 应该也行**，不一定要过开源 zcode 之类
 *
 * 这个假设值得单独验证，因为它区分两种可能：
 *
 * | 假设 | 预测 | 若成立的架构含义 |
 * |---|---|---|
 * | **A. 判据是 Electron** | headless Electron 能过 | 脱壳只需换一个最小 Electron，不必是 ZCode |
 * | **B. 判据是具体指纹** | headless Electron 仍 F001 | 必须保留**行为特征**（非无头、真窗口等） |
 * | **C. 判据是"非无头"** | 有头 Chromium 能过 | 脱壳需可见窗口（仍可脱离 ZCode） |
 *
 * ## 本脚本做什么
 *
 * 用 **ZCode 仓库自带的 Electron**（`D:\DSH-WEB\ZCode-official\node_modules\electron`）
 * 起一个**最小 App**（一个空窗口 + CDP），完全不含 ZCode 的任何代码，
 * 然后跑同一个 captcha 流程。
 *
 * ⇒ 若成功，**"必须用 ZCode 壳"这个结论就被推翻**。
 *
 * 用法：node bench/probe-electron-standalone.mjs [--headless]
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const HEADLESS = process.argv.includes("--headless");
const PORT = HEADLESS ? 9555 : 9556;
const APP_DIR = "D:\\zcode-glm5.3f\\bench\\_minielectron";
const ELECTRON = "D:\\DSH-WEB\\ZCode-official\\node_modules\\electron\\dist\\electron.exe";

console.log(`模式: ${HEADLESS ? "headless" : "有头窗口"}`);
console.log(`Electron: ${ELECTRON}  存在=${existsSync(ELECTRON)}`);

if (!existsSync(ELECTRON)) {
  console.error("找不到 Electron 可执行文件");
  process.exit(1);
}

// ── 造一个最小 Electron App（不含任何 ZCode 代码）────────────────
mkdirSync(APP_DIR, { recursive: true });

/**
 * 主进程：只做两件事 —— 开一个窗口、开 CDP。
 * 刻意不加载任何业务页面，用 `about:blank` 起步，
 * 之后由 CDP 导航（与前面 Edge 实验完全对称）。
 */
writeFileSync(
  join(APP_DIR, "main.js"),
  `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

app.commandLine.appendSwitch("remote-debugging-port", "${PORT}");
app.commandLine.appendSwitch("remote-allow-origins", "*");

// 关掉自动化痕迹（用户假设的「Electron 应该也行」若依赖这一点，
// 这里就要和 ZCode 对齐）
app.commandLine.appendSwitch("disable-blink-features", "AutomationControlled");

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: ${HEADLESS ? "false" : "true"},
    webPreferences: {
      // 与 ZCode 一致的宽松设置：captcha SDK 需要 DOM 能力
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });
  win.loadURL("about:blank");
  console.log("[minielectron] window created");
});

app.on("window-all-closed", () => app.quit());
`,
  "utf8",
);

writeFileSync(
  join(APP_DIR, "package.json"),
  JSON.stringify({ name: "minielectron", version: "1.0.0", main: "main.js" }, null, 2),
  "utf8",
);

console.log(`\n最小 App 已生成: ${APP_DIR}`);

// ── 启动 ────────────────────────────────────────────────────────
console.log("\n启动 Electron…");
const child = spawn(ELECTRON, ["."], {
  cwd: APP_DIR,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0" },
});
child.stdout.on("data", (d) => process.stdout.write(`  [app] ${d}`));
child.stderr.on("data", (d) => {
  const s = String(d);
  // 过滤 Electron 的常规噪音
  if (!/DevTools|Autofill|GPU|cache/i.test(s)) process.stderr.write(`  [app!] ${s}`);
});

// 等 CDP 起来
let ready = false;
for (let i = 0; i < 30; i += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    console.log(`\n✓ CDP 就绪: ${v.Browser}`);
    ready = true;
    break;
  } catch {
    /* 继续等 */
  }
}

if (!ready) {
  console.error("\n✗ CDP 未就绪，退出");
  child.kill();
  process.exit(1);
}

// ── 跑 captcha 流程 ─────────────────────────────────────────────
console.log("\n=== 在最小 Electron 上跑 captcha ===");
const probe = spawn(
  process.execPath,
  ["D:\\zcode-glm5.3f\\bench\\probe-captcha-standalone.mjs", String(PORT)],
  { stdio: "inherit" },
);

await new Promise((resolve) => probe.on("close", resolve));

console.log("\n（保留 Electron 进程供进一步实验，pid=" + child.pid + "）");
console.log("  停止: Stop-Process -Id " + child.pid);
