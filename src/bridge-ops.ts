/**
 * 桥的「运维端点」客户端（2026-09-28 新增）。
 *
 * ## 为什么单独一个文件
 *
 * `adapter.ts` 负责**模型调用**（对话 + 工具），本文件负责**账号运维**：
 *
 *   - 登录（弹浏览器授权页，用户点一次即可）
 *   - 查额度（还剩多少 / 何时到期 / 一次性还是每日）
 *   - 领取额度（ZCode 客户端左下角那张卡片，原本必须人工点）
 *
 * 三者都不属于 LLM provider 的职责，混进 `adapter.ts` 会让那个已经很长的
 * 文件更难读；且它们的调用时机不同（登录/领取是**用户或定时触发**，
 * 不是每次对话都跑）。
 *
 * ## 桥侧对应端点
 *
 * | 本文件函数 | 桥端点 | 说明 |
 * |---|---|---|
 * | `requestLogin` | `POST /oauth/login` | 触发实例自己走 OAuth（生成 state → 注册 → 开浏览器） |
 * | `fetchBilling` | `GET /diagnostics/billing` | 查额度 |
 * | `requestClaim` | `POST /diagnostics/claim` | 激活上报 → preview → 逐个 claim |
 *
 * ## 为什么要经过桥、而不是插件直接发
 *
 * 这三件事都**必须由 ZCode 实例本人做**：
 *
 * - 登录：`state` 要注册进实例内存的 `oauthStateToWindow` Map，
 *   且 `zcode://oauth/callback` 只有实例能接
 * - 领取：captcha 由实例的 renderer 产出（需 DOM + 阿里云 SDK），
 *   而 captcha **一次性**
 * - 额度：要带 `X-Device-Mid`（实例的真实设备身份）
 *
 * 插件是**另一个进程**，拿不到这些。所以只能请求桥转达。
 */

import { resolveLiveBridgeEndpoint } from "./bridge-endpoint.js";
import type { ZCodeBridgeEndpoint } from "./product.js";

/** 桥端点路径（与 `zcodeBridgeServer.ts` 的路由逐字一致）。 */
export const OAUTH_LOGIN_PATH = "/oauth/login";
export const DIAGNOSTICS_BILLING_PATH = "/diagnostics/billing";
export const DIAGNOSTICS_CLAIM_PATH = "/diagnostics/claim";
export const DIAGNOSTICS_MINT_PATH = "/diagnostics/mint";

/**
 * ★ captcha param 的严格度校验（2026-09-28 加，来自同类项目 TriDefender/zcode-api 的实证）。
 *
 * ## 为什么必须校验
 *
 * 那份实现的注释原文（`src/proxy/captcha-happy.ts` 的 `extractVerifyParam()`）：
 *
 * > **Len-76 junk … comes from a degraded SDK result path and WILL 3007 upstream
 * > — never let it out of the solver**
 *
 * 即：阿里云 SDK 在**降级路径**下会产出一个**长度异常、内容不完整**的 param。
 * 它**看起来像**一个正常返回值，但发到上游**必然 3007（captcha 校验失败）**。
 *
 * 我们的 `mintAuthMaterial` 走的是壳内 renderer（不是 happy-dom），
 * 同样可能碰到 SDK 的降级输出 —— **此前我们完全没有校验，直接发出去了**。
 *
 * ## 判据（三条，全部来自实测的合法样本特征）
 *
 * 1. **长度 ≥ 200** —— 实测合法值 280 字符；76 字符的是垃圾
 * 2. **是 base64 且能解出 JSON** —— 合法值是
 *    `{"certifyId":...,"sceneId":"11xygtvd","isSign":true,"securityToken":"..."}`
 * 3. **含 `securityToken` 且长度 ≥ 50** —— 实测合法值的 securityToken 有 100+ 字符
 *
 * 三条缺一即判为 degraded，**不发请求**（省一次注定 3007 的往返，
 * 也避免白耗一个 captcha 配额）。
 */
