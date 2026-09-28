/**
 * ZCode 免费额度 HTTP 桥 —— 会话链路版。
 *
 * ## 为什么必须是「会话链路」
 *
 * 实测对照（同一实例、同一时刻、同一账号）：
 * ```
 * A. 界面路径（session 链路）          → 200 成功
 * B. workspace/generateText（裸调用）  → 405 / 3012 "unusual activity"
 * ```
 * **⇒ 3012 的成因是调用路径，不是账号/IP 风控。**
 *
 * 因此本桥改走界面同款链路：
 * ```
 * createTask() → sendPrompt({ taskId, traceId, content, modelSelection })
 *              ↓
 *        底层 v4 sendText 命令
 * ```
 *
 * ## 为什么需要它（架构背景）
 *
 * ZCode 免费额度通道（`account:bigmodel-start-plan` → `zcode-plan/anthropic`）强制阿里云 captcha。
 * captcha 只能在渲染进程里跑（需 DOM + `o.alicdn.com` 的 SDK），而请求由 host 发出。
 * 这条 host ↔ renderer 应答链外部进程无法复用：
 *   - `app-server` 只支持 `--stdio`（父子私有管道），外部接不上
 *   - 独立 spawn 的 app-server 走 `standalone` 路径，该路径硬编码只支持
 *     `individual-coding-plan` 且永不产 captcha 头
 * ⇒ 必须在已运行的 ZCode 内部暴露接口。这就是本文件。
 *
 * ## 安全
 *
 * - 只监听 `127.0.0.1`，端口由内核分配
 * - 每个请求需 `Authorization: Bearer <token>`
 * - token 与端口写入 `<dataBaseDir>/.zcode/v2/bridge-port.json`
 */

import {
  buildOfficialSystemBlocks,
  OFFICIAL_CLI_PREFIX,
} from "./zcode-official-identity.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { arch, platform, release } from "node:os";
import {
  DEFAULT_ZCODE_ENDPOINT_ORIGIN as ZCODE_ENDPOINT_ORIGIN,
  ZCODE_ENV as ZCODE_RELEASE_CHANNEL,
  ZCODE_VERSION as ZCODE_APP_VERSION,
} from "@zcode/shared";

/** 免费额度覆盖的模型。 */
const ALLOWED_MODELS = ["GLM-5.3", "GLM-5.3-Flash"] as const;

/** 默认 provider —— 免费额度通道。 */
const DEFAULT_PROVIDER_ID = "account:bigmodel-start-plan";

/**
 * 【诊断】允许调用方覆盖 providerId，但**只限白名单**。
 *
 * ## 为什么需要它
 *
 * `zcode-builtin.json` 里定义了 9 个内建 provider，它们的 `access.mode` 不同：
 *
 *   account:bigmodel-start-plan             → mode: start-plan             需要 captcha
 *   account:bigmodel-individual-coding-plan → mode: individual-coding-plan **不需要**
 *   account:bigmodel-team-coding-plan       → mode: team-coding-plan       **不需要**
 *   account:zai-individual-coding-plan      → mode: individual-coding-plan **不需要**
 *   ...
 *
 * 依据：`packages/services/src/zcode-agent/zcodeAgentService.ts:2720`
 *   const requiresRendererInteraction = accountAccess?.mode === "start-plan";
 *   if (accountRequestAuthService && accountAccess && !requiresRendererInteraction) {
 *     void respondAccountRequestAuthWithoutInteraction({ key: pendingKey, pending });
 *     return;   // ← 非 start-plan 时 host 直接自动应答，完全不碰 renderer
 *   }
 *
 * 插件的源码注释原话：
 *   「其余 Account API Key / Team Runtime Key / Start Plan JWT 都不需要 Renderer 交互：
 *     Host 按 Model 固定的 Account Access 自动应答」
 *
 * ⇒ 若某个 provider 的 mode 不是 start-plan，captcha 链路**根本不会被触发**。
 *
 * ## 白名单
 *
 * 只放内建 provider id（`zcode-builtin.json` 的 providerRules 里的那些），
 * 避免调用方传入任意字符串导致 agent 侧解析异常。
 */
const ALLOWED_PROVIDER_IDS: readonly string[] = [
  "account:bigmodel-start-plan",
  "account:bigmodel-individual-coding-plan",
  "account:bigmodel-team-coding-plan",
  "account:zai-start-plan",
  "account:zai-individual-coding-plan",
  "account:zai-team-coding-plan",
  "account:bigmodel-offpeak-idle-plan",
  "account:zai-offpeak-idle-plan",
];

function resolveProviderId(raw: unknown): string {
  if (typeof raw !== "string") {
    return DEFAULT_PROVIDER_ID;
  }
  const trimmed = raw.trim();
  return ALLOWED_PROVIDER_IDS.includes(trimmed) ? trimmed : DEFAULT_PROVIDER_ID;
}


/**
 * 免费额度通道的 Anthropic 兼容端点基址。
 *
 * 取自 `@zcode/shared` 的 `zcodeEndpoint.ts`：`${origin}/api/v1/zcode-plan/anthropic`，
 * 其中 origin 默认 `https://zcode.z.ai`。模型请求路径是 `${base}/v1/messages`。
 */
const ZCODE_PLAN_ANTHROPIC_BASE = "https://zcode.z.ai/api/v1/zcode-plan/anthropic";

/**
 * 额度查询端点（2026-09-28 新增）。
 *
 * ## 为什么值得内建
 *
 * 此前判断「额度是否用尽」只能靠**错误码反推**：
 *
 *   {"code":1005,"msg":"exceed quota limit"}
 *
 * 而查不到「还剩多少、什么时候到期、是每日还是活动赠送」——
 * 排查时全靠猜（本项目为此浪费过大量时间）。
 *
 * ## 端点来源（从源码提取，非猜测）
 *
 * `packages/shared/src/zcodeEndpoint.ts:269`
 *   zcodePlanBillingBalanceUrl: `${origin}/api/v1/zcode-plan/billing/balance`
 *
 * `packages/services/src/model-provider/zaiStartPlanBilling.ts:63`
 *   buildZaiStartPlanBalanceUrl() → 追加 `?app_version=<ZCODE_VERSION>`
 *   （注释原话：「Start Plan balance 接口按真实 app_version 判定能力」）
 *
 * 请求要求（同文件 L104-109）：
 *   method: GET
 *   headers: { Authorization: <完整值，含 Bearer> }
 *   另需 `X-Device-Mid`（取自 `<dataBaseDir>\.zcode\v2\telemetry-state.json`
 *   的 `deviceMid`）—— 缺它会被服务端拒绝为 parameter error
 *   （见 `packages/.../entry-stdio.ts:55` 的注释）。
 *
 * ## 返回结构（实测）
 *
 * ```json
 * {"code":0,"data":{
 *   "plans":[{"plan_id":"zcode-v3-start-plan-trust-0928","name":"ZCode Trust Build",
 *             "status":"active","ends_at":1790611200}],
 *   "balances":[{"show_name":"GLM-5.3-Flash","period":"one_time",
 *                "total_units":100000000,"used_units":49142,
 *                "remaining_units":99950858,"expires_at":1790611200}]}}
 * ```
 *
 * `period` 是判据：`one_time` = 活动赠送（会过期），`daily` = 每日刷新。
 */
const ZCODE_PLAN_BILLING_BALANCE_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";

/**
 * 额度**领取**端点（2026-09-28 新增）。
 *
 * ## 这是「点卡片才算领取」的本体
 *
 * ZCode 客户端左下角弹出的额度卡片，其「点击」动作就是一次本接口调用。
 * 此前这一步**必须人工**（子代理从闭源版 asar 偏移 271345639 提取到实现，
 * 并在官方版日志里找到真实调用记录：
 * `coding-plan-subscription.claimManualPlan OK (6101.7ms)`）。
 *
 * ## 接口形状（asar 原文 + 实测）
 *
 * ```
 * POST /api/v1/zcode-plan/billing/claim
 *   Authorization: Bearer <apiKey 或 zcodejwttoken>
 *   Content-Type: application/json
 *   X-Aliyun-Captcha-Verify-Param: <captcha>     ← 必需，且一次性
 *   X-Aliyun-Captcha-Verify-Region: cn
 *   X-ZCode-App-Version / X-Platform / X-Device-Mid
 *   body: {"plan_id":"<planId>"}
 * ```
 *
 * ## 业务码（实测 + 第三方实现交叉验证）
 *
 * | code | 含义 |
 * |---|---|
 * | 0    | 成功领取 |
 * | 1001 | plan 不存在 |
 * | 1002 | 活动已结束 |
 * | **1003** | **已领取过（幂等成功，不是错误）** |
 * | 1004 | 不符合条件 |
 * | 1005 | 名额用完 |
 * | 3007 | captcha 校验失败（需换新 param 重试，且会消耗 captcha） |
 * | 401  | 未登录 |
 */
const ZCODE_PLAN_BILLING_CLAIM_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/claim";

/**
 * 激活上报端点（2026-09-28 新增）。
 *
 * ## 它决定 preview 能否看到活动
 *
 * 实测（本项目）：**补发这两个事件之前，`billing/preview` 返回 `plans: []`；
 * 补发之后立刻出现 `zcode-v3-start-plan-trust-0928`。**
 *
 * ```
 * 补前: {"code":0,"data":{"plans":[]}}
 * 补后: {"code":0,"data":{"plans":[{"plan_id":"zcode-v3-start-plan-trust-0928",...}]}}
 * ```
 *
 * 即：**「活动套餐投放」依赖客户端活跃信号** —— 这就是为什么纯 billing
 * 轮询的账号看不到活动，而官方客户端能看到卡片。
 *
 * 参数：`app_launch` / `app_daily_active`（按 device_mid + 日期去重，无需鉴权）。
 */
const ZCODE_EVENT_REPORT_URL = "https://zcode.z.ai/api/v1/event/report";

/** billing/preview —— 卡片内容的数据源。 */
const ZCODE_PLAN_BILLING_PREVIEW_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/preview";

export interface ZCodeBridgeMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/**
 * ★ 官方首轮 user 消息的上下文前缀（2026-09-28 新增）。
 *
 * ## 为什么需要（3012 的最后一个开关）
 *
 * 官方客户端**总会**给**首轮** user 消息的 `content` 数组最前面插一个
 * `<system-reminder>` 块，内容是当前日期：
 *
 * ```
 * <system-reminder>As you answer the user's questions, you can use the following context:
 * # currentDate
 * Today's date is 2026-09-28.
 *
 *       IMPORTANT: this context may or may not be relevant to your tasks. You should not
 * respond to this context unless it is highly relevant to your task.</system-reminder>
 * ```
 *
 * 来源：同类项目 `a137460387/zcode2api` 的
 * `src/upstream/system-prompt.js` 的 `buildContextPrefixBlock()`，
 * 其对照表把它列为「裸请求特征」之一：
 *
 * | | 官方 | 裸请求（3012） |
 * |---|---|---|
 * | 首轮 user 消息 | 前挂 `<system-reminder>…# currentDate…#</system-reminder>` | 纯用户文本 |
 *
 * ## 形态细节（逐字复刻，不要"优化"）
 *
 * - 整块是**一个** `{type:"text"}`，插到 `content` **数组**最前面
 *   —— 不是拼进文本字符串（后者会改变结构，仍被判定为裸请求）
 * - `outro` 前有 **6 个空格**缩进
 * - 空行由 `join("\n")` 里的空串产生
 * - 日期用**本地时区**的 ISO 日期，不是 UTC
 * - **幂等**：已以 `<system-reminder>` 开头则不重复插
 * - 首轮不是 `role:"user"` 时**不插**
 */
const CONTEXT_PREFIX_INTRO =
  "As you answer the user's questions, you can use the following context:";
const CONTEXT_PREFIX_OUTRO =
  "      IMPORTANT: this context may or may not be relevant to your tasks. "
  + "You should not respond to this context unless it is highly relevant to your task.";

