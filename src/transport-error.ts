/**
 * 传输级错误的识别。
 *
 * ## 为什么单独一个模块
 *
 * 这个判据原先和一堆 OpenAI 兼容协议代码挤在 `openai-compat.ts` 里
 * （那个文件是从其它 provider 适配器抄来的，本插件只用得上其中 3 个函数，
 * 其余约 500 行 SSE 消费/消息序列化逻辑全是死代码）。桥返回的是 **JSON 整包**，
 * 不是 SSE，所以那些代码对本插件无意义，已删除。
 *
 * ## 判据从哪来
 *
 * 半开连接与 TCP 重置在 Node 的 fetch 里以这些形态出现。区分"传输错误"
 * 与"业务错误"很重要：前者可重试，后者重试只是浪费一轮。
 */

/**
 * 判断是否为传输级错误（可重试的 `TRANSPORT`）。
 *
 * @param error - 捕获到的任意错误值。
 * @returns 命中已知的传输错误特征时为 true。
 */
export function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  if (message.includes("terminated")) {
    return true;
  }
  if (error.name.startsWith("UND_ERR_")) {
    return true;
  }
  if (message.includes("fetch failed")) {
    return true;
  }
  if (
    message.includes("econnreset") ||
    message.includes("epipe") ||
    message.includes("socket hang up")
  ) {
    return true;
  }
  return false;
}