export function isUsableCaptchaParam(param: unknown): { ok: boolean; reason?: string } {
  if (typeof param !== "string" || param.length === 0) {
    return { ok: false, reason: "captcha param 缺失" };
  }
  if (param.length < 200) {
    return {
      ok: false,
      reason: `captcha param 长度 ${param.length} < 200（疑似 SDK 降级输出，发了必 3007）`,
    };
  }
  let decoded: string;
  try {
    decoded = Buffer.from(param, "base64").toString("utf8");
  } catch {
    return { ok: false, reason: "captcha param 不是合法 base64" };
  }
  let parsed: { securityToken?: unknown; sceneId?: unknown };
  try {
    parsed = JSON.parse(decoded) as typeof parsed;
  } catch {
    return { ok: false, reason: "captcha param 解出的不是 JSON" };
  }
  if (typeof parsed.securityToken !== "string" || parsed.securityToken.length < 50) {
    return {
      ok: false,
      reason: `securityToken 缺失或过短（${String(parsed.securityToken ?? "").length} < 50）`,
    };
  }
  return { ok: true };
}

/** 一次桥调用的通用结果。 */
export interface BridgeOpsResult<T> {
  readonly ok: boolean;
  readonly data?: T;
  /** 失败原因（人可读，可直接展示给用户）。 */
  readonly error?: string;
  /** HTTP 状态码，便于判断是桥不可达（无值）还是上游拒绝（有值）。 */
  readonly httpStatus?: number;
}

/**
 * 向桥发一次 JSON 请求。
 *
 * ## 设计取舍：为什么失败不抛异常
 *
 * 这三个操作的调用方是**用户命令**或**定时任务** —— 它们需要的是
 * 「能展示给用户的一句话」，而不是异常栈。所以统一返回
 * `{ok, data?, error?}`，让上层自由决定「报错」还是「静默重试」。
 *
 * 真正的编程错误（比如 URL 拼错）仍会体现为 `error` 字符串。
 */