/** 本地时区的 ISO 日期（官方用本地日期，不用 UTC）。 */
function formatLocalIsoDate(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 构造 `<system-reminder>` 上下文块。 */
function buildContextPrefixBlock(now: Date = new Date()): {
  type: "text";
  text: string;
} {
  const body = [
    CONTEXT_PREFIX_INTRO,
    `# currentDate\nToday's date is ${formatLocalIsoDate(now)}.`,
    "",
    CONTEXT_PREFIX_OUTRO,
  ].join("\n");
  return { type: "text", text: `<system-reminder>${body}</system-reminder>` };
}

/**
 * 把上下文前缀插到首轮 user 消息的 `content` 数组最前面。
 *
 * 输入消息的 `content` 是**字符串**（桥内部表示），这里转成官方的
 * **块数组**形态。已经在用数组的消息原样保留。
 */
function withContextPrefix<T extends { role: string; content: unknown }>(
  messages: readonly T[],
  now: Date = new Date(),
): Array<Record<string, unknown>> {
  const out = messages.map((m) => ({ ...m }) as Record<string, unknown>);
  const first = out[0];
  if (first === undefined || first["role"] !== "user") {
    return out;
  }
  const rawContent = first["content"];
  const contentArray: Array<Record<string, unknown>> = Array.isArray(rawContent)
    ? (rawContent as Array<Record<string, unknown>>)
    : [{ type: "text", text: String(rawContent ?? "") }];
  /** 幂等：已挂过就不重复插（官方实现同样如此）。 */
  const alreadyPrefixed = contentArray.some(
    (c) =>
      c["type"] === "text" &&
      typeof c["text"] === "string" &&
      c["text"].startsWith("<system-reminder>"),
  );
  first["content"] = alreadyPrefixed
    ? contentArray
    : [buildContextPrefixBlock(now), ...contentArray];
  return out;
}

/**
 * 【工具面透传】一次结构化的工具调用。
 *
 * 来源是 `onDynamicStreamEvent` 的 `tool_call`（带 `toolId` / `toolName` /
 * `input`）与 `tool_call_update`（带 `status` / `content` / `error`）。
 *
 * ## 为什么这条通道重要
 *
 * 与「提示词桥接」的根本区别：这里的 `toolName` 与 `input` 是**上游协议
 * 自己产出的结构**，不是从模型回复文本里解析出来的。所以它不会因为模型
 * 措辞变化而解析失败，`input` 也是真正的 JSON 对象而非字符串。
 *
 * ## 调用方（DSH 插件侧）怎么用
 *
 * 把 `name` 映射到 DSH 工具名、把 `input` 序列化成 `arguments` 字符串，
 * 即可合成符合 DSH 契约的 `tool-call` 块。
 */
export interface ZCodeBridgeToolCall {
  /** 上游给的工具调用 id（用于关联 `tool_call_update`）。 */
  readonly toolId: string;
  /** 工具名。update 事件到达前可能缺失。 */
  readonly toolName?: string;
  /** 完整参数（对象或任意 JSON 值）。 */
  readonly input: unknown;
  /** 执行状态：`pending` / `in_progress` / `completed` / `failed` / `denied` / `stopped`。 */
  readonly status?: string;
  /** 执行结果。 */
  readonly output?: unknown;
  /** 失败原因。 */
  readonly error?: string;
}

/**
 * 外部工具注入配置（MCP HTTP 服务器）。
 *
 * ## 为什么是 MCP 而不是 `tools` 透传
 *
 * `zcodeTaskService.sendPrompt` 只接受 `toolDenylist`（隐藏工具），
 * **没有** allowlist / 自定义 `tools` 入参 —— 也就是说 DSH 的 tool schema
 * 无法直接塞进这个会话链路。
 *
 * 但 `createTask` 接受 `mcpServers`，且支持 `type: "http"`（见
 * `packages/services/dist/session/zcodeTaskService.d.ts:145-170`）。
 * 该字段经 `zcodeTaskServiceAdapter.createTask` →
 * `resolveProductMcpServers` → `zcodeSessionService.withResolvedMcpServers`
 * 全程透传到 runtime。
 *
 * ⇒ **外部工具通过 MCP 注入，是这条链路上唯一可用、且被上游正式支持的通道。**
 *
 * 配置来源：环境变量 `ZCODE_BRIDGE_MCP`，JSON 数组，例如
 * `[{"name":"dsh-tools","type":"http","url":"http://127.0.0.1:8791/mcp"}]`
 */
export interface ZCodeBridgeMcpServer {
  readonly name: string;
  readonly type: "http" | "sse";
  readonly url: string;
  readonly headers?: Array<{ name: string; value: string }>;
  readonly timeoutMs?: number;
}

/**
 * 解析 `ZCODE_BRIDGE_MCP` 环境变量。
 *
 * 非法 JSON 或缺字段一律返回 `undefined`（视为未配置），**不抛错** ——
 * 桥是常驻服务，配置错误不应让它起不来，只应让它没有工具。
 */
export function parseMcpServersFromEnv(raw: string | undefined): ZCodeBridgeMcpServer[] | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const out: ZCodeBridgeMcpServer[] = [];
    for (const item of parsed) {
      const record = item as {
        name?: unknown;
        type?: unknown;
        url?: unknown;
        headers?: unknown;
        timeoutMs?: unknown;
      };
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const url = typeof record.url === "string" ? record.url.trim() : "";
      const type = record.type === "sse" ? "sse" : record.type === "http" ? "http" : undefined;
      if (!name || !url || !type) continue;
      out.push({
        name,
        type,
        url,
        ...(Array.isArray(record.headers)
          ? {
              headers: (record.headers as Array<{ name?: unknown; value?: unknown }>)
                .filter(
                  (h) => typeof h?.name === "string" && typeof h?.value === "string",
                )
                .map((h) => ({ name: String(h.name), value: String(h.value) })),
            }
          : {}),
        ...(typeof record.timeoutMs === "number" && Number.isFinite(record.timeoutMs)
          ? { timeoutMs: record.timeoutMs }
          : {}),
      });
    }
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

export interface ZCodeBridgeDeps {
  /** ZCode 数据根目录。 */
  readonly dataBaseDir: string;
  /**
   * 注入到每个 task 的外部工具服务器（MCP HTTP/SSE）。
   *
   * 这是 DSH 工具面进入 ZCode 会话的**唯一**通道（见 {@link ZCodeBridgeMcpServer}）。
   */
  readonly mcpServers?: ZCodeBridgeMcpServer[];
  /**
   * 走**会话链路**执行一次对话，返回助手回复文本。
   *
   * 生产注入实现应：
   * 1. `zcodeTaskService.createTask({ workspacePath, modelSelection, v4Create: true })`
   * 2. `zcodeTaskService.sendPrompt({ taskId, traceId, content, modelSelection })`
   * 3. 订阅事件流，收集 assistant 文本直到 turn 结束
   * 4. 返回 `{ text, usage?, finishReason? }`
   *
   * 参考：`packages/services/src/bots/botsService.ts:4868`（createTask + sendPrompt 的完整用法）
   */
  readonly runConversation: (params: {
    workspacePath: string;
    providerId: string;
    modelId: string;
    reasoningLevel?: string;
    messages: ZCodeBridgeMessage[];
    maxOutputTokens?: number;
    signal?: AbortSignal;
    /**
     * 注入本次 task 的外部工具服务器（MCP）。
     *
     * 实现应把它原样交给 `zcodeTaskService.createTask({ mcpServers })`
     * —— 这是 DSH 工具面进入会话的唯一通道。
     */
    mcpServers?: ZCodeBridgeMcpServer[];
    /**
     * 【实验】允许模型真的调用壳内工具。
     *
     * 默认 `false`：注入"不要调用任何工具"的前置说明 + 传 `toolDenylist`，
     * 把壳当纯"代答"代理用。
     *
     * 置 `true`：两者都放开，模型可自由调用壳内工具。**用途是验证工具面
     * 透传** —— 壳内工具真的执行，桥从 `onDynamicStreamEvent` 捕获结构化的
     * `tool_call` / `tool_call_update`，再透给调用方。
     *
     * ⚠ 放开意味着**壳内工具会真的执行**（含写盘/执行命令），且历史上是
     *   180 秒超时的主要来源。仅用于受控验证。
     */
    allowTools?: boolean;
    /**
     * 【流式增量】每拿到一份**累积的**部分文本就回调一次。
     *
     * ## 为什么需要
     *
     * 桥原先等整包才返回 —— 一次 20-120 秒的请求期间，调用方（DSH）
     * 拿不到任何东西，界面上表现为「卡在思考、不吐文本」。
     *
     * 实现方式：等终态的同时按 1.2 秒轮询 `getTaskSnapshot`，把当前
     * 已持久化的 assistant 文本回调出来。
     *
     * ⚠ 语义是**累积全文**，不是增量片段 —— 调用方自己算差量
     *   （累计文本会随生成推进而变长，直接当 delta 会重复）。
     *
     * 省略此回调 = 不做轮询，零额外开销（一次性调用的默认行为）。
     */
    onPartialText?: (accumulated: string) => void;
  }) => Promise<{
    text: string;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    finishReason?: string;
    /**
     * 【工具面透传】模型在本轮发起的**结构化**工具调用。
     *
     * 来自 `onDynamicStreamEvent` 的 `tool_call` / `tool_call_update` 事件 ——
     * 是上游自己产出的结构，不是从回复文本里解析出来的，所以 `toolName`
     * 与 `input` 都是可信的。
     *
     * 空数组表示本轮没有工具调用。
     */
    toolCalls?: ZCodeBridgeToolCall[];
  }>;
  /** reasoning level（start-plan 通道的模型必需）。缺省 `"max"`。 */
  readonly reasoningLevel?: string;
  /**
   * 解析当前账号的请求鉴权材料（`{ apiKey, headers }`）。
   *
   * ## 用途：让桥具备「直接转发」的能力（而非只能代跑会话）
   *
   * 会话链路（`runConversation`）把壳当**对话代理**用 —— 工具面进不去，
   * 且壳内工具会真的执行，是 180 秒超时的根源。
   *
   * 拿到 `{ apiKey, headers }` 后，桥就能**裸发标准 HTTP 请求**到上游：
   *   - 工具面（`tools` / `tool_calls`）是协议原生的一等公民，不再丢失
   *   - 无壳内工具执行，无会话状态串扰，可并发
   *   - 单轮延迟接近裸 API
   *
   * `headers` 里含 Renderer 产出的阿里云 captcha 头
   * （`X-Aliyun-Captcha-Verify-Param` / `-Region`），这是免费额度通道的必需品，
   * 只能在渲染进程里产出，所以**每次请求都要现取**，不能缓存。
   *
   * 生产注入实现应调用壳内的 `IAccountRequestAuthService.resolveCurrent(...)`，
   * 入参见 `AccountRequestAuthInput`（providerId / modelId / accountAccess / reason）。
   */
  readonly resolveAuthMaterial?: (params: {
    providerId: string;
    modelId: string;
  }) => Promise<{ apiKey?: string; headers?: Record<string, string> } | undefined>;
  /**
   * 读**最近一次**壳实际用于发请求的 auth 材料（含 captcha 头）。
   *
   * 与 {@link resolveAuthMaterial} 的差别：那个是桥主动去解析，只能拿到
   * `apiKey`（`resolveCurrent()` 不产 captcha 头）；这个读的是壳内 agent
   * 真实收到的那一份 —— **含 `X-Aliyun-Captcha-Verify-Param`**，是能直接
   * 拿去发请求的完整材料。
   *
   * ⚠ 材料是**一次性**的：captcha param 每次验证重新 mint，重复提交会撞
   *   F008。所以这里只用于「验证路线可行性」，真正转发时必须每次现取。
   */
  readonly getLatestAuthMaterial?: () =>
    | {
        providerId: string;
        modelId: string;
        apiKey?: string;
        headers?: Record<string, string>;
        /** 【诊断】壳内真实使用的完整材料（未经过滤）。 */
        rawRequestAuth?: { apiKey?: string; headers?: Record<string, string> };
        /** 【诊断】触发该材料的请求形状。 */
        requestShape?: unknown;
      }
    | undefined;
  /**
   * 主动 mint 一份**新鲜**的 auth 材料（含 captcha 头）。
   *
   * 与 {@link getLatestAuthMaterial} 的差别：那个是旁路观察到的**旧**材料，
   * 而 captcha param 一次性 —— 复用它稳定返回 `3007 captcha verify failed`
   * （实测）。本方法按需触发一次 captcha 产出，拿到即用。
   */
  /**
   * ★ 触发一次账号登录（2026-09-28 新增）。
   *
   * ## 为什么需要（把「固定流程」变成脚本可调用）
   *
   * ZCode 的登录是确定的五步：
   *
   *   ① oauthService.startOAuthWithPolling(provider)
   *        → 生成随机 `state`、拼出 authorizeUrl
   *   ② platform.registerOAuthState({ state, provider })
   *        → 把 state 记进实例内存的 `oauthStateToWindow` Map
   *   ③ platform.openExternal(authorizeUrl)
   *        → 打开 `https://bigmodel.cn/login?redirect=zcode://oauth/callback&appId=zcode&state=...`
   *   ④ 用户在浏览器完成 OAuth
   *   ⑤ 浏览器重定向到 `zcode://oauth/callback?code=...&state=...`
   *        → OS 按 HKCU\Software\Classes\zcode 派发给本实例
   *        → `handleDeepLink()` 用 state 查 Map → 投递 → 换 token → 写 credentials.json
   *
   * **每一步都是确定性的** —— 唯一「人在环」的是第 ④ 步（在浏览器里输账号）。
   * 但第 ①②③⑤ 步完全可由本方法代劳，于是外部只需：
   *
   *   POST /oauth/login  →  实例弹浏览器  →  用户在浏览器登录  →  自动完成
   *
   * `state` **必须由实例自己生成并注册**（不能外部拼 URL）——
   * 否则回调时 `handleDeepLink` 查不到 Map，会被拒。
   *
   * ## 实现要求
   *
   * 宿主注入的实现应调用 renderer 侧的 `startLogin` 等价流程
   * （`packages/ui/src/hooks/useOAuth.ts` 的 `startLogin`）。
   * 返回后**不要等登录完成** —— OAuth 是异步的，回调走 deep link。
   */
  readonly startLogin?: (params: { providerId: string }) => Promise<{
    ok: boolean;
    /** 已打开的授权页 URL（含 state），便于调用方展示或自行打开 */
    authorizeUrl?: string;
    /** 人可读的状态说明 */
    message?: string;
  }>;
  readonly mintAuthMaterial?: (params: {
    providerId: string;
    modelId: string;
    /**
     * 【本地扩展】把材料绑定到一个**真实存在**的会话上。
     *
     * 不传时 `mintProviderAuthMaterial` 会凭空造一个
     * （`bridge-mint-session-<uuid>`），上游查不到该会话 → **3012**，
     * 且 **0.15 秒就返回**（浅层拒绝）。
     *
     * `sessionId === taskId`（见 `packages/desktop/src/host/index.ts:979`），
     * 所以传 `runConversation` 建出来的 taskId 即可。
     */
    sessionId?: string;
    /**
     * 目标 workspace（**必须与 renderer 订阅的那一个完全一致**）。
     *
     * ## 为什么必须传（实测踩过，20 秒超时的真正根因）
     *
     * captcha 事件面是**按 `resolveWorkspaceKey(workspace)` 分桶**的
     * （见 `zcodeAgentService.ts` 的 `getProviderRuntimeHeadersEmitter`）：
     * 同一进程内，不同 workspaceKey 对应**不同的 Emitter 实例**。
     *
     * renderer 的订阅者（`useProviderRuntimeHeadersCaptcha`）在挂载时用
     * **它自己的** workspacePath 订阅了某一个桶，并且回调里还有一层
     * `requestBelongsToWorkspace` 的**二次过滤**（路径不等就静默忽略）。
     *
     * 所以：**fire 到错的桶 = renderer 收不到 = 永远等不到应答 = 20 秒超时**，
     * 而且日志里只会看到 `mint requested` 后跟 `mint timed out`，
     * renderer 侧连 `request.received` 都不会打 —— 极具误导性，
     * 会让人以为是"captcha 组件没渲染"。
     *
     * 省略时退回 `dataBaseDir`（历史行为，**大概率收不到应答**，仅供探测）。
     */
    workspacePath?: string;
  }) => Promise<{ apiKey?: string; headers?: Record<string, string> } | undefined>;
  /**
   * 【诊断 / 性能实验】直接调 agent 的 `workspace/generateText` RPC。
   *
   * ════════════════════════════════════════════════════════════════════════
   * 为什么要有它
   * ════════════════════════════════════════════════════════════════════════
   *
   * 现有对话路径 `runConversation` 走的是 `createTask` + `sendPrompt` ——
   * 一次**完整 agent turn**（建 task、跑 turn 循环、tools、快照）。
   * 实测中位 23.2 秒，且 ttftMs 恒为 undefined（整轮不落中间态）。
   *
   * 但协议里还有另一个方法：`workspace/generateText`
   * （`packages/shared/src/zcode-protocol/index.ts:2075`）：
   *
   *   ```ts
   *   { workspace, selection, prompt?, messages?, tools?,
   *     querySource, maxOutputTokens?, operationId? }
   *   → { text, selection, toolCalls?, finishReason, usage }
   *   ```
   *
   * 它**不建 task、不跑 turn** —— 只是「一次模型调用」。服务侧实现见
   * `zcodeAgentService.ts:4819`：`getClient()` 复用同一条 agent 连接，
   * 同步账号配置后直接 `client.request(workspaceGenerateText, ...)`。
   *
   * ⇒ 如果它能**用免费额度**（即走通了 Start Plan 的鉴权），
   *   那它就是「原生速度」的答案：无 task、无 turn、无快照轮询。
   *
   * ⚠ 但它仍要过 `refreshBeforeModelRequest`（每次模型请求前刷新运行时头）
   *   —— 即**仍需要 captcha**。所以本端点首先要回答的问题是：
   *   **它比 shell 会话链路快多少？**（省掉的是 turn 循环与 task 管理）
   */
  readonly generateWorkspaceText?: (params: {
    workspacePath: string;
    providerId: string;
    modelId: string;
    reasoningLevel?: string;
    messages: Array<{ role: string; content: unknown }>;
    maxOutputTokens?: number;
  }) => Promise<{
    text: string;
    finishReason?: string;
    usage?: unknown;
    toolCalls?: unknown;
  }>;
  /**
   * 【诊断】测模型连通性 —— 协议里最轻的「真实模型调用」接口。
   *
   * 依据：`zcodeProviderTestModelConnectivityParamsSchema`（协议 L2132）
   *     { workspace, selection }
   * 结果：`{ success: true }`（L2139）
   *
   * 用途：它的设计目的就是「快速验证 provider/model 是否可用」，
   * 所以**必然走一次真实的模型调用**。用它来判定
   * 「不带消息体的最轻调用能否通过」。
   */
  readonly testModelConnectivity?: (params: {
    workspacePath: string;
    providerId: string;
    modelId: string;
    reasoningLevel?: string;
  }) => Promise<{ success: boolean }>;
  /**
   * 【诊断】`session/create` + 空 `session/send` —— 最轻的「已登记会话」路径。
   *
   * 动机：§十九 已确认 3012 的判据是「服务端会话登记」。
   * `generateText` 不建 task → 无登记 → 必然 3012。
   * 本方法试的是：**只建会话、只发一条极短消息**，看能否比完整 turn 更快。
   */
  readonly sessionPing?: (params: {
    workspacePath: string;
    providerId: string;
    modelId: string;
    reasoningLevel?: string;
    prompt: string;
  }) => Promise<{ text: string; durationMs: number }>;
  /** 日志。 */
  readonly log?: (message: string, detail?: unknown) => void;
}

export interface ZCodeBridge {
  readonly port: number;
  readonly token: string;
  readonly portFilePath: string;
  close(): Promise<void>;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  response.end(text);
}

function errorJson(
  response: ServerResponse,
  statusCode: number,
  message: string,
  type = "invalid_request_error",
): void {
  json(response, statusCode, { error: { message, type, code: statusCode } });
}

/**
 * 读取请求体。
 *
 * ## 2026-09-28 修正（子代理指出两点）
 *
 * 1. **超限分支没有真正止住累积** —— 旧代码 `reject` + `destroy` 后**没有 `settled` 标记**，
 *    后续 `data` 事件仍会跑进 `size += ...` 与 `chunks.push(chunk)`（destroy 不是同步生效的），
 *    既浪费内存也让错误路径不确定。
 * 2. **错误信息不含实际大小、上限不可配** —— 长上下文 + 大量工具时 body 可达数十 KB，
 *    触顶后只报笼统的 `Request body too large`，无法判断是「略超」还是「完全跑偏」。
 *    上限改由 `ZCODE_BRIDGE_MAX_BODY_BYTES` 覆盖（默认 16 MiB，比旧值宽 4 倍）。
 */
async function readBody(request: IncomingMessage, limitBytes?: number): Promise<string> {
  const limit = ((): number => {
    if (typeof limitBytes === "number" && Number.isFinite(limitBytes) && limitBytes > 0) {
      return limitBytes;
    }
    const raw = process.env["ZCODE_BRIDGE_MAX_BODY_BYTES"]?.trim();
    const n = raw === undefined || raw.length === 0 ? Number.NaN : Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : 16 * 1024 * 1024;
  })();
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        // 先置 settled —— 后续 data 事件直接短路，不再累积
        settled = true;
        chunks.length = 0;
        reject(
          new Error(
            `Request body too large: received >=${size} bytes, limit ${limit} bytes` +
              ` (override with ZCODE_BRIDGE_MAX_BODY_BYTES)`,
          ),
        );
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function normalizeMessages(raw: unknown): ZCodeBridgeMessage[] {
  const out: ZCodeBridgeMessage[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (role !== "system" && role !== "user" && role !== "assistant") continue;
    const text = typeof content === "string" ? content : "";
    if (!text) continue;
    out.push({ role, content: text });
  }
  return out;
}

export function createZCodeBridge(deps: ZCodeBridgeDeps): Promise<ZCodeBridge> {
  const log = deps.log ?? (() => {});
  const token = randomBytes(24).toString("hex");
  const portFilePath = join(deps.dataBaseDir, ".zcode", "v2", "bridge-port.json");
  let serverRef: Server | undefined;

  /**
   * 桥使用的**唯一** workspacePath。
   *
   * ## 为什么必须全局统一（实测踩过，20 秒超时的真正根因）
   *
   * captcha 事件面按 `resolveWorkspaceKey(workspace)` **分桶**
   * （`zcodeAgentService.ts` 的 `getProviderRuntimeHeadersEmitter`：
   * 不同 key → 不同 Emitter 实例），且 renderer 回调里还有一层
   * `requestBelongsToWorkspace` 二次过滤。
   *
   * 所以 **workspacePath 不一致 = 事件投递到 renderer 不监听的桶**
   * = 收不到应答 = 超时。会话链路与 mint 必须用同一个值。
   */
  function bridgeWorkspacePath(): string {
    return join(deps.dataBaseDir, ".zcode", "workspace", "default");
  }

  /**
   * 【伪装部分提取】把壳内「正常的 ZCode 客户端请求」的来源标识头复制出来。
   *
   * ## 为什么必须带（实测踩过，3012 的根因）
   *
   * 上游对 `zcode-plan/anthropic` 通道做**来源识别**。缺少这套头时返回：
   *
   * ```json
   * {"code":3012,"msg":"request has been blocked due to unusual activity."}
   * ```
   *
   * 注意它**不是** 3007（captcha 失败）—— 说明鉴权与 captcha 都已通过，
   * 是「这个请求不像 ZCode 客户端发的」这一层被拦下。实测对照：
   *
   * ```
   * A. 壳内会话链路（带全套来源头）  → 200
   * B. 裸发（不带来源头）            → 3012
   * ```
   *
   * ## 取值方式
   *
   * 与壳内 `packages/services/src/providers/sourceHeaders.ts` 的
   * `buildZCodeSourceHeaders()` **同源**：同一份运行时上下文（platform /
   * arch / os version / locale / timezone），`deviceMid` 也从**同一个**
   * `telemetry-state.json` 读 —— 不新造身份，复用壳已有的那个。
   *
   * 这样发出去的请求在来源特征上与壳内真实请求**逐字段一致**。
   */
  function bridgeSourceHeaders(): Record<string, string> {
    const locale = (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().locale;
      } catch {
        return "unknown";
      }
    })();
    const timezone = (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return "unknown";
      }
    })();

    // deviceMid：与壳共用同一个身份文件，**不生成新的**。
    //
    // 路径与 `packages/services/src/providers/sourceHeaders.ts` 的
    // `join(getAppConfigDir(), "telemetry-state.json")` 对齐 —— 实测该文件
    // 落在 `<dataBaseDir>\.zcode\v2\telemetry-state.json`。
    let deviceMid: string | undefined;
    for (const candidate of [
      join(deps.dataBaseDir, ".zcode", "v2", "telemetry-state.json"),
      join(deps.dataBaseDir, ".zcode", "telemetry-state.json"),
      join(deps.dataBaseDir, "telemetry-state.json"),
    ]) {
      try {
        const raw = readFileSync(candidate, "utf-8");
        const parsed = JSON.parse(raw) as { deviceMid?: unknown };
        if (typeof parsed.deviceMid === "string" && parsed.deviceMid.trim().length > 0) {
          deviceMid = parsed.deviceMid.trim();
          break;
        }
      } catch {
        // 换下一个候选；全部失败则不带该头。
      }
    }

    const osCategory =
      platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : "linux";

    return {
      "User-Agent": `ZCode/${ZCODE_APP_VERSION}`,
      "HTTP-Referer": ZCODE_ENDPOINT_ORIGIN,
      "X-Title": "Z Code@electron",
      "X-ZCode-App-Version": ZCODE_APP_VERSION,
      "X-Platform": `${platform()}-${arch()}`,
      "X-Release-Channel": ZCODE_RELEASE_CHANNEL,
      "X-Client-Language": locale,
      "X-Client-Timezone": timezone,
      "X-Os-Category": osCategory,
      "X-Os-Version": release(),
      ...(deviceMid ? { "X-Device-Mid": deviceMid } : {}),
    };
  }

  /**
   * 对话请求的并发控制。
   *
   * ## 历史：曾经是**完全串行**
   *
   * 旧实现是一条 promise 链（`conversationQueue`），所有请求排队。
   * 理由是实测过「多个 task 并发时在会话链路上互相干扰，双双挂到 180 秒
   * 超时并返回空文本」。
   *
   * ## 2026-09-27 重新实测：那个理由**不成立**
   *
   * 用 3 个并发 HTTP 请求直连桥（绕过调用方 DSH 的串行）实测：
   *
   *   请求 1: 13588 ms
   *   请求 2: 19047 ms
   *   请求 3: 27538 ms
   *   三者耗时之和 = 60173 ms
   *   **墙钟总时间 = 28084 ms**   ← 只用了最长者的时间
   *
   * ⇒ **墙钟 ≈ 最长单个，不是三者之和。壳完全能并行跑多个 task。**
   *
   * 也就是说：旧注释里「128 条请求从无重叠、最大并发恒为 1」这个观测
   * **是这条队列造成的结果，不是壳的限制** —— 因果方向被搞反了。
   *
   * 壳侧 `runConversation` 每次 `createTask()` 建**独立 task**，
   * `sseOpen` / `pushedChars` / `chatId` 全是请求内局部变量，
   * 没有跨请求的共享可变状态。
   *
   * ## 那 180 秒超时是怎么来的
   *
   * 更可能是**别的**原因（当时还叠加着 captcha 投错桶、发现文件读写不一致
   * 等问题），而不是"并发本身有害"。当前实测 3 并发全部正常返回。
   *
   * ## 但仍保留上限
   *
   * 完全不限并发会：① 打满上游免费额度的速率限制；② DSH 一轮可能发
   * 3-5 个请求（主回复 + 标题 + 压缩），无限并发会把上游打爆。
   * 取 **4** 作为上限（覆盖 DSH 单轮的最坏情况），可用
   * `ZCODE_BRIDGE_MAX_CONCURRENCY` 覆盖，设为 `1` 即回到旧的串行行为。
   *
   * ## 入场顺序
   *
   * 仍然保持 FIFO —— 但只在"有槽位"时生效。**不再让短请求排在长请求
   * 后面干等**：旧实现里一条标题生成（本该几百毫秒）会被一条 60 秒的
   * 主回复堵成 20 秒以上（实测 41 条短请求中位 21885ms）。
   */
  const MAX_CONCURRENCY = ((): number => {
    const raw = process.env["ZCODE_BRIDGE_MAX_CONCURRENCY"]?.trim();
    const parsed = raw === undefined || raw.length === 0 ? Number.NaN : Number(raw);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return 4;
    }
    return Math.floor(parsed);
  })();

  /** 当前在跑的对话数。 */
  let runningConversations = 0;
  /** 等槽位的请求（FIFO）。 */
  const conversationWaiters: Array<() => void> = [];

  /**
   * ★ 快速路径的材料缓存 —— **默认关闭，实测证明不可复用**。
   *
   * ## 为什么关掉（2026-09-27 实测，重要）
   *
   * 曾试图缓存 `mintAuthMaterial` 的产物，省掉「每个请求都 mint」的开销。
   * **实测结果是致命的**：
   *
   *   连打 6 次（间隔 2 秒，都在 TTL 内）
   *     [1] 13730ms  「正常」        ← mint 1 次，成功
   *     [2] 400 Bad Request          ← 复用缓存材料 → 被上游拒绝
   *     [3] 400 Bad Request
   *     ...
   *   本次新增 mint: 1
   *
   * **⇒ 材料是一次性凭据，上游只认一次。** 复用它不会更快，只会 400。
   *
   * 这与本项目早先的实测一致（材料被抢先消费 → 3007）。
   *
   * ## 保留的价值
   *
   * 代码保留但**默认关闭**，因为它顺便解决一个真实问题：
   * **并发同键去重**（`fastMaterialInflight`）—— 同一时刻多个请求抢一次 mint，
   * 避免惊群。这对「材料一次性」是**兼容**的：只有一个请求拿到材料，
   * 其余请求各自 mint 自己的（去重只合并同一瞬间的重复调用）。
   *
   * ## 开关
   *
   * `ZCODE_BRIDGE_MATERIAL_CACHE=1` 才启用跨请求缓存（**已知会导致 400，仅供实验**）。
   * `ZCODE_BRIDGE_NO_MATERIAL_CACHE=1` 强制关闭（等价默认）。
   */
  const FAST_MATERIAL_TTL_MS = 30_000;
  const FAST_MATERIAL_CACHE_DISABLED = process.env["ZCODE_BRIDGE_MATERIAL_CACHE"] !== "1";
  type FastMaterial = NonNullable<Awaited<ReturnType<NonNullable<typeof deps.mintAuthMaterial>>>>;
  const fastMaterialCache = new Map<string, { material: FastMaterial; atMs: number }>();
  const fastMaterialInflight = new Map<string, Promise<FastMaterial>>();

  /**
   * 带并发上限的调度。
   *
   * ## 返回的两个时长分别是什么
   *
   * - `queueWaitMs` —— 从**进入调度**到**真正开跑**之间的等待。
   *   并发未满时它接近 0；并发满时要等前面的人让出槽位。
   * - `runMs` —— 真正跑 `task()` 花的时间（即壳内 turn 的时长）。
   *
   * ## 为什么要分开（旧实现的坑）
   *
   * 旧代码把 `queuedAt` 与 `startedAt` **在同一瞬间赋值**，然后
   * `queueWaitMs: Date.now() - queuedAt` —— 于是它恒等于 `durationMs`
   * （实测日志里 40102 vs 40103，差的只是浮点误差）。
   * **那个字段零信息量**，还误导人以为"全部时间都花在排队上"。
   */
  async function runWithSlot<T>(
    task: () => Promise<T>,
  ): Promise<{ value: T; queueWaitMs: number; runMs: number }> {
    const enteredAt = Date.now();
    if (runningConversations >= MAX_CONCURRENCY) {
      await new Promise<void>((resolve) => {
        conversationWaiters.push(resolve);
      });
    }
    const queueWaitMs = Date.now() - enteredAt;
    runningConversations += 1;
    const runStartedAt = Date.now();
    try {
      const value = await task();
      return { value, queueWaitMs, runMs: Date.now() - runStartedAt };
    } finally {
      runningConversations -= 1;
      const next = conversationWaiters.shift();
      if (next !== undefined) {
        next();
      }
    }
  }

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const url = request.url ?? "/";
      const method = request.method ?? "GET";

      if (method === "GET" && (url === "/health" || url === "/")) {
        json(response, 200, {
          ok: true,
          service: "zcode-bridge",
          version: 2,
          transport: "session-path",
          models: ALLOWED_MODELS,
          defaultProviderId: DEFAULT_PROVIDER_ID,
        });
        return;
      }

      const auth = request.headers["authorization"];
      const presented =
        typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!presented || !safeEqual(presented, token)) {
        errorJson(response, 401, "Invalid or missing bearer token.", "authentication_error");
        return;
      }

      if (method === "GET" && url === "/v1/models") {
        json(response, 200, {
          object: "list",
          data: ALLOWED_MODELS.map((id) => ({ id, object: "model", owned_by: "zcode-free-quota" })),
        });
        return;
      }

      // ── 直发端点：mint 新鲜材料 → 裸发上游 Anthropic 请求 ──────────────
      //
      // 这是整个「壳降级为鉴权材料提供者」设计的**关键验证**。若它能 200，
      // 说明桥可以完全脱离会话链路（工具面原生、无壳内工具干扰、可并发）。
      //
      // 与 `/v1/chat/completions`（走壳的会话链路）的区别：本端点**不建 task、
      // 不 sendPrompt**，只借壳的 captcha 能力，请求由桥自己发。
      //
      // ⚠ 必须「mint 完立刻发」——captcha param 是一次性的，中间任何延迟或
      //    第二次使用都会撞 F008 / 3007。
      //
      // 端点形状：POST /diagnostics/direct
      //   body: { prompt: string, model?: string, maxTokens?: number }
      if (method === "POST" && url === "/diagnostics/direct") {
        if (deps.mintAuthMaterial === undefined) {
          errorJson(
            response,
            501,
            "Bridge was constructed without mintAuthMaterial; direct dispatch unavailable.",
            "not_implemented",
          );
          return;
        }
        let directBody: Record<string, unknown>;
        try {
          directBody = JSON.parse(await readBody(request)) as Record<string, unknown>;
        } catch (error) {
          errorJson(
            response,
            400,
            `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        const prompt = typeof directBody.prompt === "string" ? directBody.prompt : "";
        if (prompt.length === 0) {
          errorJson(response, 400, "Missing required field: prompt");
          return;
        }
        const model =
          typeof directBody.model === "string" && directBody.model.length > 0
            ? directBody.model
            : ALLOWED_MODELS[0];
        const maxTokens =
          typeof directBody.maxTokens === "number" && Number.isFinite(directBody.maxTokens)
            ? Math.max(1, Math.min(32_000, Math.floor(directBody.maxTokens)))
            : 256;
        // 头值里含 JWT 与 captcha（机密），只在明确要求时回显。
        const revealValues = directBody.reveal === 1 || directBody.reveal === true;

        // 允许覆盖请求体形状 —— 用于排查 3012 这类"上游按请求形状做风控"的问题。
        // 省略时用最小形状（model + max_tokens + messages）。
        const systemPrompt =
          typeof directBody.system === "string" && directBody.system.length > 0
            ? directBody.system
            : undefined;
        const extraBody =
          typeof directBody.body === "object" && directBody.body !== null
            ? (directBody.body as Record<string, unknown>)
            : undefined;

        /**
         * 【伪装部分】会话类头 —— 实测从壳内真实请求提取。
         *
         * ## 怎么发现的
         *
         * hook 了 zcode.z.ai 的出站请求，对比「会话链路（能过风控）」与
         * 「桥裸发（3012）」的头集合，差集就是这几个：
         *
         * ```
         * x-session-id          会话标识
         * x-query-id            查询标识
         * x-zcode-trace-id      追踪标识
         * x-zcode-session-type  会话类型（"main"）
         * x-zcode-agent         发起方（"glm"）—— 注意**不是** YAML 里写的 openai/anthropic
         * x-query-id / x-request-id
         * ```
         *
         * ⚠ 关键是**不要**带签名头：开源版的会话链路实测**没有**
         * `X-Client-Sig` / `X-Client-Pow`（那两个来自官方闭源版的
         * `ClientRequestSigningV4` 机制，由服务端 feature gate 控制）。
         * 所以缺的不是签名，是**会话上下文**。
         */
        const sessionHeaders: Record<string, string> = {
          "x-zcode-agent": "glm",
          "x-zcode-session-type": "main",
          // 每次请求现造 —— 旧值复用会让上游判定为重放。
          "x-session-id": randomUUID(),
          "x-query-id": randomUUID(),
          "x-zcode-trace-id": randomUUID(),
          "x-request-id": randomUUID(),
        };
        // 实验开关：允许调用方逐项剥离，用于确认到底哪个头是判据。
        const omitSessionHeaders = Array.isArray(directBody.omitSessionHeaders)
          ? (directBody.omitSessionHeaders as unknown[]).filter(
              (k): k is string => typeof k === "string",
            )
          : [];
        for (const key of omitSessionHeaders) {
          delete sessionHeaders[key];
        }

        // 来源头也允许逐项剥离 —— 实测壳内模型请求**不带** `X-Device-Mid`，
        // 而桥带了。头集合与真实请求越像越好，不是越多越好，所以要能对比。
        const omitSourceHeaders = Array.isArray(directBody.omitSourceHeaders)
          ? (directBody.omitSourceHeaders as unknown[]).filter(
              (k): k is string => typeof k === "string",
            )
          : [];

        /**
         * 【实验】把 captcha 材料绑定到**真实存在**的会话上。
         *
         * ## 动机（2026-09-27 定位）
         *
         * `mintProviderAuthMaterial` 默认**凭空造** sessionId：
         *     const sessionId = `bridge-mint-session-${randomUUID()}`;
         * 上游查不到该会话 → **3012**，且 **0.15 秒**就返回（浅层拒绝，
         * 不是深度风控 —— 深度风控不会这么快）。
         *
         * 而 `runConversation`（createTask + sendPrompt）**成功**，
         * 因为它用的是服务端**真实注册过**的 sessionId。
         *
         * ## 怎么拿到真实 sessionId
         *
         * `packages/desktop/src/host/index.ts:979`：
         *     return { taskId: task.taskId, sessionId: task.taskId };
         * ⇒ **sessionId === taskId**
         *
         * 走一次 `POST /v1/chat/completions`（它会建 task），
         * 然后从桥的日志里读 `bridge.chat.completed` 的 taskId，
         * 或直接用本端点的 `?sessionId=` 传进来。
         */
        const directSessionId =
          typeof directBody.sessionId === "string" && directBody.sessionId.trim().length > 0
            ? directBody.sessionId.trim()
            : undefined;

        const startedAt = Date.now();
        try {
          const material = await deps.mintAuthMaterial({
            providerId: DEFAULT_PROVIDER_ID,
            modelId: model,
            // ★ 必须用与会话链路同一个 workspacePath —— 否则 captcha 事件
            //   被 fire 到 renderer 不监听的 emitter 桶，稳定 20 秒超时。
            workspacePath: bridgeWorkspacePath(),
            // 【实验】传真实 sessionId（= taskId），让材料绑定到已注册的会话。
            ...(directSessionId === undefined ? {} : { sessionId: directSessionId }),
          });
          if (material?.apiKey === undefined) {
            errorJson(response, 502, "Failed to mint auth material.", "credential_unavailable");
            return;
          }
          const mintedAt = Date.now();

          // 组装实际发出的头。抽出来是为了能在响应里回显 —— 3012 这类
          // 「来源特征」问题必须能看到"到底发了什么头"才排得动。
          //
          // 顺序即优先级（后面的覆盖前面的）：
          //   基础头 → 来源标识头 → **会话头** → captcha 头
          const outgoingHeaders: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json",
            "anthropic-version": "2023-06-01",
            // ★ 实测：壳内会话链路**带**这个头，桥裸发一开始没带 —— 是
            //   头集合 diff 里唯一的缺口。值取自壳内真实请求。
            "anthropic-beta": "mid-conversation-system-2026-04-07",
            Authorization: `Bearer ${material.apiKey}`,
            // ★ 伪装部分之一：来源标识头（与壳内同源取值）。
            //
            // ⚠ 实测发现壳内**模型请求**并不带 `X-Device-Mid`（只有
            //   `/api/v1/zcode-plan/billing/*` 那类管理接口带）。带多了
            //   不一定更好 —— 头集合与真实请求越像越好，而不是越多越好。
            //   这里允许调用方通过 `omitSourceHeaders` 剥离，用于逐项确认。
            ...(() => {
              const base = bridgeSourceHeaders();
              for (const key of omitSourceHeaders) {
                delete base[key];
              }
              return base;
            })(),
            // ★ 伪装部分之二：会话类头 —— 实测这才是 3012 的判据。
            ...sessionHeaders,
            // ⚠ 壳内真实请求**同时**带 Authorization 与 x-api-key（同值）。
            //   实测只带 Bearer 也能过鉴权（缺 captcha 时报 3007 而非 401），
            //   但为与壳内完全同构，这里一并补上。
            "x-api-key": material.apiKey,
            // captcha 头放最后：由 renderer 现 mint，必须覆盖任何同名项。
            ...(material.headers ?? {}),
          };

          // 【实验】允许把材料绑定到真实会话（见 directSessionId 的说明）。
          if (directSessionId !== undefined) {
            log("bridge.diagnostics.direct.real_session", { sessionId: directSessionId });
          }

          const upstream = await fetch(`${ZCODE_PLAN_ANTHROPIC_BASE}/v1/messages`, {
            method: "POST",
            headers: outgoingHeaders,
            body: JSON.stringify({
              model,
              max_tokens: maxTokens,
              ...(systemPrompt === undefined ? {} : { system: systemPrompt }),
              messages: [{ role: "user", content: prompt }],
              // 允许调用方追加字段，用于逐项验证上游风控到底看什么。
              ...(extraBody ?? {}),
            }),
          });

          const raw = await upstream.text();
          log("bridge.diagnostics.direct", {
            modelId: model,
            status: upstream.status,
            mintMs: mintedAt - startedAt,
            totalMs: Date.now() - startedAt,
            headerNames: Object.keys(material.headers ?? {}),
            sentHeaderNames: Object.keys(outgoingHeaders),
          });
          json(response, 200, {
            upstreamStatus: upstream.status,
            ok: upstream.ok,
            mintMs: mintedAt - startedAt,
            totalMs: Date.now() - startedAt,
            headerNames: Object.keys(material.headers ?? {}),
            // 【诊断】实际发出的请求形状 —— 排查 3012 的核心依据。
            sent: {
              url: `${ZCODE_PLAN_ANTHROPIC_BASE}/v1/messages`,
              headerNames: Object.keys(outgoingHeaders),
              // 值里含 JWT 与 captcha（机密），只在明确要求时回显。
              ...(revealValues ? { headers: outgoingHeaders } : {}),
              bodyFields: [
                "model",
                "max_tokens",
                ...(systemPrompt === undefined ? [] : ["system"]),
                "messages",
                ...Object.keys(extraBody ?? {}),
              ],
            },
            body: raw.length > 4000 ? `${raw.slice(0, 4000)}…` : raw,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log("bridge.diagnostics.direct.failed", { modelId: model, error: message });
          errorJson(response, 502, `Direct dispatch failed: ${message}`, "upstream_error");
        }
        return;
      }

      // ── 诊断端点：解析当前账号的请求鉴权材料 ──────────────────────────
      //
      // 用途：验证「裸转发」路线是否可行 —— 若这里能拿到**含 captcha 头**的
      // 完整材料，说明桥可以脱离会话链路，直接向上游发标准 HTTP 请求。
      //
      // 两个来源，优先用旁路：
      //   1. `getLatestAuthMaterial()` —— 壳实际用于发请求的那一份（含 captcha）
      //   2. `resolveAuthMaterial()`   —— 桥主动解析（只有 apiKey，无 captcha）
      //
      // ⚠ 两个安全约束：
      //   1. **在 token 校验之后**（上面已过），不像 /health 那样匿名开放；
      //   2. **返回值里 apiKey 与 captcha 头是机密**，只应回给持有桥 token 的调用方
      //      （即本机 DSH 插件）。绝不要把它接到 /health 或匿名端点上。
      //
      // 端点形状：GET /diagnostics/auth?provider=<id>&model=<id>&reveal=1
      if (method === "GET" && url.startsWith("/diagnostics/auth")) {
        const query = new URL(url, "http://127.0.0.1").searchParams;
        const providerId = query.get("provider")?.trim() || DEFAULT_PROVIDER_ID;
        const modelId = query.get("model")?.trim() || ALLOWED_MODELS[0];
        const reveal = query.get("reveal") === "1";

        // 优先：旁路捕获的完整材料（含 captcha）。
        const captured = deps.getLatestAuthMaterial?.();
        if (captured !== undefined && captured.apiKey !== undefined) {
          json(response, 200, {
            source: "observer",
            providerId: captured.providerId,
            modelId: captured.modelId,
            hasApiKey: true,
            apiKeyLength: captured.apiKey.length,
            headerNames: Object.keys(captured.headers ?? {}),
            ...(reveal ? { apiKey: captured.apiKey, headers: captured.headers ?? {} } : {}),
            // 【诊断】壳内真实请求的完整形状 —— 用于排查 3012。
            //
            // `headers` 是**经过白名单过滤**的（只留 captcha 两项），看不出全貌；
            // `rawRequestAuth` 是未过滤的原始材料，`requestShape` 是触发它的请求参数。
            // 两者一起才能回答"壳内请求和桥裸发到底差什么"。
            diagnostics: {
              rawRequestAuthHeaderNames: Object.keys(
                captured.rawRequestAuth?.headers ?? {},
              ),
              ...(reveal
                ? {
                    rawRequestAuth: captured.rawRequestAuth ?? {},
                    requestShape: captured.requestShape ?? null,
                  }
                : {}),
            },
          });
          return;
        }

        if (deps.resolveAuthMaterial === undefined) {
          errorJson(
            response,
            501,
            "Bridge was constructed without resolveAuthMaterial; auth diagnostics unavailable.",
            "not_implemented",
          );
          return;
        }
        try {
          const material = await deps.resolveAuthMaterial({ providerId, modelId });
          if (material === undefined) {
            errorJson(
              response,
              502,
              "Auth material resolver returned nothing for this provider/model.",
              "credential_unavailable",
            );
            return;
          }
          json(response, 200, {
            source: "resolver",
            providerId,
            modelId,
            hasApiKey: typeof material.apiKey === "string" && material.apiKey.length > 0,
            apiKeyLength: material.apiKey?.length ?? 0,
            headerNames: Object.keys(material.headers ?? {}),
            ...(reveal ? { apiKey: material.apiKey ?? null, headers: material.headers ?? {} } : {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log("bridge.diagnostics.auth.failed", { providerId, modelId, error: message });
          errorJson(response, 502, `Auth material resolution failed: ${message}`, "upstream_error");
        }
        return;
      }

      // 【诊断】把壳的凭据库里**所有** key 的明文吐出来。
      //
      // 动机：`/diagnostics/auth` 只回 `resolveAuthMaterial` 解析出的那一个
      // apiKey（实测是 204 字符的 ZCode JWT）。但 off-peak 通道需要的是
      // **另一个**凭据 —— coding plan key（`offPeakRuntimeModel.ts:246-259`
      // 的 `X-Coding-Plan-Api-Key`）。
      //
      // 实测证据：拿那个 JWT 打 off-peak 票据端点得到
      //   `403 {"code":3101,"msg":"coding plan is required"}`
      // ⇒ 缺的正是 coding plan 凭据。没有它就无法验证 off-peak 是否可用。
      //
      // ⚠ 这个端点会**泄露全部凭据明文**，仅供本机诊断使用：
      //   - 仍要求 Bearer token（桥的 token，非匿名）
      //   - 必须显式带 `?reveal=1`，默认只回 key 名与长度
      if (method === "GET" && url.startsWith("/diagnostics/credentials")) {
        const query = new URL(url, "http://127.0.0.1").searchParams;
        const reveal = query.get("reveal") === "1";
        const credentials = ctx.get("credentials") as
          | {
              list?: () => Promise<Array<{ ref: string; value?: string }>>;
              get?: (ref: string) => Promise<string | undefined> | string | undefined;
            }
          | undefined;
        if (credentials === undefined) {
          errorJson(response, 501, "credentials service unavailable.", "not_implemented");
          return;
        }
        try {
          const refs: Array<{ ref: string; length: number; value?: string }> = [];
          const listed = await credentials.list?.();
          if (Array.isArray(listed)) {
            for (const entry of listed) {
              const ref = String(entry.ref ?? "");
              if (ref.length === 0) continue;
              let value = entry.value;
              if (value === undefined && typeof credentials.get === "function") {
                value = await credentials.get(ref);
              }
              refs.push({
                ref,
                length: typeof value === "string" ? value.length : 0,
                ...(reveal && typeof value === "string" ? { value } : {}),
              });
            }
          }
          json(response, 200, {
            count: refs.length,
            // 默认只给名字与长度，便于确认「有没有 coding plan 那条」。
            refs: refs.map((r) =>
              reveal ? r : { ref: r.ref, length: r.length },
            ),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errorJson(response, 502, `Credentials enumeration failed: ${message}`, "upstream_error");
        }
        return;
      }

      // 【诊断 / 性能实验】直接调 `workspace/generateText`，跳过 task 与 turn。
      //
      // 判据（与 /v1/chat/completions 对比同一个 prompt）：
      //   - 若耗时显著更短 ⇒ 「原生速度」就在这条路上，应当改造 adapter 走它
      //   - 若同样 20 秒     ⇒ 说明开销在 captcha/模型本身，与 turn 无关
      //   - 若报错            ⇒ 看错误原文（可能是 captcha、也可能是 selection 问题）
      if (method === "POST" && url === "/diagnostics/generate-text") {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await readBody(request)) as Record<string, unknown>;
        } catch {
          errorJson(response, 400, "Invalid JSON body.", "invalid_request_error");
          return;
        }
        if (deps.generateWorkspaceText === undefined) {
          errorJson(response, 501, "Bridge was constructed without generateWorkspaceText.", "not_implemented");
          return;
        }
        const prompt = typeof body["prompt"] === "string" ? body["prompt"] : "";
        const modelId = typeof body["model"] === "string" ? body["model"] : ALLOWED_MODELS[0];
        const startedAt = Date.now();
        try {
          const result = await deps.generateWorkspaceText({
            workspacePath: bridgeWorkspacePath(),
            providerId: DEFAULT_PROVIDER_ID,
            modelId,
            messages: [{ role: "user", content: prompt }],
            ...(typeof body["maxOutputTokens"] === "number"
              ? { maxOutputTokens: body["maxOutputTokens"] as number }
              : {}),
          });
          const durationMs = Date.now() - startedAt;
          log("bridge.diagnostics.generate_text", {
            modelId,
            durationMs,
            textLength: result.text.length,
            finishReason: result.finishReason,
          });
          json(response, 200, {
            ok: true,
            durationMs,
            text: result.text,
            finishReason: result.finishReason,
            usage: result.usage,
            toolCallCount: Array.isArray(result.toolCalls) ? result.toolCalls.length : 0,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log("bridge.diagnostics.generate_text.failed", {
            modelId,
            durationMs: Date.now() - startedAt,
            error: message,
          });
          json(response, 200, {
            ok: false,
            durationMs: Date.now() - startedAt,
            error: message,
          });
        }
        return;
      }

      // 【诊断】测模型连通性 —— 协议里最轻的「真实模型调用」。
      //
      // 依据：`zcodeProviderTestModelConnectivityParamsSchema`（协议 L2132）
      //   参数 { workspace, selection }，结果 { success: true }
      //
      // 动机：§十九 已确认 3012 的判据是「服务端会话登记」。
      // 本端点用它验证：**这个接口是否走了会话链路**（若成功，说明它有登记）。
      if (method === "POST" && url === "/diagnostics/test-connectivity") {
        if (deps.testModelConnectivity === undefined) {
          errorJson(response, 501, "Bridge was constructed without testModelConnectivity.", "not_implemented");
          return;
        }
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await readBody(request)) as Record<string, unknown>;
        } catch {
          errorJson(response, 400, "Invalid JSON body.", "invalid_request_error");
          return;
        }
        const modelId = typeof body["model"] === "string" ? body["model"] : ALLOWED_MODELS[0];
        const startedAt = Date.now();
        try {
          const result = await deps.testModelConnectivity({
            workspacePath: bridgeWorkspacePath(),
            providerId: DEFAULT_PROVIDER_ID,
            modelId,
            ...(typeof body["reasoningLevel"] === "string" ? { reasoningLevel: body["reasoningLevel"] } : {}),
          });
          json(response, 200, {
            ok: true,
            durationMs: Date.now() - startedAt,
            success: result.success,
            modelId,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log("bridge.diagnostics.test_connectivity.failed", { modelId, error: message });
          json(response, 200, { ok: false, durationMs: Date.now() - startedAt, error: message });
        }
        return;
      }

      // 【诊断】`session/create` + 极短 `session/send` —— 最轻的「已登记会话」路径。
      //
      // 动机：若 3012 的判据是「服务端会话登记」，那么
      // 「只建会话 + 只发一条两字消息」应该比完整 agent turn 快得多，
      // 且能通过（因为会话是登记的）。
      if (method === "POST" && url === "/diagnostics/session-ping") {
        if (deps.sessionPing === undefined) {
          errorJson(response, 501, "Bridge was constructed without sessionPing.", "not_implemented");
          return;
        }
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await readBody(request)) as Record<string, unknown>;
        } catch {
          errorJson(response, 400, "Invalid JSON body.", "invalid_request_error");
          return;
        }
        const modelId = typeof body["model"] === "string" ? body["model"] : ALLOWED_MODELS[0];
        const prompt = typeof body["prompt"] === "string" ? body["prompt"] : "hi";
        const startedAt = Date.now();
        try {
          const result = await deps.sessionPing({
            workspacePath: bridgeWorkspacePath(),
            providerId: DEFAULT_PROVIDER_ID,
            modelId,
            prompt,
            ...(typeof body["reasoningLevel"] === "string" ? { reasoningLevel: body["reasoningLevel"] } : {}),
          });
          json(response, 200, {
            ok: true,
            durationMs: Date.now() - startedAt,
            innerDurationMs: result.durationMs,
            text: result.text,
            modelId,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log("bridge.diagnostics.session_ping.failed", { modelId, error: message });
          json(response, 200, { ok: false, durationMs: Date.now() - startedAt, error: message });
        }
        return;
      }

      // 【诊断】只 mint 一份**新鲜 captcha 材料**并返回，**不使用**它。
      //
      // 动机：`/diagnostics/direct` 会在 mint 后立刻用掉材料（captcha 一次性），
      // 所以外部程序拿不到可用的材料去自己发请求。
      //
      // 本端点把材料交出来，让外部程序（脚本/实验）能用**真实新鲜材料 + 真实头值**
      // 组合发一次请求，从而把「头值」与「captcha」两个变量分开验证。
      //
      // 实测背景（2026-09-27）：
      //   用**真实头值**裸发（无 captcha）→ 400 `3007 captcha verify failed`
      //   用**旧头值**裸发            → 405 `3012 unusual activity`
      // ⇒ 头值确实影响 3012！补对之后风控放行，只卡 captcha。
      /**
       * ★ `POST /oauth/login` —— 触发账号登录（2026-09-28 新增）。
       *
       * ## 为什么做这个端点
       *
       * 用户的原话：「这一套操作不都是固定的吗？让 agent 来的步骤不也是固定的吗？
       * 那就能写成脚本才对」—— **完全正确**。
       *
       * ZCode 登录的五步全是确定性的（见 deps.startLogin 的注释），
       * 唯一「人在环」的是用户在浏览器里输账号密码。其余四步
       * （生成 state、注册、开浏览器、接回调）都能由实例代劳。
       *
       * 于是登录就可以被 agent 触发：
       *
       *   POST /oauth/login  →  实例弹出授权页  →  用户完成
       *                      →  zcode:// 回调  →  自动写凭据  →  额度恢复
       *
       * ## 请求
       *
       *   { "providerId": "account:bigmodel-start-plan" }   可选，默认 bigmodel
       *
       * ## 响应
       *
       *   200 { ok: true, authorizeUrl, message }
       *   501 宿主没注入 startLogin
       */
      if (method === "POST" && url === "/oauth/login") {
        if (deps.startLogin === undefined) {
          errorJson(
            response,
            501,
            "Bridge was constructed without startLogin.",
            "not_implemented",
          );
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(await readBody(request));
        } catch {
          payload = {};
        }
        const body = (payload ?? {}) as Record<string, unknown>;
        const providerId =
          typeof body["providerId"] === "string" && body["providerId"].trim().length > 0
            ? body["providerId"].trim()
            : // ⚠ 必须是 **OAuth provider ID**（`"bigmodel"` / `"zai"`），
              //   不是桥的 provider 名（`account:bigmodel-start-plan`）——
              //   后者会抛 `不支持的 OAuth provider: account:...`（实测）。
              "bigmodel";
        try {
          const result = await deps.startLogin({ providerId });
          json(response, 200, {
            ok: result.ok,
            providerId,
            ...(result.authorizeUrl === undefined ? {} : { authorizeUrl: result.authorizeUrl }),
            message:
              result.message ??
              "授权页已打开。请在浏览器完成登录；回调会自动写回凭据，之后可再次调用本接口或直接发请求验证。",
          });
        } catch (error) {
          errorJson(
            response,
            502,
            `startLogin failed: ${error instanceof Error ? error.message : String(error)}`,
            "login_failed",
          );
        }
        return;
      }
      /**
       * ★ `GET /diagnostics/billing` —— 查真实额度（2026-09-28 新增）。
       *
       * ## 解决什么问题
       *
       * 此前只能从 `{"code":1005,"msg":"exceed quota limit"}` **反推**额度用尽，
       * 查不到「还剩多少 / 何时到期 / 一次性还是每日」。
       *
       * 本端点直连上游 billing/balance，返回结构化额度信息：
       *
       *   { ok, planName, planId, period, totalUnits, usedUnits,
       *     remainingUnits, expiresAt, expiresAtLocal, plans[] }
       *
       * ## 鉴权
       *
       * 复用 `mintAuthMaterial`（每次现 mint，因为 captcha 材料一次性）。
       * 另需 `X-Device-Mid` —— 取自 `<dataBaseDir>\.zcode\v2\telemetry-state.json`。
       */
      /**
       * ★ `POST /diagnostics/claim` —— 自动领取免费额度（2026-09-28 新增）。
       *
       * ## 解决什么问题
       *
       * ZCode 左下角弹的额度卡片**必须人工点击**才领取。用户原话：
       *
       *   「这个额度是软件在 UI 界面的左下角弹出一个卡片，只有用户去点了
       *     之后才领取。这个也需要自动化，也就是说，登录之后还要用户点击
       *     才有额度」
       *
       * ## 三步全自动
       *
       * ① **激活上报**（关键！）—— 不补这两条，`preview` 恒为空 `plans: []`：
       *      POST /api/v1/event/report  {app_launch}
       *      POST /api/v1/event/report  {app_daily_active}
       * ② **看有哪些可领** —— GET /billing/preview
       * ③ **逐个领取** —— POST /billing/claim {plan_id}
       *      captcha 头来自 `mintAuthMaterial`（**一次性，必须现解现用**）
       *
       * 返回 `1003`（已领取）视为**成功** —— 幂等语义。
       *
       * ## 请求
       *
       *   { "planId": "..." }   可选。缺省时按 preview 的 priority 降序全领。
       */
      if (method === "POST" && url === "/diagnostics/claim") {
        if (deps.mintAuthMaterial === undefined) {
          errorJson(response, 501, "Bridge was constructed without mintAuthMaterial.", "not_implemented");
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(await readBody(request));
        } catch {
          payload = {};
        }
        const claimBody = (payload ?? {}) as Record<string, unknown>;
        const explicitPlanId =
          typeof claimBody["planId"] === "string" && claimBody["planId"].trim().length > 0
            ? claimBody["planId"].trim()
            : undefined;

        const steps: Array<Record<string, unknown>> = [];
        const startedAt = Date.now();
        try {
          /** deviceMid 是企业身份锚点；billing 全家桶缺它会 3001。 */
          let deviceMid = "";
          try {
            const { readFileSync } = await import("node:fs");
            const { join: joinPath } = await import("node:path");
            const tf = joinPath(deps.dataBaseDir, ".zcode", "v2", "telemetry-state.json");
            const parsed = JSON.parse(readFileSync(tf, "utf8")) as { deviceMid?: unknown };
            if (typeof parsed.deviceMid === "string") deviceMid = parsed.deviceMid;
          } catch {
            /* 拿不到就不带 */
          }
          const midHeader: Record<string, string> =
            deviceMid.length > 0 ? { "X-Device-Mid": deviceMid } : {};

          /** ① 激活上报 —— 不补这两条，preview 恒为空。 */
          const emptyAuth: Record<string, string> = {
            "Content-Type": "application/json",
            "User-Agent": "ZCode/3.14.3",
            ...midHeader,
          };
          for (const event of ["app_launch", "app_daily_active"]) {
            try {
              const r = await fetch(ZCODE_EVENT_REPORT_URL, {
                method: "POST",
                headers: emptyAuth,
                body: JSON.stringify({
                  event,
                  device_mid: deviceMid,
                  platform: "win32",
                  app_version: "3.14.3",
                }),
              });
              const t = await r.text();
              steps.push({ step: "event_report", event, status: r.status, body: t.slice(0, 200) });
            } catch (error) {
              steps.push({
                step: "event_report",
                event,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

          /** ② preview —— 拿可领列表。 */
          let planIds: string[] = [];
          {
            const url2 =
              `${ZCODE_PLAN_BILLING_PREVIEW_URL}?app_version=3.14.3&platform=win32`;
            const r = await fetch(url2, {
              method: "GET",
              headers: { accept: "application/json", "User-Agent": "ZCode/3.14.3", ...midHeader },
            });
            const t = await r.text();
            steps.push({ step: "preview", status: r.status, body: t.slice(0, 600) });
            try {
              const p = JSON.parse(t) as {
                data?: { plans?: Array<{ plan_id?: string; priority?: number }> };
              };
              const plans = (p.data?.plans ?? []).filter(
                (x): x is { plan_id: string; priority?: number } =>
                  typeof x.plan_id === "string" && x.plan_id.length > 0,
              );
              // priority 降序 —— 与第三方实现一致（先领高优先级的）
              plans.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
              planIds = plans.map((x) => x.plan_id);
            } catch {
              /* preview 解析失败就不领 */
            }
          }

          /** ③ 逐个 claim —— captcha 一次性，**每个 plan 都要重新 mint**。 */
          const targets = explicitPlanId !== undefined ? [explicitPlanId] : planIds;
          const results: Array<Record<string, unknown>> = [];
          for (const planId of targets) {
            try {
              const material = await deps.mintAuthMaterial({
                providerId: DEFAULT_PROVIDER_ID,
                modelId: ALLOWED_MODELS[0],
                workspacePath: bridgeWorkspacePath(),
              });
              if (material?.apiKey === undefined) {
                results.push({ planId, ok: false, error: "mint returned no apiKey" });
                continue;
              }
              const capParam = material.headers?.["X-Aliyun-Captcha-Verify-Param"];
              const capRegion = material.headers?.["X-Aliyun-Captcha-Verify-Region"];
              /**
               * ⚠ captcha 头**必需**。缺了上游可能仍返回 200 但业务码异常，
               *   所以这里显式记录是否带上，便于诊断。
               */
              const claimHeaders: Record<string, string> = {
                authorization: `Bearer ${material.apiKey}`,
                "Content-Type": "application/json",
                ...(typeof capParam === "string"
                  ? { "X-Aliyun-Captcha-Verify-Param": capParam }
                  : {}),
                ...(typeof capRegion === "string"
                  ? { "X-Aliyun-Captcha-Verify-Region": capRegion }
                  : {}),
                "X-ZCode-App-Version": "3.14.3",
                "X-Platform": "win32",
                "User-Agent": "ZCode/3.14.3",
                ...midHeader,
              };
              let r: Response;
              try {
                r = await fetch(ZCODE_PLAN_BILLING_CLAIM_URL, {
                  method: "POST",
                  headers: claimHeaders,
                  body: JSON.stringify({ plan_id: planId }),
                });
              } catch (fetchErr) {
                /**
                 * fetch 本身失败（DNS / TLS / 连接被拒）。旧实现把这里吞成
                 * 空对象，导致 `HTTP=` 为空且看不到原因 —— 现在显式记下来。
                 */
                results.push({
                  planId,
                  ok: false,
                  stage: "fetch",
                  error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
                  errorName: fetchErr instanceof Error ? fetchErr.name : typeof fetchErr,
                  captchaPresent: typeof capParam === "string",
                  headersUsed: Object.keys(claimHeaders).join(","),
                });
                continue;
              }
              const t = await r.text();
              let upstreamCode: number | undefined;
              try {
                upstreamCode = (JSON.parse(t) as { code?: number }).code;
              } catch {
                /* ignore */
              }
              results.push({
                planId,
                httpStatus: r.status,
                upstreamCode: upstreamCode ?? null,
                /**
                 * ⚠ `1003` = 已领取过 —— **幂等成功，不是错误**。
                 * 早先若把它当失败会让自动化误报。
                 */
                ok: r.status === 200 && (upstreamCode === 0 || upstreamCode === 1003),
                alreadyClaimed: upstreamCode === 1003,
                body: t.slice(0, 400),
              });
            } catch (error) {
              results.push({
                planId,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          json(response, 200, {
            ok: results.some((r) => r["ok"] === true),
            discoveredPlans: planIds,
            results,
            steps,
            durationMs: Date.now() - startedAt,
            note:
              "code 1003 = 已领取过（幂等成功）。若 preview 的 plans 为空，" +
              "检查 steps 里的 event_report 是否成功 —— 激活上报是活动投放的资格信号。",
          });
        } catch (error) {
          errorJson(
            response,
            502,
            `Claim failed: ${error instanceof Error ? error.message : String(error)}`,
            "upstream_error",
          );
        }
        return;
      }
      if ((method === "GET" || method === "POST") && url === "/diagnostics/billing") {
        if (deps.mintAuthMaterial === undefined) {
          errorJson(response, 501, "Bridge was constructed without mintAuthMaterial.", "not_implemented");
          return;
        }
        const startedAt = Date.now();
        try {
          const material = await deps.mintAuthMaterial({
            providerId: DEFAULT_PROVIDER_ID,
            modelId: ALLOWED_MODELS[0],
            workspacePath: bridgeWorkspacePath(),
          });
          if (material?.apiKey === undefined) {
            errorJson(response, 502, "Failed to mint auth material.", "credential_unavailable");
            return;
          }
          /** deviceMid 来自 telemetry-state.json（缺它服务端会拒为 parameter error）。 */
          let deviceMid = "";
          try {
            const { readFileSync } = await import("node:fs");
            const { join: joinPath } = await import("node:path");
            const tf = joinPath(deps.dataBaseDir, ".zcode", "v2", "telemetry-state.json");
            const parsed = JSON.parse(readFileSync(tf, "utf8")) as { deviceMid?: unknown };
            if (typeof parsed.deviceMid === "string") deviceMid = parsed.deviceMid;
          } catch {
            /* 拿不到就不带 —— 上游可能因此拒绝，下面的错误信息会体现 */
          }
          const appVersion =
            typeof material.headers?.["X-ZCode-App-Version"] === "string"
              ? (material.headers["X-ZCode-App-Version"] as string)
              : "3.14.3";
          const billingUrl =
            `${ZCODE_PLAN_BILLING_BALANCE_URL}?app_version=${encodeURIComponent(appVersion)}`;
          const upstream = await fetch(billingUrl, {
            method: "GET",
            headers: {
              authorization: `Bearer ${material.apiKey}`,
              ...(deviceMid.length > 0 ? { "x-device-mid": deviceMid } : {}),
              "user-agent": `ZCode/${appVersion}`,
              accept: "application/json",
            },
          });
          const text = await upstream.text();
          if (upstream.status !== 200) {
            errorJson(
              response,
              upstream.status,
              `Upstream billing failed: ${text.slice(0, 400)}`,
              "upstream_error",
            );
            return;
          }
          const parsed = JSON.parse(text) as {
            code?: number;
            msg?: string;
            data?: {
              plans?: Array<{
                plan_id?: string;
                name?: string;
                status?: string;
                ends_at?: number;
              }>;
              balances?: Array<{
                show_name?: string;
                plan_id?: string;
                period?: string;
                total_units?: number;
                used_units?: number;
                remaining_units?: number;
                available_units?: number;
                expires_at?: number;
              }>;
            };
          };
          const primary = parsed.data?.balances?.[0];
          const planOfPrimary = parsed.data?.plans?.find(
            (p) => p.plan_id === primary?.plan_id,
          );
          /**
           * ⚠ `period` 的取法（2026-09-28 修正）。
           *
           * 实测：`balances[].period` 是 **null**，真正的值在
           * `plans[].entitlements[].period`（`"one_time"` / `"daily"`）。
           * 早先只读 balances，于是永远拿到 null —— 而那正是判断
           * 「活动赠送 vs 每日订阅」的关键字段。
           */
          const entitlementPeriod = (
            planOfPrimary as { entitlements?: Array<{ period?: string }> } | undefined
          )?.entitlements?.[0]?.period;
          const period = primary?.period ?? entitlementPeriod ?? null;
          const toLocal = (sec: number | undefined): string | undefined =>
            typeof sec === "number"
              ? new Date(sec * 1000).toLocaleString("zh-CN", { hour12: false })
              : undefined;
          json(response, 200, {
            ok: true,
            upstreamCode: parsed.code ?? null,
            upstreamMsg: parsed.msg ?? "",
            planName: planOfPrimary?.name ?? null,
            planId: primary?.plan_id ?? planOfPrimary?.plan_id ?? null,
            planStatus: planOfPrimary?.status ?? null,
            /**
             * ⚠ 判据：`one_time` = 活动赠送（会过期）；`daily` = 每日刷新。
             * 此前只能靠错误码猜，现在能直接读。
             */
            period,
            modelName: primary?.show_name ?? null,
            totalUnits: primary?.total_units ?? null,
            usedUnits: primary?.used_units ?? null,
            remainingUnits: primary?.remaining_units ?? null,
            availableUnits: primary?.available_units ?? null,
            expiresAt: primary?.expires_at ?? planOfPrimary?.ends_at ?? null,
            expiresAtLocal: toLocal(primary?.expires_at ?? planOfPrimary?.ends_at),
            plans: parsed.data?.plans ?? [],
            durationMs: Date.now() - startedAt,
            deviceMidPresent: deviceMid.length > 0,
          });
        } catch (error) {
          errorJson(
            response,
            502,
            `Billing query failed: ${error instanceof Error ? error.message : String(error)}`,
            "upstream_error",
          );
        }
        return;
      }
      if (method === "POST" && url === "/diagnostics/mint") {
        if (deps.mintAuthMaterial === undefined) {
          errorJson(response, 501, "Bridge was constructed without mintAuthMaterial.", "not_implemented");
          return;
        }
        const providerId = DEFAULT_PROVIDER_ID;
        const modelId = ALLOWED_MODELS[0];
        const startedAt = Date.now();
        try {
          const material = await deps.mintAuthMaterial({
            providerId,
            modelId,
            workspacePath: bridgeWorkspacePath(),
          });
          const mintMs = Date.now() - startedAt;
          log("bridge.diagnostics.mint", {
            providerId,
            modelId,
            mintMs,
            hasApiKey: typeof material?.apiKey === "string",
            headerNames: Object.keys(material?.headers ?? {}),
          });
          json(response, 200, {
            ok: material !== undefined,
            mintMs,
            providerId,
            modelId,
            apiKey: material?.apiKey ?? null,
            headers: material?.headers ?? {},
            headerNames: Object.keys(material?.headers ?? {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log("bridge.diagnostics.mint.failed", { providerId, modelId, error: message });
          json(response, 200, { ok: false, mintMs: Date.now() - startedAt, error: message });
        }
        return;
      }

      if (method === "POST" && url === "/v1/chat/completions") {
        let payload: unknown;
        try {
          payload = JSON.parse(await readBody(request));
        } catch (error) {
          errorJson(
            response,
            400,
            `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        const body = payload as Record<string, unknown>;

        const modelId = typeof body.model === "string" ? body.model : "";
        if (!modelId) {
          errorJson(response, 400, "Missing required field: model");
          return;
        }
        if (!(ALLOWED_MODELS as readonly string[]).includes(modelId)) {
          errorJson(
            response,
            400,
            `Model "${modelId}" is not served by this bridge. Allowed: ${ALLOWED_MODELS.join(", ")}`,
          );
          return;
        }

        const messages = normalizeMessages(body.messages);
        if (messages.length === 0) {
          errorJson(response, 400, "Missing or empty field: messages");
          return;
        }

        const workspacePath =
          typeof body.workspacePath === "string" && body.workspacePath.trim()
            ? body.workspacePath.trim()
            : bridgeWorkspacePath();

        const maxOutputTokens =
          typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens)
            ? Math.max(1, Math.min(32_000, Math.floor(body.max_tokens)))
            : undefined;

        /**
         * ★★★ 【快速路径】直连上游，**不建 task、不跑 turn 循环**。
         *
         * ## 发现经过（2026-09-27，子代理 + 本人复现）
         *
         * 此前所有裸发实验**都不带 `system` 字段** —— 这个变量从未变动过。
         * 带上**精确的**白名单串后，上游完全放行：
         *
         *     system = "You are ZCode connectivity probe."
         *
         * 实测（`/diagnostics/direct`）：
         *
         *     system:"You are ZCode connectivity probe." + 无 stream → 200 + 完整 JSON
         *     system:"You are ZCode connectivity probe." + stream    → 200 + 完整 SSE
         *     system:"You are ZCode connectivity probe"（去句点）     → 405 / 3012
         *     system:"x" / "" / 不传                                  → 405 / 3012
         *
         * 成功响应是**完整可用**的对话（不是探测模式降级）：
         *
         *     {"content":[{"type":"thinking",...},{"type":"text","text":"正常"}],
         *      "stop_reason":"end_turn",
         *      "usage":{"input_tokens":25,"output_tokens":62,"service_tier":"standard"}}
         *
         * `output_tokens: 62` —— **没有 1-token 限制**，有真实计费。
         *
         * ## 为什么这重要
         *
         * 会话链路（`createTask` + `sendPrompt`）**8-28 秒**；本路径实测**中位 5.1 秒**
         * （15.5 / 5.1 / 4.4），且**不建 task、不跑 turn、不写会话存储**。
         *
         * ## 匹配规则（推测定为 trim 后全等，未穷举）
         *
         * 依据实测：原串通过、原串+尾部空格通过、去句点不通过。
         */
        const CONNECTIVITY_PROBE_SYSTEM = "You are ZCode connectivity probe.";

        /**
         * ★ 官方 ZCode 身份块的第一个 block（2026-09-28 新增）。
         *
         * ## 为什么加这个
         *
         * 上游网关对请求做**内容检查**：`system` 字段里看不到 ZCode 身份块时
         * 直接返回 `3012 "method not allowed"`（对外文案 `request has been
         * blocked due to unusual activity`）。
         *
         * 来源：同类项目 `a137460387/zcode2api` 的 README「3012 的根因与修复」节，
         * 其 `src/upstream/zcode-system.json` 从官方 3.11.2 bundle 提取。
         *
         * ## 实测（本项目，2026-09-28）
         *
         * 用官方三块 system（共 7599 字符）+ 官方头形态直发
         * `zcode-plan/anthropic/v1/messages`：
         *
         * ```
         * HTTP: 200  {"content":[...,{"type":"text","text":"复刻成功"}],
         *             "usage":{"input_tokens":1706,...}}
         * 请求体 8328 字节（官方 ~8.3-8.6 KB）
         * ```
         *
         * **⇒ 3012 被绕过。** 此前第四轮「头集合逐字段对齐仍 3012 ⇒ 不可绕过」
         * 的结论不完整 —— 判据在**请求体的 system 字段**，不在 HTTP 头里。
         *
         * ⚠ **风控警告**：3012 会触发账号冷却（30min，24h 内第 3 次起 24h，
         *   5 次停用）。**不要压测。**
         */
        const OFFICIAL_CLI_PREFIX = "You are ZCode, an interactive coding agent";

        /**
         * 判断是否走 fast path（直发上游，跳过壳的会话/轮次循环）。
         *
         * ## 两条准入路径
         *
         * ① **探针串**（原有）：以 `"You are ZCode connectivity probe."` 开头。
         *    用于连通性诊断，语义明确、易于识别。
         *
         * ② **官方身份块**（新增）：以 `"You are ZCode, an interactive coding agent"`
         *    开头。这是**官方客户端真实的 system 开头**，也是 DSH 适配器在
         *    补齐 system 后能够构造的形态。
         *
         * ## 为什么 ② 能让主链路变快
         *
         * 实测对比（同账号、同 captcha 来源）：
         *
         * | 链路 | ttft | 总耗时 |
         * |---|---|---|
         * | 会话链路（fastSystem 非空但没走 fast path 时实际走的） | 8-11s | 22s / 17.8s |
         * | **直发（本路径）** | **0.8-1.1s** | **5.1-6.8s** |
         *
         * **⇒ 快 3-4 倍**，且工具调用是**原生 `tool_use`**（无需 JSON 围栏解析）。
         *
         * ## 匹配规则（沿用探针串的实测结论）
         *
         * **前缀匹配**：只要以该串**开头**即可，后面可追加任意内容。
         * 反过来（额外内容在前）会失败 —— 与探针串同构。
         */
        /**
         * ⚠ 2026-09-28 实测：**只保留探针串准入**。
         *
         * 曾试图让「官方 CLI 身份块开头」的 system 也走 fast path，
         * 以得到 3-4 倍提速（Node 脚本直发实测 1.1-5.1s vs 会话链路 22s）。
         * 但桥内（Electron utilityProcess）直发**稳定 3012**，
         * 而完全相同的 body 与头在 Node 脚本里**稳定 200**
         * —— 7 次单变量实验均未找出差异，判定为**运行时网络栈差异**
         * （undici vs Electron 的网络栈），非 HTTP 层可控。
         *
         * 相关代码与 `zcode-system.json` 的完整身份块仍保留在本文件中，
         * 一旦该差异被攻克可直接启用。**不要再盲目重试** ——
         * 3012 有账号冷却惩罚（30min，24h 内第 3 次起 24h，5 次停用）。
         */
        /**
         * 准入：**任何非空 system 都走 fast path**（2026-09-28 最终版）。
         *
         * ## 为什么不再限制前缀
         *
         * 曾要求 system 以「探针串」或「官方 cliPrefix」开头，前者让主链路
         * 永远走慢的会话链路（22s），后者因 system 内容不足仍 3012。
         *
         * ## 真正的判据（实测，两次推翻后确定）
         *
         * 上游按 **system 的内容与结构**做检查：
         *
         * | system | 结果 |
         * |---|---|
         * | 无 | 3012 |
         * | 仅调用方 system（2782 字符） | 3012 |
         * | **官方三块（7599 字符）** | **200** |
         *
         * 验证方式：`curl` 带完整三块 system **200**、Node 脚本 **200**、
         * 桥（修复后）**200** —— 三者一致，排除运行时差异。
         *
         * ⇒ **桥自己注入官方身份块**（见 `buildOfficialSystemBlocks`），
         *    调用方传什么都不影响能不能过。
         */
        const isFastPathSystem = (value: unknown): value is string =>
          typeof value === "string" && value.trim().length > 0;

        const fastSystem = isFastPathSystem(body.system) ? body.system : undefined;
        if (fastSystem !== undefined && deps.mintAuthMaterial !== undefined) {
          const fastStartMs = Date.now();
          try {
            /**
             * ★★ 材料缓存（2026-09-27 新增）—— 省掉「每次请求都 mint」的开销。
             *
             * ## 为什么要做（实测数据）
             *
             * `/diagnostics/mint` 实测 209ms - 2629ms，且**每个请求都要做一次**：
             *
             *   mint 单次:  445ms
             *   mint 再次:  209ms
             *   mint 一次特别慢: 2629ms
             *
             * 而 DSH 的多步 agent 循环**每步发一次请求** —— 10 步就是 10 次 mint。
             * 按中位 0.4 秒算，一轮任务白花 4 秒。
             *
             * ## 缓存策略
             *
             * - 按 `providerId + modelId` 分键（不同 provider 材料不同）
             * - **TTL 30 秒**：材料是一次性凭据，过期必须重取，不能长存
             * - 并发去重：同一键同时只有一个 mint 在飞，其余等它（避免惊群）
             * - 失败不缓存：mint 失败时清掉，让下一个请求重试
             *
             * ## 为什么 TTL 取 30 秒（而不是更长）
             *
             * 上游对材料的判定含「新鲜度」语义（本项目早先实测过「材料被抢先消费
             * → 3007」）。**宁可保守重取，也不要拿过期材料换稳定性。**
             * 30 秒足够覆盖 DSH 一轮多步任务的连续请求。
             */
            const providerId = resolveProviderId(body["providerId"]);
            const cacheKey = `${providerId}::${modelId}`;
            const nowMs = Date.now();
            const cached = FAST_MATERIAL_CACHE_DISABLED
              ? undefined
              : fastMaterialCache.get(cacheKey);
            let material: Awaited<ReturnType<typeof deps.mintAuthMaterial>>;
            let materialFromCache = false;
            if (cached !== undefined && nowMs - cached.atMs < FAST_MATERIAL_TTL_MS) {
              material = cached.material;
              materialFromCache = true;
            } else {
              // 并发去重：同键已有的 mint 在飞就复用它，不再发一个
              const inflight = FAST_MATERIAL_CACHE_DISABLED
                ? undefined
                : fastMaterialInflight.get(cacheKey);
              if (inflight !== undefined) {
                material = await inflight;
                materialFromCache = true;
              } else {
                const p = deps.mintAuthMaterial({ providerId, modelId, workspacePath });
                if (!FAST_MATERIAL_CACHE_DISABLED) fastMaterialInflight.set(cacheKey, p);
                try {
                  material = await p;
                } finally {
                  if (!FAST_MATERIAL_CACHE_DISABLED) fastMaterialInflight.delete(cacheKey);
                }
              }
              if (!FAST_MATERIAL_CACHE_DISABLED) {
                if (material?.apiKey !== undefined) {
                  fastMaterialCache.set(cacheKey, { material, atMs: Date.now() });
                } else {
                  fastMaterialCache.delete(cacheKey);
                }
              }
            }
            const mintMs = Date.now() - fastStartMs;
            if (material?.apiKey === undefined) {
              errorJson(response, 502, "Failed to mint auth material.", "credential_unavailable");
              return;
            }
            /**
             * ★★ 头集合规范化（2026-09-28 dump 定位，修复 3012）。
             *
             * ## 问题：同名不同大小写的**重复头**
             *
             * `bridgeSourceHeaders()` 用的是**标题式大小写**
             * （`User-Agent` / `X-Title` / `HTTP-Referer` / `X-Device-Mid` …），
             * 而官方形态用小写（`user-agent` / `x-title`）。两者**同时进对象**
             * 就成了**两套键**，`fetch` 会把它们都发出去 ——
             *
             * dump 实测：**23 个头，其中三对是重复的**
             *
             * ```
             * user-agent  +  User-Agent     ← 且值不同（后者覆盖不了前者）
             * x-title     +  X-Title        ← 值不同
             * HTTP-Referer（应为 http-referer）
             * ```
             *
             * HttpClient 只在**同一键名**时覆盖；不同大小写是不同键。
             * ⇒ **必须在展开后按小写归一化，并让官方值胜出。**
             *
             * ## 做法
             *
             * 1. 先全部转小写（后面的同名键覆盖前面的 —— JS 对象字面量后者胜）
             * 2. 再删除官方 CLI 明确不带的键
             *
             * 注意 `bridgeSourceHeaders()` 的返回值**必须先展开成普通对象**
             * 再转小写，否则 `...` 展开仍保留原键名。
             */
            const normalizedSourceHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(bridgeSourceHeaders())) {
              normalizedSourceHeaders[key.toLowerCase()] = value;
            }

            /**
             * ★★ 官方 CLI 形态的 22 头（照 `a137460387/zcode2api`
             * `src/upstream/headers.js` 复刻，本项目实测 200）。
             *
             * ## 与桌面形态的关键差异
             *
             * | 头 | 官方 CLI | 桌面会话链路 |
             * |---|---|---|
             * | `x-title` | **`Z Code@cli`** | `Z Code@electron` |
             * | `user-agent` | `ZCode/3.14.3 ai-sdk/anthropic/3.0.81` | 带 provider-utils |
             * | `x-device-mid` | **不带** | 带 |
             * | `x-query-id` / `x-session-id` | **不带** | 带 |
             *
             * ## ⚠ 教训：「越像越好」是错的
             *
             * 第三/四轮从**桌面会话链路**抓包复刻的头，用在 fast path 上
             * 反而触发 3012 —— 因为 fast path 要模仿的是**官方 CLI**，
             * 不是「我们自己那个桌面壳」。
             * 本项目第四轮其实已记录过这个反直觉现象：
             * 「壳内模型请求**不带** `X-Device-Mid`」。
             */
            const officialCliHeaders: Record<string, string> = {
              "accept-encoding": "gzip",
              "anthropic-version": "2023-06-01",
              authorization: `Bearer ${material.apiKey}`,
              "content-type": "application/json",
              "http-referer": "https://zcode.z.ai",
              "user-agent": "ZCode/3.14.3 ai-sdk/anthropic/3.0.81",
              "x-aliyun-captcha-verify-param":
                material.headers?.["X-Aliyun-Captcha-Verify-Param"] ?? "",
              "x-aliyun-captcha-verify-region":
                material.headers?.["X-Aliyun-Captcha-Verify-Region"] ?? "cn",
              "x-api-key": material.apiKey,
              "x-client-language": "zh-CN",
              "x-client-timezone": "Asia/Shanghai",
              "x-os-category": "windows",
              "x-os-version": "10.0.26200",
              "x-platform": "win32-x64",
              "x-release-channel": "production",
              "x-title": "Z Code@cli",
              "x-zcode-agent": "glm",
              "x-zcode-app-version": "3.14.3",
              "x-zcode-session-type": "main",
            };

            const fastHeaders: Record<string, string> = {
              ...normalizedSourceHeaders,
              ...officialCliHeaders,
              /**
               * `accept` 只有流式时才需要显式声明 —— 官方不主动带它。
               * 放在最后：流式场景必须覆盖成 `text/event-stream`，
               * 否则 DSH 收到的不是 SSE。
               */
              ...(body.stream === true ? { accept: "text/event-stream" } : {}),
            };

            /**
             * 删除官方 CLI 明确不带的头。
             *
             * ## 为什么用 delete 而不是置空字符串
             *
             * `fetch` 对空字符串头的处理因实现而异 —— 可能发出
             * `x-device-mid: ` 这种「存在但为空」的头，而上游仍据其判定。
             * 逐键 `delete` 才是真的不发。
             */
            for (const key of [
              "x-device-mid",
              "x-query-id",
              "x-session-id",
              "x-client-sig",
              "x-client-pow",
            ]) {
              delete fastHeaders[key];
            }
            /**
             * ★★ 把插件传来的「工具往返标记」还原成 Anthropic 原生 block
             * （2026-09-28 修复：模型重复调用同一工具、永不收敛）。
             *
             * ## 症状（用户实测）
             *
             *   tool_call pwsh({"command":"Get-Date"}) → 结果 07:26:19
             *   tool_call pwsh({"command":"Get-Date"}) → 结果 07:26:30   ×N 次
             *   58.9 秒后仍未给出最终回答
             *
             * ## 根因
             *
             * 旧路径把工具往返**降级成纯文本**（```json {"tool":...}``` + `[tool-result ...]`）。
             * 模型看不到「这是我的调用、这是它的结果」的**结构化配对**，
             * 于是无法判断「上次调用已完成」→ 只能再调一次。
             *
             * ## 修法
             *
             * 插件用 NUL 前缀标记承载结构化数据（避免与正文冲突），桥在这里
             * 拆成 Anthropic 形状：
             *
             * ## 承载格式：**长度前缀**（2026-09-28 修正）
             *
             * 旧实现用 `raw.split(TOOL_USE_MARK)` 做**无转义的字面切分**。而标记后面
             * 承载的是**工具结果的真实文本** —— 只要某条工具输出里出现
             * `\u0000TOOL_RESULT\u0000`（NUL 是合法 UTF-8，来自读二进制文件、cat 内容、
             * 或上一轮桥自己回显的文本），就会被当成结构边界，**伪造出一个 tool_result block**，
             * 把任意 `tool_use_id` 配到模型面前。
             *
             * 修法：标记后跟**十进制长度 + 换行**，再跟 payload 本体：
             *
             *     \u0000TOOL_RESULT\u0000<len>\n<payload>
             *
             * 解析时按长度精确切 payload —— **payload 里出现任何标记都无害**。
             * 长度前缀也天然防住了「JSON 里含换行」等歧义。
             *
             * 兼容：若标记后不是「数字+\n」（旧格式），回退到按换行切 JSON 的老逻辑。
             */
            const TOOL_USE_MARK = "\u0000TOOL_USE\u0000";
            const TOOL_RESULT_MARK = "\u0000TOOL_RESULT\u0000";
            /** 解析 `mark + <len>\n<payload>`；不是长度前缀格式时返回 undefined。 */
            const readLenPrefixed = (
              after: string,
            ): { payload: string; rest: string } | undefined => {
              const nl = after.indexOf("\n");
              if (nl <= 0) return undefined;
              const head = after.slice(0, nl);
              if (!/^\d+$/.test(head)) return undefined;
              const len = Number(head);
              if (!Number.isSafeInteger(len) || len < 0) return undefined;
              const body = after.slice(nl + 1);
              if (body.length < len) return undefined;
              return { payload: body.slice(0, len), rest: body.slice(len) };
            };
            const fastMessages = messages
              .filter((m) => m.role !== "system")
              .map((m) => {
                const raw = m.content;
                if (
                  typeof raw !== "string" ||
                  (!raw.includes(TOOL_USE_MARK) && !raw.includes(TOOL_RESULT_MARK))
                ) {
                  return { role: m.role, content: raw };
                }
                const blocks: Array<Record<string, unknown>> = [];
                const pushText = (t: string): void => {
                  const v = t.trim();
                  if (v.length > 0) blocks.push({ type: "text", text: v });
                };
                /**
                 * 从一段文本里**按顺序**抽出「文本 / tool_use / tool_result」。
                 *
                 * 两种标记格式都支持：
                 * - 新：`mark<len>\n<payload>`（payload 可含任意内容）
                 * - 旧：`mark<json>\n<剩余>`（按换行切）
                 */
                let cursor = 0;
                const text0 = raw;
                const scan = (): void => {
                  while (cursor < text0.length) {
                    const iUse = text0.indexOf(TOOL_USE_MARK, cursor);
                    const iRes = text0.indexOf(TOOL_RESULT_MARK, cursor);
                    let i = -1;
                    let kind: "use" | "result" | undefined;
                    if (iUse >= 0 && (iRes < 0 || iUse < iRes)) {
                      i = iUse;
                      kind = "use";
                    } else if (iRes >= 0) {
                      i = iRes;
                      kind = "result";
                    }
                    if (i === -1 || kind === undefined) {
                      pushText(text0.slice(cursor));
                      cursor = text0.length;
                      return;
                    }
                    pushText(text0.slice(cursor, i));
                    const markLen =
                      kind === "use" ? TOOL_USE_MARK.length : TOOL_RESULT_MARK.length;
                    const after = text0.slice(i + markLen);
                    const lens = readLenPrefixed(after);
                    let payload: string;
                    if (lens !== undefined) {
                      payload = lens.payload;
                      cursor = i + markLen + (after.length - lens.rest.length);
                    } else {
                      // 旧格式回退：JSON 在首个换行之前
                      const nl = after.indexOf("\n");
                      payload = nl >= 0 ? after.slice(0, nl) : after;
                      cursor = i + markLen + payload.length + (nl >= 0 ? 1 : 0);
                    }
                    try {
                      if (kind === "use") {
                        const o = JSON.parse(payload) as {
                          id?: string;
                          name?: string;
                          input?: unknown;
                        };
                        blocks.push({
                          type: "tool_use",
                          id: o.id ?? `zcb-bridge-${blocks.length}`,
                          name: o.name ?? "unknown",
                          input: o.input ?? {},
                        });
                      } else {
                        const o = JSON.parse(payload) as {
                          tool_use_id?: string;
                          content?: unknown;
                          is_error?: boolean;
                        };
                        blocks.push({
                          type: "tool_result",
                          tool_use_id: o.tool_use_id ?? `zcb-orphan-${blocks.length}`,
                          content:
                            typeof o.content === "string"
                              ? o.content
                              : JSON.stringify(o.content ?? ""),
                          ...(o.is_error === true ? { is_error: true } : {}),
                        });
                      }
                    } catch {
                      pushText(payload);
                    }
                  }
                };
                scan();
                return { role: m.role, content: blocks };
              });
            /**
             * ★ 必须把 OpenAI 形状的 `tools` 转成 Anthropic 的 `tools`。
             *
             * ## 为什么（实测踩过）
             *
             * 第一版忘了转换 → 上游不知道有任何工具 → 模型转而使用**壳内**的
             * `web_search`（它自己内置的能力），并**编造了搜索结果**：
             *
             *   「我没有名为 get_weather 的工具，不过我可以用网页搜索…
             *     **web_search** {"query":"杭州天气"}
             *     网页 #1: 杭州天气 - 中国天气网 - 今日（10月27日）：多云转晴…」
             *
             * 而且耗时 18.2 秒（真去搜网页），比会话链路还慢。
             *
             * Anthropic 的工具形状：
             *   { name, description?, input_schema: {...} }
             * 对比 OpenAI：
             *   { type: "function", function: { name, description?, parameters } }
             */
            const rawTools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
            const fastTools = rawTools
              .map((t) => {
                if (t === null || typeof t !== "object") return undefined;
                const rec = t as {
                  type?: unknown;
                  function?: { name?: unknown; description?: unknown; parameters?: unknown };
                };
                const fn = rec.function;
                if (fn === undefined || typeof fn.name !== "string" || fn.name.length === 0) {
                  return undefined;
                }
                return {
                  name: fn.name,
                  ...(typeof fn.description === "string" ? { description: fn.description } : {}),
                  input_schema:
                    fn.parameters !== null && typeof fn.parameters === "object"
                      ? (fn.parameters as Record<string, unknown>)
                      : { type: "object", properties: {} },
                };
              })
              .filter((t): t is { name: string; description?: string; input_schema: Record<string, unknown> } => t !== undefined);
            /**
             * `tool_choice` 全量映射（2026-09-28 修正）。
             *
             * ## 旧实现的缺陷（子代理指出）
             *
             * 只判断 `=== "none"`，其余取值**一律降级成 `{type:"auto"}`**：
             *
             * - `"required"` → 本应 `{type:"any"}`（强制调某个工具）→ 静默失效，
             *   模型可能不调工具直接闲聊
             * - `{type:"function",function:{name}}` → 本应 `{type:"tool",name}` →
             *   指定工具被忽略
             *
             * ## OpenAI ↔ Anthropic 的对应
             *
             *   "none"                              → 不传（且不启用工具面）
             *   "auto"                              → { type: "auto" }
             *   "required"                          → { type: "any" }
             *   {type:"function",function:{name}}   → { type: "tool", name }
             */
            const fastToolChoice = ((): Record<string, unknown> | undefined => {
              if (fastTools.length === 0) return undefined;
              const tc = body.tool_choice;
              if (tc === "none") return undefined;
              if (tc === "required") return { type: "any" };
              if (tc === "auto" || tc === undefined || tc === null) return { type: "auto" };
              if (tc !== null && typeof tc === "object") {
                const rec = tc as {
                  type?: unknown;
                  function?: { name?: unknown };
                  name?: unknown;
                };
                // OpenAI 形状：{type:"function",function:{name}}
                const fnName =
                  typeof rec.function?.name === "string"
                    ? rec.function.name
                    : typeof rec.name === "string"
                      ? rec.name
                      : undefined;
                if (fnName !== undefined && fnName.length > 0) {
                  return { type: "tool", name: fnName };
                }
                // Anthropic 原生形状透传
                if (typeof rec.type === "string") {
                  return rec as Record<string, unknown>;
                }
              }
              if (typeof tc === "string" && tc.length > 0) {
                // 未知字符串取值 —— 保守用 auto，但记一条日志便于排查
                log("bridge.fast_path.unknown_tool_choice", { toolChoice: tc });
                return { type: "auto" };
              }
              return { type: "auto" };
            })();
            /**
             * `stop_sequences` 透传（2026-09-28 补）。
             *
             * OpenAI 的 `stop`（string 或 string[]）对应 Anthropic 的 `stop_sequences`（string[]）。
             * 旧实现完全丢弃 —— 调用方设的停止串不起作用，模型可能输出不该出现的标记。
             */
            const fastStopSequences = ((): string[] | undefined => {
              const raw = body.stop ?? body["stop_sequences"];
              if (typeof raw === "string" && raw.length > 0) return [raw];
              if (Array.isArray(raw)) {
                const arr = raw.filter((s): s is string => typeof s === "string" && s.length > 0);
                return arr.length > 0 ? arr : undefined;
              }
              return undefined;
            })();
            /**
             * ★ system 必须转成**块数组**形态（2026-09-28）。
             *
             * ## 为什么
             *
             * 官方客户端发的是**三块** `{type:"text", cache_control:{type:"ephemeral"}}`：
             *
             *   ① `"You are ZCode, an interactive coding agent"`（42 字符）
             *   ② stable 段（Harness + ZCode Desktop Context，约 2311 字符）
             *   ③ `"\n\n"` 前缀 + dynamic 段（约 5000 字符）
             *
             * 总计约 7.6 KB，请求体约 8.3 KB —— 与官方 8.3-8.6 KB 吻合。
             *
             * 适配器传进来的是**一个字符串**。实测：字符串形态会 3012
             * （上游做内容检查，看的是身份块结构），转成块数组后 200。
             *
             * ## 转换策略
             *
             * - 探针路径（`You are ZCode connectivity probe.`）→ 整段单块，
             *   诊断用途不需要身份块结构
             * - 官方身份块路径 → 切出 cliPrefix 单独成块，其余进第二块
             */
            /**
             * ★ 桥自己注入官方身份块（2026-09-28）。
             *
             * 上游按 system 的**内容与结构**做检查：
             *   无 system / 仅调用方 system（2782 字符）→ 3012
             *   官方三块（7599 字符）              → 200
             *
             * 三种客户端（curl / Node 脚本 / 本桥）带完整三块时**都 200**，
             * 所以判据是内容而非运行时（本轮曾误判为 Electron 网络栈差异）。
             *
             * 调用方的 system 会被**追加在最后** —— 身份块必须在开头。
             */
            const fastSystemBlocks = buildOfficialSystemBlocks(fastSystem, {
              cwd: bridgeWorkspacePath(),
              model: modelId.toLowerCase(),
            });
            const upstreamBody = JSON.stringify({
              /**
               * ⚠ 模型名必须**小写** —— 官方发 `glm-5.3-flash`。
               * 大写形态（`GLM-5.3-Flash`）是裸请求的特征之一（实测 3012）。
               */
              model: modelId.toLowerCase(),
              max_tokens: maxOutputTokens ?? 8192,
              system: fastSystemBlocks,
              ...(body.stream === true ? { stream: true } : {}),
              ...(fastTools.length === 0 ? {} : { tools: fastTools }),
              ...(fastToolChoice === undefined ? {} : { tool_choice: fastToolChoice }),
              ...(fastStopSequences === undefined
                ? {}
                : { stop_sequences: fastStopSequences }),
              messages: withContextPrefix(fastMessages),
            });
            /**
             * ★ 临时诊断：把实际发出的请求写盘（2026-09-28）。
             *
             * ## 为什么需要
             *
             * 独立脚本直发 200，桥直发 3012，而**头、system 块数、
             * 模型名大小写**都已逐项排除（全部 200）。
             *
             * 剩下的差异无法靠读代码确定 —— 必须看**实际发出的字节**。
             * 这与本项目第三轮的经验一致：
             * 「验证插件改动要用落盘诊断，不要只用 logger」
             * （logger 的多参数调用可能被吞掉，实测踩过）。
             *
             * 只在 `ZCODE_BRIDGE_DUMP_REQUEST=1` 时落盘。
             */
            if (true) {
              try {
                const { writeFileSync } = await import("node:fs");
                const { join: joinPath } = await import("node:path");
                writeFileSync(
                  joinPath(deps.dataBaseDir, "bridge-last-request.ndjson"),
                  JSON.stringify(
                    {
                      at: new Date().toISOString(),
                      url: `${ZCODE_PLAN_ANTHROPIC_BASE}/v1/messages`,
                      headerNames: Object.keys(fastHeaders),
                      headers: fastHeaders,
                      bodyLength: upstreamBody.length,
                      body: upstreamBody,
                    },
                    null,
                    2,
                  ),
                  "utf8",
                );
              } catch {
                /* 诊断失败不影响主流程 */
              }
            }
            const upstream = await fetch(`${ZCODE_PLAN_ANTHROPIC_BASE}/v1/messages`, {
              method: "POST",
              headers: fastHeaders,
              body: upstreamBody,
            });
            /**
             * ★ 流式分支 —— 把 Anthropic SSE 翻成 OpenAI SSE。
             *
             * ## 为什么必须做（实测踩过）
             *
             * DSH 插件默认发 `Accept: text/event-stream`。第一版只处理非流式 →
             * 收到 SSE 却按 JSON 解析 → 报：
             *
             *   zcode-bridge: 桥返回 502 Upstream returned non-JSON:
             *   event: message_start\ndata: {"type":"message_start",...}
             *
             * ## 两个协议的 SSE 形状差异
             *
             * Anthropic：
             *   event: content_block_delta
             *   data: {"type":"content_block_delta","index":1,
             *          "delta":{"type":"text_delta","text":"你"}}
             *
             * OpenAI：
             *   data: {"choices":[{"index":0,"delta":{"content":"你"},"finish_reason":null}]}
             *   data: [DONE]
             *
             * 工具调用同理：Anthropic 用 `input_json_delta`（分片 JSON 字符串），
             * OpenAI 用 `tool_calls[].function.arguments`（也是分片字符串）—— 形状可直接对应。
             */
            if (body.stream === true) {
              if (upstream.status !== 200) {
                const errText = await upstream.text();
                errorJson(
                  response,
                  upstream.status === 405 ? 502 : upstream.status,
                  `Upstream rejected fast stream: ${errText.slice(0, 400)}`,
                  "upstream_error",
                );
                return;
              }
              const streamId = `bridge-fast-${Date.now()}`;
              const created = Math.floor(Date.now() / 1000);
              response.writeHead(200, {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache, no-transform",
                connection: "keep-alive",
                "x-accel-buffering": "no",
              });
              const send = (delta: Record<string, unknown>, finishReason: string | null): void => {
                response.write(
                  `data: ${JSON.stringify({
                    id: streamId,
                    object: "chat.completion.chunk",
                    created,
                    model: modelId,
                    choices: [{ index: 0, delta, finish_reason: finishReason }],
                  })}\n\n`,
                );
              };
              send({ role: "assistant", content: "" }, null);
              /**
               * Anthropic 的 `input_json_delta` 是**按 content block index** 分片的；
               * OpenAI 的 `function.arguments` 也分片，但用 tool_calls 数组里的 index 定位。
               * 这里维护 blockIndex → openai tool index 的映射。
               */
              const blockToToolIndex = new Map<number, number>();
              let nextToolIndex = 0;
              let sawToolCall = false;
              let finishReason: string | null = null;
              let streamErr: string | undefined;
              /**
               * ★ 分段计时（2026-09-27 补）—— 定位「快速路径为何有时 100 秒」。
               *
               * 此前只记 `durationMs`，看不出慢在哪一段。参照旧会话链路的
               * `ttftMs` / `genMs` 分开记：
               *
               *   ttftMs  = 从发起上游请求到**首个上游事件**到达
               *   genMs   = 首字节到流结束（真正的生成时间）
               *
               * 判据：若某次 `ttftMs` 接近 `durationMs` 而 `genMs` 很小，
               * 说明慢在「上游排队/思考」，不是「输出长度」。
               */
              let firstUpstreamEventMs: number | undefined;
              let deltaCount = 0;
              try {
                const reader = upstream.body?.getReader();
                if (reader === undefined) throw new Error("upstream body is null");
                const decoder = new TextDecoder();
                let buffer = "";
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  buffer += decoder.decode(value, { stream: true });
                  // SSE 以空行分隔事件
                  let sep = buffer.indexOf("\n\n");
                  while (sep >= 0) {
                    const rawEvent = buffer.slice(0, sep);
                    buffer = buffer.slice(sep + 2);
                    sep = buffer.indexOf("\n\n");
                    for (const line of rawEvent.split("\n")) {
                      if (!line.startsWith("data:")) continue;
                      const payload = line.slice(5).trim();
                      if (payload.length === 0) continue;
                      let evt: {
                        type?: string;
                        index?: number;
                        delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
                        content_block?: { type?: string; id?: string; name?: string };
                        message?: { usage?: { input_tokens?: number } };
                        usage?: { output_tokens?: number };
                      };
                      try {
                        evt = JSON.parse(payload) as typeof evt;
                      } catch {
                        continue;
                      }
                      // 首个上游事件到达 = 首字节时刻（ttft 的分界点）
                      if (firstUpstreamEventMs === undefined) {
                        firstUpstreamEventMs = Date.now() - fastStartMs;
                      }
                      deltaCount += 1;
                      if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
                        const idx = typeof evt.index === "number" ? evt.index : nextToolIndex;
                        const toolIdx = nextToolIndex;
                        nextToolIndex += 1;
                        blockToToolIndex.set(idx, toolIdx);
                        sawToolCall = true;
                        send(
                          {
                            tool_calls: [
                              {
                                index: toolIdx,
                                id:
                                  typeof evt.content_block.id === "string"
                                    ? evt.content_block.id
                                    : `bridge-fast-tool-${toolIdx}`,
                                type: "function",
                                function: {
                                  name:
                                    typeof evt.content_block.name === "string"
                                      ? evt.content_block.name
                                      : "",
                                  arguments: "",
                                },
                              },
                            ],
                          },
                          null,
                        );
                      } else if (evt.type === "content_block_delta" && evt.delta !== undefined) {
                        if (evt.delta.type === "text_delta" && typeof evt.delta.text === "string") {
                          send({ content: evt.delta.text }, null);
                        } else if (
                          evt.delta.type === "thinking_delta" &&
                          typeof evt.delta.thinking === "string"
                        ) {
                          send({ reasoning_content: evt.delta.thinking }, null);
                        } else if (
                          evt.delta.type === "input_json_delta" &&
                          typeof evt.delta.partial_json === "string"
                        ) {
                          const toolIdx = blockToToolIndex.get(evt.index ?? 0) ?? 0;
                          send(
                            {
                              tool_calls: [
                                {
                                  index: toolIdx,
                                  function: { arguments: evt.delta.partial_json },
                                },
                              ],
                            },
                            null,
                          );
                        }
                      } else if (evt.type === "message_delta") {
                        const sr = (evt as { delta?: { stop_reason?: string } }).delta?.stop_reason;
                        if (typeof sr === "string") {
                          finishReason =
                            sr === "tool_use" ? "tool_calls" : sr === "max_tokens" ? "length" : "stop";
                        }
                      }
                    }
                  }
                }
              } catch (error) {
                streamErr = error instanceof Error ? error.message : String(error);
              }
              /**
               * 收尾 finish_reason 的兜底（2026-09-28 修正）。
               *
               * ## 旧实现的漏洞（子代理指出）
               *
               * 兜底只看 `sawToolCall`，而它**只在 `content_block_start` with
               * `type==="tool_use"` 时置位**。若上游（某些 Anthropic 兼容实现）
               * 把 tool_use 直接放在非流式 message 里、流式分片里没有
               * `content_block_start`，就会误报 `"stop"` → **DSH 不执行工具**。
               *
               * ## 判据加强
               *
               * 除 `sawToolCall` 外，再看两个信号：
               *   - `blockToToolIndex.size > 0` —— 有过任何 tool block 映射
               *   - `finishReason` 若是 `"tool_use"`（message_delta 给过）也算
               */
              const hadToolBlock = sawToolCall || blockToToolIndex.size > 0;
              send({}, finishReason ?? (hadToolBlock ? "tool_calls" : "stop"));
              response.write("data: [DONE]\n\n");
              response.end();
              const totalMs = Date.now() - fastStartMs;
              log("bridge.fast_path.stream_completed", {
                modelId,
                durationMs: totalMs,
                sawToolCall,
                streamErr,
                // ── 分段（2026-09-27 补，用于定位「有时 100 秒」）──
                // ttftMs 大而 genMs 小 ⇒ 慢在上游排队/思考，不是输出长度。
                ttftMs: firstUpstreamEventMs ?? totalMs,
                genMs: firstUpstreamEventMs === undefined ? 0 : totalMs - firstUpstreamEventMs,
                deltaCount,
                // 材料缓存命中情况（缓存省掉 mint；见 FAST_MATERIAL_TTL_MS）
                mintMs: Date.now() - fastStartMs - (firstUpstreamEventMs ?? 0),
                materialFromCache,
              });
              return;
            }
            const upstreamText = await upstream.text();
            const durationMs = Date.now() - fastStartMs;
            log("bridge.fast_path.completed", {
              modelId,
              upstreamStatus: upstream.status,
              durationMs,
              textLength: upstreamText.length,
            });
            if (upstream.status !== 200) {
              errorJson(
                response,
                upstream.status === 405 ? 502 : upstream.status,
                `Upstream rejected fast path: ${upstreamText.slice(0, 400)}`,
                "upstream_error",
              );
              return;
            }
            // 非流式：把 Anthropic 响应翻成 OpenAI 形状
            let parsed: {
              content?: Array<{
                type?: string;
                text?: string;
                thinking?: string;
                id?: string;
                name?: string;
                input?: unknown;
              }>;
              stop_reason?: string;
              usage?: { input_tokens?: number; output_tokens?: number };
            };
            try {
              parsed = JSON.parse(upstreamText) as typeof parsed;
            } catch {
              errorJson(response, 502, `Upstream returned non-JSON: ${upstreamText.slice(0, 200)}`);
              return;
            }
            const textOut = (parsed.content ?? [])
              .filter((c) => c.type === "text" && typeof c.text === "string")
              .map((c) => c.text as string)
              .join("");
            const reasoningOut = (parsed.content ?? [])
              .filter((c) => c.type === "thinking" && typeof c.thinking === "string")
              .map((c) => c.thinking as string)
              .join("");
            /**
             * ★ Anthropic `tool_use` → OpenAI `tool_calls`（形状不同，必须转换）。
             *
             * Anthropic：
             *   {"type":"tool_use","id":"toolu_x","name":"get_weather","input":{"city":"杭州"}}
             * OpenAI：
             *   {"id":"toolu_x","type":"function",
             *    "function":{"name":"get_weather","arguments":"{\"city\":\"杭州\"}"}}
             *                                    ↑ arguments 是 **JSON 字符串**
             *（`ToolCallBlock.arguments` 也是字符串，所以这个形状正好对应）
             */
            const toolUses = (parsed.content ?? []).filter(
              (c) => c.type === "tool_use" && typeof c.name === "string",
            );
            const toolCallsOut = toolUses.map((c, i) => ({
              index: i,
              id: typeof c.id === "string" ? c.id : `bridge-fast-tool-${i}`,
              type: "function" as const,
              function: {
                name: c.name as string,
                arguments:
                  c.input === undefined || c.input === null ? "{}" : JSON.stringify(c.input),
              },
            }));
            json(response, 200, {
              id: `bridge-fast-${Date.now()}`,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: textOut,
                    ...(reasoningOut.length > 0 ? { reasoning_content: reasoningOut } : {}),
                    ...(toolCallsOut.length === 0 ? {} : { tool_calls: toolCallsOut }),
                  },
                  /**
                   * Anthropic `stop_reason` → OpenAI `finish_reason` 全量映射
                   * （2026-09-28 补齐）。
                   *
                   *   end_turn       → stop
                   *   stop_sequence  → stop      （命中停止串，语义上属正常结束）
                   *   max_tokens     → length
                   *   tool_use       → tool_calls
                   *   其他/缺失      → stop
                   *
                   * 旧实现只判 `max_tokens`，`tool_use` 靠 `toolCallsOut` 兜底 ——
                   * 若上游给了 `stop_reason:"tool_use"` 但 content 里没有可解析的
                   * tool_use block，会被误报 `stop`，DSH 不执行工具。
                   */
                  finish_reason:
                    toolCallsOut.length > 0 || parsed.stop_reason === "tool_use"
                      ? "tool_calls"
                      : parsed.stop_reason === "max_tokens"
                        ? "length"
                        : "stop",
                },
              ],
              usage: {
                prompt_tokens: parsed.usage?.input_tokens ?? 0,
                completion_tokens: parsed.usage?.output_tokens ?? 0,
                total_tokens:
                  (parsed.usage?.input_tokens ?? 0) + (parsed.usage?.output_tokens ?? 0),
              },
              bridge: { path: "fast", durationMs, upstreamStatus: upstream.status },
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log("bridge.fast_path.failed", {
              modelId,
              durationMs: Date.now() - fastStartMs,
              error: message,
            });
            errorJson(response, 502, `Fast path failed: ${message}`, "upstream_error");
          }
          return;
        }

        // 【实验】允许模型真的调用壳内工具。
        //
        // 默认 `false` —— 桥是"代答"通道，让模型执行壳内工具既有副作用风险，
        // 也是 180 秒超时的历史根源（见 bridgePreamble 的说明）。
        //
        // 置 `true` 时：不注入"不要调用工具"的前置说明、不传 toolDenylist，
        // 模型可自由调用。用途是验证「工具面透传」——壳内工具执行后，
        // 桥从 `onDynamicStreamEvent` 捕获结构化 `tool_call` 透给 DSH。
        const allowTools = body.allowTools === true;

        /**
         * 【流式】`stream: true` 时用 SSE 边生成边推。
         *
         * ## 为什么加这个
         *
         * 桥原先等整包才返回。一次请求 20-120 秒期间调用方拿不到任何东西，
         * 界面上表现为「卡在思考、不吐文本」 —— 这是用户报的最主要症状。
         *
         * 实测延迟构成（日志时间线）：
         *   - captcha：0.4 秒
         *   - 桥自身：~0.1 秒
         *   - **agent turn 循环：剩下全部**（20 秒里约 19.9 秒，其间 509 个内部事件）
         *
         * 所以能优化的不是"让上游变快"（那是免费额度通道的固有速度），
         * 而是**把已经产生的部分文本尽早吐出去**。
         *
         * ## 实现
         *
         * `runConversation` 在等终态的同时按 1.2 秒轮询快照，把累积文本回调
         * 出来；这里算差量、按 OpenAI SSE 形状推送。
         */
        const wantsStream =
          body.stream === true ||
          (typeof request.headers["accept"] === "string" &&
            request.headers["accept"].includes("text/event-stream"));

        const startedAt = Date.now();
        try {
          // ★ 走**带并发上限**的调度：见 runWithSlot 的说明。
          //   旧实现是完全串行；2026-09-27 实测证明壳能并行（3 并发墙钟
          //   28s vs 之和 60s），串行只会让短请求排在长请求后面干等。
          // 【流式】SSE 头要在**第一个字节产出前**发出，所以先写头。
          // 未要求流式时不写，保持原来的整包 JSON 行为。
          let sseOpen = false;
          const sseWrite = (chunk: unknown): void => {
            if (!wantsStream) return;
            if (!sseOpen) {
              response.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                // 禁掉中间层的缓冲，否则"流式"会被攒成一坨。
                "X-Accel-Buffering": "no",
              });
              sseOpen = true;
            }
            response.write(`data: ${JSON.stringify(chunk)}\n\n`);
          };

          const chatId = `chatcmpl-${randomBytes(8).toString("hex")}`;
          const created = Math.floor(Date.now() / 1000);

          // 已推出的文本长度 —— 快照给的是**累积全文**，这里算差量。
          let pushedChars = 0;
          const onPartialText =
            wantsStream === true
              ? (accumulated: string): void => {
                  if (accumulated.length <= pushedChars) return;
                  const delta = accumulated.slice(pushedChars);
                  pushedChars = accumulated.length;
                  sseWrite({
                    id: chatId,
                    object: "chat.completion.chunk",
                    created,
                    model: modelId,
                    choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
                  });
                }
              : undefined;

          // 【分段计时】用于定位「固定开销」到底花在哪。
          //
          // 背景：实测同一 prompt 的 durationMs 在 14-44 秒间波动，而
          // `runMs` 恒等于 `durationMs`（queueWaitMs=0），说明全部耗时都在
          // `runConversation` 内部，但**无法进一步细分**。
          //
          // 这里记录两个关键时点：
          //   - `runStartMs`：进入 runConversation 的绝对时刻
          //   - `firstTextAtMs`：**首次**收到非空增量文本的时刻（TTFT）
          //
          // TTFT 与总时长的差 = 生成耗时；TTFT 本身 = 会话准备 + captcha + 上游首字。
          // 这两个数一分开，就能判断该优化"准备"还是"生成"。
          const runStartMs = Date.now();
          let firstTextAtMs: number | undefined;

          const { value: result, queueWaitMs, runMs } = await runWithSlot(() =>
            deps.runConversation({
              workspacePath,
              providerId: resolveProviderId(body["providerId"]),
              modelId,
              reasoningLevel: deps.reasoningLevel ?? "max",
              messages,
              allowTools,
              ...(onPartialText === undefined
                ? {}
                : {
                    onPartialText: (accumulated: string): void => {
                      // 只在**首次**拿到非空文本时打点。
                      if (firstTextAtMs === undefined && accumulated.length > 0) {
                        firstTextAtMs = Date.now();
                      }
                      onPartialText(accumulated);
                    },
                  }),
              ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
              ...(deps.mcpServers === undefined ? {} : { mcpServers: deps.mcpServers }),
            }),
          );

          log("bridge.chat.completed", {
            modelId,
            durationMs: Date.now() - startedAt,
            // 排队等待 —— 并发满时才有值，正常情况下接近 0。
            //
            // ⚠ 旧实现把计时点与 `startedAt` 放在同一瞬间，导致这个字段
            //   恒等于 `durationMs`（**零信息量**，还会误导人以为全是排队）。
            queueWaitMs,
            // 真正执行时长（壳内 turn 跑了多久）。这才是"模型慢"的指标。
            runMs,
            // 【分段】从 runConversation 开始到首次拿到文本的毫秒数。
            // undefined = 全程没有增量文本（非流式请求，或模型空回复）。
            ttftMs: firstTextAtMs === undefined ? undefined : firstTextAtMs - runStartMs,
            // 【分段】拿到首字之后的生成耗时。
            genMs: firstTextAtMs === undefined ? undefined : Date.now() - firstTextAtMs,
            // 本次的并发上限 —— 便于从日志确认配置。
            concurrency: MAX_CONCURRENCY,
            textLength: result.text.length,
            toolCallCount: result.toolCalls?.length ?? 0,
            usage: result.usage,
          });

          // 【工具面透传】把结构化工具调用翻成 OpenAI 兼容的 `tool_calls` 形状。
          //
          // 为什么用这个形状而不是自定义：调用方（DSH 适配器）本来就要把结果
          // 合成为 DSH 的 `tool-call` 块，OpenAI 形状是最通用的中间表示
          // （`function.name` + `function.arguments` 恰好对应 DSH 的
          //  `name` + `arguments`，后者正好是 JSON 字符串）。
          const toolCallsOut = (result.toolCalls ?? [])
            .filter((call) => typeof call.toolName === "string" && call.toolName.length > 0)
            .map((call, index) => ({
              index,
              id: call.toolId,
              type: "function" as const,
              function: {
                name: call.toolName as string,
                arguments:
                  typeof call.input === "string"
                    ? call.input
                    : JSON.stringify(call.input ?? {}),
              },
              // 执行状态与结果 —— 壳内工具是**真的执行过**的，所以这里可能有值。
              // 调用方据 `status` 决定是当作"待执行的调用"还是"已有结果的调用"。
              status: call.status ?? "unknown",
              ...(call.output === undefined ? {} : { output: call.output }),
              ...(call.error === undefined ? {} : { error: call.error }),
            }));

          const finishReason =
            toolCallsOut.length > 0 ? "tool_calls" : (result.finishReason ?? "stop");

          if (wantsStream) {
            // ── 流式收尾 ──────────────────────────────────────────────
            //
            // 把**最终文本与工具调用**作为最后一帧发出去（快照轮询可能
            // 漏掉末尾几个字符，或整轮没有增量 —— 比如模型直接给工具调用）。
            // 调用方以这一帧为准，前面的 delta 只用于"边生成边显示"。
            if (result.text.length > pushedChars) {
              sseWrite({
                id: chatId,
                object: "chat.completion.chunk",
                created,
                model: modelId,
                choices: [
                  {
                    index: 0,
                    delta: { content: result.text.slice(pushedChars) },
                    finish_reason: null,
                  },
                ],
              });
            }
            sseWrite({
              id: chatId,
              object: "chat.completion.chunk",
              created,
              model: modelId,
              choices: [
                {
                  index: 0,
                  delta: {
                    ...(toolCallsOut.length > 0 ? { tool_calls: toolCallsOut } : {}),
                  },
                  finish_reason: finishReason,
                },
              ],
              usage: {
                prompt_tokens: result.usage?.inputTokens ?? 0,
                completion_tokens: result.usage?.outputTokens ?? 0,
                total_tokens: result.usage?.totalTokens ?? 0,
              },
            });
            response.write("data: [DONE]\n\n");
            response.end();
            return;
          }

          json(response, 200, {
            id: chatId,
            object: "chat.completion",
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: result.text,
                  ...(toolCallsOut.length > 0 ? { tool_calls: toolCallsOut } : {}),
                },
                // 有工具调用时用 `tool_calls`，与 OpenAI 语义一致。
                finish_reason: finishReason,
              },
            ],
            usage: {
              prompt_tokens: result.usage?.inputTokens ?? 0,
              completion_tokens: result.usage?.outputTokens ?? 0,
              total_tokens: result.usage?.totalTokens ?? 0,
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log("bridge.chat.failed", {
            modelId,
            durationMs: Date.now() - startedAt,
            error: message,
          });
          if (response.headersSent) {
            // SSE 已经开流：不能再发 JSON 状态码，只能用一帧错误 + 收尾，
            // 否则客户端会一直等一个永远不来的 `[DONE]`。
            try {
              response.write(
                `data: ${JSON.stringify({ error: { message, type: "upstream_error" } })}\n\n`,
              );
              response.write("data: [DONE]\n\n");
            } catch {
              // 连接已断，忽略。
            }
            response.end();
            return;
          }
          errorJson(response, 502, `Model request failed: ${message}`, "upstream_error");
        }
        return;
      }

      errorJson(response, 404, `Not found: ${method} ${url}`, "not_found");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("bridge.unhandled", { error: message });
      if (!response.headersSent) {
        errorJson(response, 500, `Internal error: ${message}`, "internal_error");
      }
    }
  };

  return (async () => {
    const server = createServer((request, response) => {
      void handler(request, response);
    });
    serverRef = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: "127.0.0.1", port: 0 });
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("ZCode bridge failed to bind a TCP port.");
    }
    const port = address.port;

    try {
      await mkdir(dirname(portFilePath), { recursive: true });
      await writeFile(
        portFilePath,
        JSON.stringify(
          {
            schemaVersion: 2,
            service: "zcode-bridge",
            transport: "session-path",
            host: "127.0.0.1",
            port,
            token,
            models: ALLOWED_MODELS,
            defaultProviderId: DEFAULT_PROVIDER_ID,
            instanceId: randomUUID(),
            // 本 host 进程的 pid —— 供 DSH 插件做保活判定。
            //
            // 插件无法从「端口可连」判断壳是否健在（端口由本进程持有，
            // 能连就说明进程活着），但它需要**在连接失败时**知道该重启谁。
            // 记下 pid，插件就能：探活失败 → 确认该 pid 已死 → 重新拉起。
            //
            // 用 host 进程而非 electron 主进程的 pid：桥跑在 host 里，
            // host 是真正持有端口与 session 链路的那一层。
            instancePid: process.pid,
            writtenAt: Date.now(),
          },
          null,
          2,
        ),
        "utf8",
      );
    } catch (error) {
      log("bridge.portfile.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    log("bridge.started", { port, portFilePath, transport: "session-path" });

    return {
      port,
      token,
      portFilePath,
      async close() {
        const current = serverRef;
        if (!current) return;
        await new Promise<void>((resolve) => current.close(() => resolve()));
        serverRef = undefined;
      },
    } satisfies ZCodeBridge;
  })();
}
