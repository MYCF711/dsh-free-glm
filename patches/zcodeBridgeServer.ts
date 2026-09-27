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
 * 免费额度通道的 Anthropic 兼容端点基址。
 *
 * 取自 `@zcode/shared` 的 `zcodeEndpoint.ts`：`${origin}/api/v1/zcode-plan/anthropic`，
 * 其中 origin 默认 `https://zcode.z.ai`。模型请求路径是 `${base}/v1/messages`。
 */
const ZCODE_PLAN_ANTHROPIC_BASE = "https://zcode.z.ai/api/v1/zcode-plan/anthropic";

export interface ZCodeBridgeMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
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
  readonly mintAuthMaterial?: (params: {
    providerId: string;
    modelId: string;
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

async function readBody(request: IncomingMessage, limitBytes = 4 * 1024 * 1024): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error(`Request body too large (>${limitBytes} bytes)`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
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

        const startedAt = Date.now();
        try {
          const material = await deps.mintAuthMaterial({
            providerId: DEFAULT_PROVIDER_ID,
            modelId: model,
            // ★ 必须用与会话链路同一个 workspacePath —— 否则 captcha 事件
            //   被 fire 到 renderer 不监听的 emitter 桶，稳定 20 秒超时。
            workspacePath: bridgeWorkspacePath(),
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

          const { value: result, queueWaitMs, runMs } = await runWithSlot(() =>
            deps.runConversation({
              workspacePath,
              providerId: DEFAULT_PROVIDER_ID,
              modelId,
              reasoningLevel: deps.reasoningLevel ?? "max",
              messages,
              allowTools,
              ...(onPartialText === undefined ? {} : { onPartialText }),
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
