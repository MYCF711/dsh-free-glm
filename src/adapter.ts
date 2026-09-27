/**
 * ZCode 桥适配器。
 *
 * ## 与其它 provider 的根本差别
 *
 * 上游**不是**标准 OpenAI SSE 服务，而是一个**非流式的本地桥**：
 *
 *   请求  POST http://127.0.0.1:<port>/v1/chat/completions
 *   响应  {"choices":[{"message":{"content":"..."},"finish_reason":"stop"}], "usage":{...}}
 *
 * 实测确认（`bridge-e2e` / `probe`）：
 *   - 传 `stream: true` 被**忽略** —— 始终返回 application/json 整包
 *   - `usage` 恒为 `{prompt_tokens:0, completion_tokens:0, total_tokens:0}`
 *     （桥内部拿不到真实用量），所以**不上报 usage**，而不是报一堆 0
 *
 * 因此本适配器**不消费 SSE** —— 按 SSE 帧解析的读法喂给它一个 JSON 整包
 * 会一行都读不出来（表现为模型不说话）。桥返回什么就整包 JSON 解析。
 *
 * ⚠ 本插件**没有** SSE 消费代码。早先版本从其它 provider 适配器抄来了一份
 *   `sse.ts` + `openai-compat.ts`（约 700 行），对本桥完全无用，已删除 ——
 *   留着会误导后来者以为"某个路径会走 SSE"。
 *
 * ## 做法
 *
 * 拿到整包后，把文本**切成片段**逐个 yield，合成 DSH 期望的流式形状。
 * 这样：
 *   1. 满足 `StreamChunk` 的顺序契约（block-start → delta* → block-end → finish）
 *   2. 用户在界面上能看到渐进输出，而不是干等十几秒后一次性出现
 *
 * 分片只是**呈现层**的模拟 —— 上游确实是一次性返回的。切分粒度取
 * 一个视觉上自然的折中值。
 *
 * ## 工具调用：提示词化桥接
 *
 * 桥**没有 `tools` 通道**（`sendPrompt` 只收 `content: string`，只有
 * `toolDenylist` 无 allowlist），所以无法把 DSH 的 `tools[]` 透传给上游。
 *
 * 做法（见 `tool-bridge.ts`）：
 *   1. 把 `tools[]` 渲染成提示词，追加到 system 段
 *   2. 与模型约定输出 ```json 围栏包裹的 `{"tool":...,"arguments":{...}}`
 *   3. 在 `stream()` 里解析回复，命中则**合成** `tool-call` 块序列
 *   4. 有工具调用时 `finish` 用 `{ kind: 'tool-calls' }`
 *
 * 实测（GLM-5.3-Flash，19 秒）模型一次命中且格式完全正确。
 * 契约只约束 chunk 序列，不关心工具调用是谁产生的，所以这条路径合法。
 */

import { randomUUID } from "node:crypto";

import { LlmAdapter, LlmError, attributionHeaders, ToolCallId } from "@deepseek-ai/dsh-llm";
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  ToolCallBlock,
} from "@deepseek-ai/dsh-llm";

import { isTransportError } from "./transport-error.js";
import { parseToolCalls, renderToolInstructions, stripToolFences } from "./tool-bridge.js";
import {
  CHAT_COMPLETIONS_PATH,
  MODELS,
  ZCODE_BRIDGE,
  type ZCodeBridgeProduct,
} from "./product.js";
import {
  probeBridge,
  resolveBridgeEndpoint,
} from "./bridge-endpoint.js";
import type { ZCodeBridgeEndpoint } from "./product.js";
import type { ModelVisibility } from "./model-visibility.js";

/** 适配器构造参数。 */
export interface ZCodeBridgeAdapterOptions {
  /** 产品描述对象；省略用 {@link ZCODE_BRIDGE}。 */
  readonly product?: ZCodeBridgeProduct;
  /** 日志（DSH 的 ctx.logger 兼容签名）。 */
  readonly logger?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  /** 单次请求的总超时（毫秒）。桥侧默认 180s，这里留余量。 */
  readonly requestTimeoutMs?: number;
  /** 文本分片大小（字符）。仅影响呈现粒度。 */
  readonly chunkChars?: number;
  /**
   * 模型可见性（拨动开关）。
   *
   * 注入后 `listModels()` 会按黑名单过滤；设置页通过 `listAllModels()`
   * 拿全量目录来渲染开关。省略则不过滤（headless/CLI profile 无需开关）。
   */
  readonly visibility?: ModelVisibility;
}