async function callBridge<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; timeoutMs?: number },
): Promise<BridgeOpsResult<T>> {
  let endpoint: ZCodeBridgeEndpoint | undefined;
  try {
    endpoint = await resolveLiveBridgeEndpoint();
  } catch (error) {
    return {
      ok: false,
      error: `解析桥端点失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (endpoint === undefined) {
    return {
      ok: false,
      error:
        "找不到 ZCode 桥。请确认 ZCode 实例正在运行（且以 ZCODE_BRIDGE=1 启动）。",
    };
  }

  const timeoutMs = init.timeoutMs ?? 120_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${endpoint.baseUrl}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (response.status !== 200) {
      return {
        ok: false,
        httpStatus: response.status,
        error: `桥返回 ${response.status}：${text.slice(0, 300)}`,
      };
    }
    try {
      return { ok: true, httpStatus: response.status, data: JSON.parse(text) as T };
    } catch {
      return {
        ok: false,
        httpStatus: response.status,
        error: `桥返回的不是 JSON：${text.slice(0, 200)}`,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: controller.signal.aborted
        ? `等待桥响应超时（${timeoutMs}ms）`
        : `请求桥失败：${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** `POST /oauth/login` 的响应。 */
export interface OAuthLoginData {
  readonly ok?: boolean;
  readonly providerId?: string;
  readonly authorizeUrl?: string;
  readonly message?: string;
}

/**
 * 触发一次登录 —— **用户点一下，浏览器弹出授权页**。
 *
 * ## 用户视角
 *
 * 「点登录 → 弹出网页 → 授权成功 → 插件可以用额度」
 *
 * ## 语义（重要）
 *
 * **fire-and-forget 的触发 + 5 分钟轮询**：
 *
 * - 本函数返回时，授权页**刚打开**，登录**尚未完成**
 * - 实例侧会启动 5 分钟轮询（`OAuth polling flow started`），
 *   授权完成后经 `zcode://oauth/callback` 自动写回凭据
 * - 所以调用方**不要**把 `ok:true` 当成「已登录」，它只表示
 *   「授权页已弹出」
 *
 * 想确认登录是否完成，用 `fetchBilling()` 看额度是否可用 ——
 * 那是端到端的判据。
 */
export async function requestLogin(): Promise<BridgeOpsResult<OAuthLoginData>> {
  return await callBridge<OAuthLoginData>(OAUTH_LOGIN_PATH, {
    method: "POST",
    body: {},
    // 实例内部要先让 renderer 起 polling flow（实测 0.1-7.7 秒）
    timeoutMs: 60_000,
  });
}

/** `GET /diagnostics/billing` 的响应（字段与桥逐字对应）。 */
export interface BillingData {
  readonly ok?: boolean;
  readonly upstreamCode?: number | null;
  readonly upstreamMsg?: string;
  readonly planName?: string | null;
  readonly planId?: string | null;
  readonly planStatus?: string | null;
  /**
   * ⚠ 关键判据：
   * - `one_time` = 活动赠送（**会过期**，需要定时检索领取）
   * - `daily`    = 每日刷新（免费订阅）
   */
  readonly period?: string | null;
  readonly modelName?: string | null;
  readonly totalUnits?: number | null;
  readonly usedUnits?: number | null;
  readonly remainingUnits?: number | null;
  readonly availableUnits?: number | null;
  readonly expiresAt?: number | null;
  readonly expiresAtLocal?: string | null;
  readonly durationMs?: number;
  readonly deviceMidPresent?: boolean;
}

/** 查当前额度。 */
export async function fetchBilling(): Promise<BridgeOpsResult<BillingData>> {
  return await callBridge<BillingData>(DIAGNOSTICS_BILLING_PATH, {
    method: "GET",
    // 内含一次 mint（captcha），实测 2-10 秒
    timeoutMs: 90_000,
  });
}

/** `POST /diagnostics/claim` 的响应。 */
export interface ClaimData {
  readonly ok?: boolean;
  readonly discoveredPlans?: readonly string[];
  readonly results?: readonly {
    readonly planId?: string;
    readonly httpStatus?: number;
    readonly upstreamCode?: number | null;
    /** ⚠ 幂等语义：`1003`（已领取）也算成功。 */
    readonly ok?: boolean;
    readonly alreadyClaimed?: boolean;
    readonly body?: string;
    readonly error?: string;
  }[];
  readonly steps?: readonly Record<string, unknown>[];
  readonly durationMs?: number;
  readonly note?: string;
}

/**
 * 自动领取额度。
 *
 * ## 它替代了什么
 *
 * ZCode 客户端左下角那张额度卡片 —— 原本**必须人工点击**才领取。
 * 用户原话：
 *
 * > 「这个额度，是软件在 ui 界面的左下角弹出一个卡片，只有用户去点了
 * >   之后才领取。这个也需要自动化」
 *
 * ## 内部三步（桥侧实现）
 *
 * ① `POST /api/v1/event/report`（`app_launch` + `app_daily_active`）
 *     —— **关键**：不补这两条，`preview` 恒为空 `plans: []`。
 *     实测补前空、补后立刻出现 plan。
 * ② `GET /billing/preview` —— 发现可领的 plan
 * ③ `POST /billing/claim` —— 逐个领取（captcha 每个 plan 现 mint）
 *
 * ## `1003` 是成功
 *
 * 服务端对「已领取过」返回 `code:1003`。**那不是错误** ——
 * 把它当失败会让定时任务反复误报。
 */
export async function requestClaim(
  planId?: string,
): Promise<BridgeOpsResult<ClaimData>> {
  return await callBridge<ClaimData>(DIAGNOSTICS_CLAIM_PATH, {
    method: "POST",
    body: planId === undefined ? {} : { planId },
    // 三步串联：2 次 event_report + preview + N 次 (mint + claim)
    timeoutMs: 180_000,
  });
}
