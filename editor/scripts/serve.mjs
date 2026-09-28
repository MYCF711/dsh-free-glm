/**
 * 本地静态服务器 —— 给编辑器用。
 *
 * ## 为什么需要一个服务器（而不是直接双击 html）
 *
 * `file://` 协议下浏览器对 `navigator.clipboard` 等 API 有额外限制，
 * 而且 autoglm 之类的浏览器自动化工具**无法操作 `file://` 页面**
 * （实测：任务会停在 PENDING_REGISTERED）。走 HTTP 就没这些问题。
 *
 * ## 两个关键细节（都是踩过坑才加的）
 *
 * 1. **`Cache-Control: no-store`**
 *    否则浏览器会缓存 builder.html —— 改完文件刷新看到的还是旧的，
 *    表现为「明明改了却没生效」。这个坑实测踩过。
 *
 * 2. **端口被占用时自动顺延**
 *    之前固定 8899，旧进程没退干净时会静默起不来。
 *
 * 用法：
 *   node scripts/serve.mjs            # 默认 8899
 *   node scripts/serve.mjs 9000       # 指定端口
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const START_PORT = Number(process.argv[2] ?? 8899);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/" || pathname === "") pathname = "/build/builder.html";

    /* ⚠ 目录穿越防护 —— 规范化后必须仍在 ROOT 之内 */
    const full = normalize(join(ROOT, pathname));
    if (!full.startsWith(ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    const st = await stat(full).catch(() => null);
    if (st === null || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`404 Not Found: ${pathname}`);
      return;
    }

    const body = await readFile(full);
    res.writeHead(200, {
      "Content-Type": MIME[extname(full).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": body.length,
      /* ★ 必须 no-store —— 否则改完文件看不到变化 */
      "Cache-Control": "no-store, no-cache, must-revalidate",
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`500 ${e.message}`);
  }
});

/** 端口占用就顺延，最多试 20 个。 */
function listen(port, attempt = 0) {
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE" && attempt < 20) {
      listen(port + 1, attempt + 1);
    } else {
      console.error(`启动失败: ${e.message}`);
      process.exit(1);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`编辑器已启动:  http://127.0.0.1:${port}/`);
    console.log(`  静态根目录:  ${ROOT}`);
    console.log(`  停止:        Ctrl+C`);
  });
}

listen(START_PORT);