/**
 * 单次请求的默认超时。
 *
 * 实测：`GLM-5.3` 冷启动约 14-18 秒，`GLM-5.3-Flash` 约 3-15 秒；
 * 桥自身默认 180 秒超时。取 240 秒留出余量 —— 太短会在大提示词上误杀，
 * 太长则用户取消后要干等。
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 240_000;

/**
 * 文本分片粒度。
 *
 * 桥的回复动辄上千字符，一次性 yield 会让界面从空白直接跳到全文。
 * 8 个字符在 60fps 下视觉上已足够连续，且不会产生过多 yield。
 */
const DEFAULT_CHUNK_CHARS = 8;

/** 桥返回的 OpenAI 兼容响应形状（只声明用到的字段）。 */
interface BridgeChatResponse {
  readonly id?: string;
  readonly model?: string;
  readonly choices?: readonly {
    readonly index?: number;
    readonly message?: { readonly role?: string; readonly content?: unknown };
    readonly finish_reason?: string;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
}

/**
 * 把桥的 `finish_reason` 映射到 DSH 的结束原因。
 *
 * 桥目前只会给 `stop`（或 null）；其余值按"正常结束"处理 —— 报错会让
 * 用户看到无谓的失败标记，而内容其实是完整的。
 */
function mapFinishReason(raw: unknown): { kind: "stop" } | { kind: "max-tokens" } {
  return raw === "length" || raw === "max_tokens" ? { kind: "max-tokens" } : { kind: "stop" };
}

/** 从响应里抽出助手文本。 */
function extractText(payload: BridgeChatResponse): string {
  const content = payload.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

/**
 * 把 DSH 的消息序列转成桥接受的形式。
 *
 * ⚠ 桥的 `normalizeMessages` 只认 `content` 为**字符串**的消息，其余一律丢弃。
 * 所以这里做一次显式降级，把 DSH 的结构化块**降级成文本**：
 *
 *   - 文本块        → 直接拼进 content
 *   - 工具调用块    → 还原成模型自己的 ```json 围栏格式（**与提示词协议对齐**）
 *   - 工具结果块    → 转成 `[tool-result name] <内容>` 一行
 *   - 图片块        → 转成 `[image]` 占位（桥不支持；目录也没声明 image）
 *
 * ## 为什么工具调用历史要还原成围栏格式（实测踩过的坑）
 *
 * 模型看到的工具调用历史**必须与它被要求输出的格式一致**。早先把历史里的
 * 工具调用降级成 `[tool-call name] {...}` 这种自造格式，结果是模型看到了
 * 两种互相矛盾的"工具调用长什么样"，转而模仿历史格式 → 解析器认不出 →
 * 表现为"模型说它调用了工具，但 DSH 这边什么都没发生"。
 *
 * 用同一个围栏格式，历史就是一个完整的few-shot 示范。
 *
 * ## 为什么工具块必须保留（实测踩过的坑）
 *
 * 早先这里把工具块**整块丢掉**。但 DSH 的 agent 每一轮都会发上一轮的工具
 * 调用与结果 —— 全丢掉意味着模型**看不到自己的工具返回了什么**，
 * 于是只能凭空编造下一步，表现为"模型胡说八道 / 任务无法推进"。
 *
 * 桥没有 `tools` 通道（`sendPrompt` 只接受 `toolDenylist`，无 allowlist），
 * 所以**无法**让模型真正发起工具调用；但把历史工具往返降级成文本、
 * 让模型**知道**之前发生了什么，是可行且必需的 —— 否则多轮对话直接崩。
 *
 * 一律不丢弃：丢一段上下文看起来"温和"，代价是模型在错误前提上继续推理。
 */
function toBridgeMessages(
  messages: GenerateOptions["messages"],
): { role: "user" | "assistant"; content: string }[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const message of messages) {
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = message.content;

    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        const record = block as {
          type?: unknown;
          text?: unknown;
          name?: unknown;
          input?: unknown;
          content?: unknown;
          isError?: unknown;
        };
        switch (record.type) {
          case "text":
            if (typeof record.text === "string") {
              parts.push(record.text);
            }
            break;
          case "tool-call": {
            const name = typeof record.name === "string" ? record.name : "unknown";
            // DSH 的工具调用历史里 `input` 可能是对象，也可能是**已序列化的 JSON 字符串**
            // （取决于它从哪条路径投影过来）。两种都要还原成对象再放进围栏，
            // 否则会出现 `"arguments":"{\"path\":\"x\"}"` 这种双层转义的畸形示范。
            const args = coerceArguments(record.input);
            // 还原成模型自己的输出格式 —— 见函数头注释：历史必须是 Few-shot 示范，
            // 用另一种格式会让模型模仿错的形状，解析器认不出。
            parts.push("```json\n" + safeJson({ tool: name, arguments: args }) + "\n```");
            break;
          }
          case "tool-result": {
            const name = typeof record.name === "string" ? record.name : "unknown";
            const body = flattenToolResult(record.content);
            const flag = record.isError === true ? " (error)" : "";
            parts.push(`[tool-result ${name}${flag}] ${body}`);
            break;
          }
          case "image":
            parts.push("[image]");
            break;
          default:
            // 未知块类型：能抽出文本就抽，抽不出就忽略 —— 但要保留已收集的部分。
            if (typeof record.text === "string" && record.text.length > 0) {
              parts.push(record.text);
            }
            break;
        }
      }
      text = parts.join("\n");
    }

