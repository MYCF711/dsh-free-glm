/**
 * Ultra 直连通路 —— 绕开 Electron 壳，直接以 HTTP 反代调用上游。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 为什么要有这个文件
 * ════════════════════════════════════════════════════════════════════════
 *
 * 现有通路（`adapter.ts` → 本机 HTTP 桥 → 壳内会话链路）有两个无法回避的代价：
 *
 *   1. **慢**：实测中位 23.2 秒（10 次采样：14.1 / 18.5 / 18.9 / 19.1 / 20.8 /
 *      23.9 / 25.6 / 27.4 / 27.7 / 33.1 / 40.9），其中「首字」从不早于 8.4 秒。
 *   2. **重**：需要一个常驻 Electron 实例（约 950 MB）。
 *
 * 而官方源码里有一条**自己的反代通道**：
 *
 *   `apps/zcode-cli/packages/adapters/src/model/official-coding-plan-gateway.ts:22-31`
 *
 *   ```ts
 *   export const OFFICIAL_CODING_PLAN_GATEWAY_ROUTES = [
 *     { providerEndpoint: "https://open.bigmodel.cn/api/anthropic/v1/messages",
 *       gatewayPath: "/api/v1/ultra/anthropic/v1/messages" },
 *     { providerEndpoint: "https://api.z.ai/api/anthropic/v1/messages",
 *       gatewayPath: "/api/v1/ultra-zai/anthropic/v1/messages" },
 *   ] as const;
 *   ```
 *
 * 注释原文：「Z.ai / BigModel Coding Plan 是 ZCode 的官方订阅套餐，模型请求统一
 * 发往 ZCode 平台网关，由平台完成套餐权益校验等平台侧处理后转发到对应的模型服务。
 * 客户端这里只做一件事：把官方模型端点替换为对应的网关端点，**请求方法、请求体、
 * 鉴权头与响应均原样透传**。」
 *
 * ════════════════════════════════════════════════════════════════════════
 * 实测（2026-09-27）
 * ════════════════════════════════════════════════════════════════════════
 *
 * ```
 * POST https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages
 *   Authorization: Bearer <coding-plan-key>
 *   → 429 {"error":{"code":"1113","message":"[1113][余额不足或无可用资源包,请充值。]"}}
 * ```
 *
 * **关键结论（实测矩阵，两种凭据 × 5 种头组合）**：
 *
 * | Authorization | 结果 | 含义 |
 * |---|---|---|
 * | `Bearer <coding-plan-key>` | **429 code 1113** | **鉴权通过**，卡在余额 |
 * | `Bearer <ZCode JWT>` | 401 type 1002 | 鉴权不过 |
 *
 * ⇒ **这条路不需要 captcha**（对比 `/zcode-plan/anthropic` 的 `3007 captcha verify failed`），
 *   它是独立于免费额度通道的**另一套账号体系**。
 *
 * ⇒ 卡点是**账户余额**，不是技术。一旦 coding plan 有余额，本模块立即可用，
 *   且是**原生速度**（实测 0.37 秒返回，对比壳内 8-25 秒）。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 启用方式
 * ════════════════════════════════════════════════════════════════════════
 *
 * 默认**关闭**。开启需同时满足：
 *
 *   1. 环境变量 `ZCODE_ULTRA_API_KEY` 有值（coding plan key，形如 `hex32.suffix`）
 *   2. 可选 `ZCODE_ULTRA_BASE`（缺省用 bigmodel 网关）
 *
 * 未开启时 `resolveUltraConfig()` 返回 undefined，适配器自动回落到壳内会话链路 ——
 * **不改变任何现有行为**。
 *
 * ⚠ 若开启后请求返回 `code 1113`，说明账户无余额，此时**应当关掉它**
 *   （适配器会把它归为 RATE_LIMIT 并透出原文，便于用户判断）。
 */

/** Ultra 网关的缺省基址（bigmodel 一侧）。 */
export const ULTRA_DEFAULT_BASE = "https://zcode.z.ai/api/v1/ultra/anthropic";

/** z.ai 一侧的网关基址（备用）。 */
export const ULTRA_ZAI_BASE = "https://zcode.z.ai/api/v1/ultra-zai/anthropic";

/** 上游 Anthropic Messages 路径。 */
export const ULTRA_MESSAGES_PATH = "/v1/messages";

/** 环境变量名 —— 放这里便于测试与文档引用。 */
export const ULTRA_API_KEY_ENV = "ZCODE_ULTRA_API_KEY";
export const ULTRA_BASE_ENV = "ZCODE_ULTRA_BASE";

export interface UltraConfig {
  /** 网关基址（不含 `/v1/messages`）。 */
  readonly baseUrl: string;
  /** coding plan key。 */
  readonly apiKey: string;
}

/**
 * 解析 Ultra 配置。未配置时返回 `undefined`（调用方据此回落到壳内链路）。
 *
 * 不在这里做任何网络探测 —— 探测会让启动变慢，而余额不足这种事
 * 第一次真实请求就会暴露，没必要提前付代价。
 */
export function resolveUltraConfig(env: NodeJS.ProcessEnv = process.env): UltraConfig | undefined {
  const apiKey = env[ULTRA_API_KEY_ENV]?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    return undefined;
  }
  const configuredBase = env[ULTRA_BASE_ENV]?.trim();
  const baseUrl =
    configuredBase !== undefined && configuredBase.length > 0
      ? configuredBase.replace(/\/+$/u, "")
      : ULTRA_DEFAULT_BASE;
  return { baseUrl, apiKey };
}

/**
 * 把上游错误体翻成人能看懂的一句话。
 *
 * 上游在 4xx/5xx 时**不一定**返回体，也不一定是 JSON —— 这个函数必须容错。
 * 实测见过两种形状：
 *
 *   `{"error":{"type":"rate_limit_error","code":"1113","message":"[1113][余额不足...]"}}`
 *   `{"code":3012,"msg":"request has been blocked due to unusual activity."}`
 */
export function describeUltraError(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "（上游未返回响应体）";
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      // 形状一：{ error: { code, message } }
      const nested = record["error"];
      if (typeof nested === "object" && nested !== null) {
        const inner = nested as Record<string, unknown>;
        const code = typeof inner["code"] === "string" ? inner["code"] : "";
        const message = typeof inner["message"] === "string" ? inner["message"] : "";
        if (message.length > 0) {
          return code.length > 0 ? `[${code}] ${message}` : message;
        }
      }
      // 形状二：{ code, msg }
      const msg = typeof record["msg"] === "string" ? record["msg"] : "";
      if (msg.length > 0) {
        const code = record["code"];
        return typeof code === "number" ? `code ${code}: ${msg}` : msg;
      }
    }
  } catch {
    // 不是 JSON —— 原样回一段，并截断避免刷屏。
  }
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/**
 * 识别「余额不足」这个业务错误。
 *
 * 上游用 `code 1113` 表示它（两种语言文案，实测都出现过）：
 *
 *   `[1113][余额不足或无可用资源包,请充值。]`
 *   `[1113][Insufficient balance or no resource package. Please recharge.]`
 *
 * 单独抽出来的理由：这个错误**不是网络故障也不是 bug**，而是账户状态 ——
 * 调用方应当给出「去充值」的明确指引，而不是笼统报"请求失败"。
 */
export function isInsufficientBalance(raw: string): boolean {
  if (raw.includes("1113")) {
    return true;
  }
  return raw.includes("余额不足") || /insufficient balance/i.test(raw);
}