    if (text.length === 0) {
      // 空消息会让桥那边的拼装产生 "User: " 这样的空行，对模型是噪音。
      continue;
    }
    out.push({ role, content: text });
  }
  return out;
}

/** 把工具参数规整成对象：字符串先尝试 parse，失败则原样包成 `{ raw }`。 */
function coerceArguments(input: unknown): unknown {
  if (typeof input !== "string") {
    return input ?? {};
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return {};
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    // 不是合法 JSON —— 保留原文而不是丢弃，让模型至少看得到它自己写过什么。
    return { raw: input };
  }
}

/** 把工具结果的嵌套 content 压成一行文本。 */
function flattenToolResult(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return safeJson(content);
  }
  const parts: string[] = [];
  for (const block of content) {
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    } else if (record.type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("\n");
}

/** JSON 化，失败时退回 String()。工具参数可能是任意值。 */
function safeJson(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

export class ZCodeBridgeAdapter extends LlmAdapter {
  private readonly product: ZCodeBridgeProduct;
  private readonly logger: ZCodeBridgeAdapterOptions["logger"];
  private readonly requestTimeoutMs: number;
  private readonly chunkChars: number;
  /** 最近一次成功解析的端点 —— 仅供诊断输出，不作为请求路径的缓存依据。 */
  private lastResolvedSource: string = "unknown";
  /** 桥播报的模型集（`undefined` = 采信静态全表）。 */
  private advertisedModelIds: Set<string> | undefined;
  /** 模型可见性（拨动开关）。未注入时不过滤。 */
  private visibility: ModelVisibility | undefined;

  constructor(options: ZCodeBridgeAdapterOptions = {}) {
    super();
    this.product = options.product ?? ZCODE_BRIDGE;
    this.logger = options.logger;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.chunkChars = Math.max(1, options.chunkChars ?? DEFAULT_CHUNK_CHARS);
    this.visibility = options.visibility;
  }

  /** 生命周期钩子：注册后调用，可空。 */
  start(): void {
    // 不做预热：探活是廉价的（毫秒级），放在 listModels 里按需做，
    // 避免插件加载阶段就去碰一个可能还没起来的桥。
  }

  /** 生命周期钩子：dispose 时调用，可空。 */
  dispose(): void {
    // 无自建资源需要释放。
  }

  /** 当前端点的来源（`env` / `discovery-file` / `unavailable`），供诊断。 */
  endpointSource(): string {
    return this.lastResolvedSource;
  }

  /**
   * provider 信息。
   *
   * ⚠ `id` 必须等于注册时用的路由名，否则 DSH 校验失败。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === "string" && provider.length > 0 ? provider : this.product.id;
    return { id, name: this.product.displayName };
  }

  /**
   * 模型目录（**已按开关过滤**）。
   *
   * **桥不可用时返回 `[]`，绝不抛错** —— 抛错会在界面上变成一条 provider
   * 失败记录；返回空数组会让 DSH 把整个分组过滤掉，视觉上就是"没这个
   * provider"，这才是"ZCode 没启动"应有的表现。
   *
   * ⚠ **每次都实时读黑名单，绝不能缓存过滤结果** —— 这是「拨动开关即时生效」
   *   的全部机制。对话框的模型选择器每次打开都会调本方法，读到的是最新副本。
   */
  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠ 先确认桥可用 —— 这是「桥不在就隐藏整个分组」的门控。
    //
    // 早先这里直接返回目录、不做探活：ZCode 没跑时模型选择器里会留下一个
    // 点不动的 provider，用户选中后才在请求阶段报 MISSING_CREDENTIAL。
    // 探活是 loopback 毫秒级调用，放在这里完全可接受。
    if (!(await this.refreshCatalog())) {
      return [];
    }

    const all = this.listAllModels();
    const disabled = this.visibility?.disabledFor(this.product.id);
    if (disabled === undefined || disabled.size === 0) {
      return all;
    }
    return all.filter((model) => !disabled.has(model.id));
  }

  /**
   * 全量模型目录（**不受开关影响**）。
   *
   * 为什么要单独提供：`listModels()` 返回的目录已被黑名单过滤，
   * 若设置页拿它来渲染开关，被关闭的模型会**连开关一起消失**，
   * 用户再也无法重新打开它。
   *
   * `ctx.llm` 不透传自定义方法（只保证 `listModels`），所以设置页必须
   * 自己持有适配器实例来调本方法 —— 见 `getRegisteredZCodeBridgeAdapter()`。
   *
   * 同步方法（无 IO）：目录来自静态表 + 桥的探活结果缓存，UI 需要立刻拿到。
   */
  listAllModels(): readonly LlmModelInfo[] {
    // 优先采信桥自己播报的模型（实例升级/换 provider 时自动跟随）；
    // 桥没报（env 覆盖来源）时退回静态表。
    const advertised = this.advertisedModelIds;
    return MODELS.filter((model) => advertised === undefined || advertised.has(model.id)).map(
      (model) => ({
        provider: this.product.id,
        id: model.id,
        name: model.name,
        inputModalities: ["text"] as const,
      }),
    );
  }

  /**
   * 刷新桥播报的模型集，并返回桥是否可用。
   *
   * 由 `listModels()` / 设置页调用；结果缓存在 `advertisedModelIds`，
   * 让同步的 `listAllModels()` 也能拿到。
   */
  async refreshCatalog(): Promise<boolean> {
    const endpoint = resolveBridgeEndpoint();
    if (endpoint === undefined) {
      this.lastResolvedSource = "unavailable";
      this.advertisedModelIds = undefined;
      return false;
    }
    const alive = await probeBridge(endpoint);
    if (!alive) {
      this.lastResolvedSource = `${endpoint.source}:unreachable`;
      this.advertisedModelIds = undefined;
      return false;
    }
    this.lastResolvedSource = endpoint.source;
    this.advertisedModelIds =
      endpoint.models.length > 0 ? new Set(endpoint.models) : undefined;
    return true;
  }

  /** 解析单个模型的能力与窗口。 */
  async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const known = MODELS.find((entry) => entry.id === model);
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: known?.name ?? model,
      inputModalities: ["text"],
    };
    if (known?.contextWindow !== undefined) {
      resolved.context = { contextWindow: known.contextWindow };
    }
    if (known?.maxTokens !== undefined) {
      resolved.defaultMaxTokens = known.maxTokens;
    }
    return resolved;
  }

  /**
   * 兼容 shim。
   *
   * 新版 `LlmRuntime.prepareCall()` 会调用 `registration.adapter.prepareCall(...)`；
   * 基类缺该方法时每轮请求开始会抛 `prepareCall is not a function`。
   * Jet Hub 的 zcode / qoder / buddy 三处都是同款写法。
   */
  async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    };
  }

  /**
   * 执行一次对话。
   *
   * 顺序契约（DSH 强制）：block-start → text-delta* → block-end → finish。
   * finish 之后不得再 yield。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 1. 解析端点。缺失即明确报错 —— stream 是请求路径，
    //    静默产空流会让用户看到"模型不说话"而无从排查。
    const endpoint = resolveBridgeEndpoint();
    if (endpoint === undefined) {
      throw new LlmError(
        "zcode-bridge: 找不到 ZCode 桥。请确认 ZCode 实例正在运行，"
          + "且以 ZCODE_BRIDGE=1 启动（桥会把端口写到 "
          + "<dataBaseDir>/.zcode/v2/bridge-port.json，缺省 dataBaseDir 为家目录）。"
          + "也可用环境变量 ZCODE_BRIDGE_BASE_URL + ZCODE_BRIDGE_TOKEN 显式指定。",
        "MISSING_CREDENTIAL",
      );
    }

    // 2. 组请求体（OpenAI chat-completions 形状）。
    const messages = toBridgeMessages(options.messages);

    // ── 工具表注入 ────────────────────────────────────────────────────────
    //
    // 桥没有 tools 通道，所以把 schema 渲染成提示词追加到 system 段。
    // 追加而不是覆盖：DSH 的 system 段里有 agent 的完整行为规范，不能丢。
    const tools = options.tools ?? [];
    const toolInstructions = renderToolInstructions(tools);
    const baseSystem =
      typeof options.system === "string" && options.system.length > 0 ? options.system : "";
    const systemText =
      toolInstructions.length === 0
        ? (baseSystem.length > 0 ? baseSystem : undefined)
        : [baseSystem, toolInstructions].filter((part) => part.length > 0).join("\n\n");

    const body: Record<string, unknown> = {
      model: options.model,
      messages: [
        ...(systemText === undefined ? [] : [{ role: "system", content: systemText }]),
        ...messages,
      ],
    };
    if (options.maxTokens !== undefined && options.maxTokens > 0) {
      // 桥会把 max_tokens 钳到 [1, 32000]。
      body.max_tokens = options.maxTokens;
    }

    // 3. 发请求（带超时 + 取消传播）。
    const abortController = new AbortController();
    const onOuterAbort = () => abortController.abort();
    options.signal?.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => abortController.abort(), this.requestTimeoutMs);

    let payload: BridgeChatResponse;
    try {
      const response = await fetch(`${endpoint.baseUrl}${CHAT_COMPLETIONS_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${endpoint.token}`,
          // ★ DSH 的硬性契约：每个 provider HTTP 请求都必须带 attributionHeaders()。
          //   库类型注释原文："Every provider HTTP request must include
          //   `attributionHeaders()`; prove the headers are added in the wire request
          //   or library header hook."
          //   桥会忽略未知头，所以这些不会影响桥的行为。
          ...attributionHeaders(),
        },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const raw = await response.text().catch(() => "");
        throw new LlmError(
          `zcode-bridge: 桥返回 ${response.status} ${describeBridgeError(raw)}`,
          httpErrorCodeForBridge(response.status),
          { status: response.status },
        );
      }
      payload = (await response.json()) as BridgeChatResponse;
    } catch (error) {
      if (error instanceof LlmError) {
        throw error;
      }
      if (options.signal?.aborted) {
        // 用户主动取消 —— 原样抛出，让 DSH 归为 aborted 而非失败。
        throw error;
      }
      if (isTransportError(error)) {
        throw new LlmError(`zcode-bridge: 传输错误: ${String(error)}`, "TRANSPORT", {
          cause: error as Error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onOuterAbort);
    }

    // 4. 合成流式输出。
    const text = extractText(payload);

    // ── 空文本必须报错，不能当"正常回复"发出去 ──────────────────────────
    //
    // 实测：桥在会话链路卡住时会**满 180 秒超时**，然后返回一个空 content
    // （日志里 `bridge.chat.completed {"durationMs":180214,"textLength":0}`）。
    // 早先这里把空文本当成正常回复，照发 block-start/block-end/finish ——
    // 结果是 DSH 收到一个**没有任何内容的成功回复**，界面上什么都不显示，
    // 用户看到的就是"点了发送没反应"，而且没有任何可排查的线索。
    //
    // 报错而不是静默：宁可让用户看到一条明确的失败，也不要一个静默的空回合。
    if (text.length === 0) {
      const finish = payload.choices?.[0]?.finish_reason;
      throw new LlmError(
        "zcode-bridge: 桥返回了空回复"
          + (typeof finish === "string" && finish.length > 0 ? `（finish_reason=${finish}）` : "")
          + "。常见原因：ZCode 实例的会话链路卡住并触发了 180 秒超时"
          + "（看壳日志里的 bridge.chat.completed：durationMs 接近 180000 且 textLength 为 0）。"
          + "可尝试重启 ZCode 实例。",
        "SERVER",
      );
    }

    // ── 工具调用解析 ──────────────────────────────────────────────────────
    //
    // 模型按提示词约定把工具调用写在 ```json 围栏里。解析出来后走工具块路径，
    // 并把围栏从文本里摘掉 —— 用户不该看到协议原文。
    const toolCalls = tools.length > 0 ? parseToolCalls(text) : [];
    const proseText = toolCalls.length > 0 ? stripToolFences(text) : text;

    // 纯工具调用回合（模型只给了围栏、没有自然语言）时文本块为空 ——
    // 这是合法的：DSH 允许一个回合只有 tool-call 块。
    const hasText = proseText.length > 0;

    if (!hasText && toolCalls.length === 0) {
      // 走到这里说明文本被剥空了但也没解析出工具调用 —— 只可能是模型
      // 给了一个能被 JSON.parse 但不是工具调用形状的围栏（如 `{"a":1}`）。
      // 此时保留原文当普通回复，总比发一个空回合好。
      const fallback = text.trim().length > 0 ? text : "";
      if (fallback.length === 0) {
        throw new LlmError(
          "zcode-bridge: 桥返回了空回复（解析后无可呈现内容）。可尝试重启 ZCode 实例。",
          "SERVER",
        );
      }
    }

    // 文本块 —— 只在有自然语言时才发。index 从 0 开始。
    let index = 0;
    if (hasText) {
      yield { type: "block-start", index, blockType: "text" };
      for (let offset = 0; offset < proseText.length; offset += this.chunkChars) {
        yield {
          type: "text-delta",
          index,
          text: proseText.slice(offset, offset + this.chunkChars),
        };
      }
      yield { type: "block-end", index, block: { type: "text", text: proseText } };
      index += 1;
    }

    // 工具块 —— 每个调用一个 index，连续递增。
    //
    // ★ 契约要点（dsh-llm 的 BlockAssembler 强制）：
    //   - `tool-call-delta` 的 `id` **必填**，留空会被兜底成 `call-${index}`，
    //     导致工具结果关联断裂
    //   - `name` 只在非空时带一次即可
    //   - `block-end` 的 `block` 要**浅拷贝**
    //   - `arguments` 必须是**完整合法 JSON 字符串**
    for (const call of toolCalls) {
      // ★ `ToolCallId` 是 branded 类型 —— 必须用库导出的构造器，不能 `as` 强转
      //   （强转在类型层面"过"了，但绕过了 brand 的唯一合法构造入口）。
      const id = ToolCallId(`zcb-${randomUUID()}`);
      yield { type: "block-start", index, blockType: "tool-call" };
      yield {
        type: "tool-call-delta",
        index,
        id,
        name: call.name,
        argumentsDelta: "",
      };
      yield { type: "tool-call-delta", index, id, argumentsDelta: call.arguments };
      const block: ToolCallBlock = {
        type: "tool-call",
        id,
        name: call.name,
        arguments: call.arguments,
      };
      yield { type: "block-end", index, block: { ...block } };
      index += 1;
    }

    // ⚠ 不上报 usage：桥的 usage 恒为 0（它拿不到真实用量）。
    //   上报 0 会让 DSH 的用量统计显示成"没消耗"，比不报更误导。

    // 有工具调用时结束原因必须是 `tool-calls`，否则 DSH 不会去执行工具。
    yield {
      type: "finish",
      reason:
        toolCalls.length > 0
          ? { kind: "tool-calls" }
          : mapFinishReason(payload.choices?.[0]?.finish_reason),
    };
  }
}
/** 从桥的错误响应里抽出可读信息（它用 OpenAI 的 error 包裹形状）。 */
function describeBridgeError(raw: string): string {
  if (raw.length === 0) {
    return "(empty body)";
  }
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown; type?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  } catch {
    // 非 JSON，直接用原文（截断，避免把整页 HTML 灌进错误信息）。
  }
  return raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
}

/** 把 HTTP 状态码映射到 DSH 的错误分类。 */
function httpErrorCodeForBridge(status: number): string {
  if (status === 401 || status === 403) {
    return "AUTH";
  }
  if (status === 429) {
    return "RATE_LIMIT";
  }
  if (status >= 500) {
    return "SERVER";
  }
  return "BAD_REQUEST";
}
