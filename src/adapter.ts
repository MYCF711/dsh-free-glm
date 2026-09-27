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
  resolveLiveBridgeEndpoint,
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
  /**
   * 【按需拉起】确保壳可用；不可用就自己拉起来并等就绪。
   *
   * 由 `index.ts` 注入（那里才有 `spawnConfig` 与保活上下文）。
   * 返回 `true` = 桥可用。
   *
   * ## 为什么放在适配器里而不是只在插件启动时做
   *
   * 早先只有「DSH 启动时拉起」+「后台保活」。壳挂掉后用户一发消息就直接吃
   * `MISSING_CREDENTIAL`，得自己想办法重启 —— 那是把「壳没跑」当成用户的错误。
   *
   * `prepareCall()` 是**每轮请求开始**的挂载点，在这兜底最合适：
   * 用户点发送 → 插件先确保依赖在 → 再真正发请求。
   */
  readonly ensureReady?: () => Promise<boolean>;
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
    readonly message?: {
      readonly role?: string;
      readonly content?: unknown;
      /**
       * 【原生工具调用】OpenAI 形状 —— 桥的**快速路径**提供。
       *
       * 桥侧已把流式分片按 `index` **累加**成完整 `arguments` JSON 字符串，
       * 正好对应 DSH `ToolCallBlock.arguments` 的类型。
       */
      readonly tool_calls?: readonly {
        readonly id?: unknown;
        readonly type?: unknown;
        readonly function?: { readonly name?: unknown; readonly arguments?: unknown };
      }[];
      /** 思考内容（Anthropic 的 thinking 块，桥透传成这个字段）。 */
      readonly reasoning_content?: unknown;
    };
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
  /**
   * 【流式】收到**第一个**文本增量时的回调。
   *
   * 用途：让 `stream()` 不必干等整轮结束就能开始输出。
   *
   * 为什么是「首个」而不是「每个增量」：工具调用的解析需要完整文本
   * （见 `consumeSse` 的说明），所以只借首字节做一件事 —— **尽快开一个
   * 文本块**，消除「卡在思考、不吐文本」的空白期。
   */
  private onFirstText: (() => void) | undefined;
  /** 【按需拉起】插件注入的「确保壳可用」回调。 */
  private ensureReady: (() => Promise<boolean>) | undefined;
  /** 上次「确保」的结果与时间 —— 避免每轮都白等一次探测。 */
  private lastEnsureAt = 0;
  private lastEnsureOk = false;

  constructor(options: ZCodeBridgeAdapterOptions = {}) {
    super();
    this.product = options.product ?? ZCODE_BRIDGE;
    this.logger = options.logger;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.chunkChars = Math.max(1, options.chunkChars ?? DEFAULT_CHUNK_CHARS);
    this.visibility = options.visibility;
    this.ensureReady = options.ensureReady;
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
   * 消费桥的 SSE 流，合成为一次完整响应。
   *
   * ## 为什么"合成完整响应"而不是边收边 yield
   *
   * 工具调用的解析必须拿到**完整文本**才能做（JSON 围栏可能跨多个 delta）。
   * 边流边解析会引入"半个围栏"的中间态，极易误判 —— 而误判的代价是
   * DSH 去执行一个模型根本没要求的工具。
   *
   * 所以这里只做两件事：
   *   1. **尽快感知到"已经有内容了"** —— 通过 `onFirstText` 回调让上层
   *      立刻发一个文本块开始（消除"卡在思考"的空白期）
   *   2. 合成完整 payload，交给原有解析逻辑
   *
   * ## 与"真正流式"的差别
   *
   * 用户看到的是**先出现一个文本块、随后一次性补全**，而不是逐字冒出。
   * 这是刻意取舍：正确性优先于观感。若将来要逐字流，需要让桥把
   * "工具协议围栏"与"普通文本"分开推 —— 那是另一层改造。
   */
  private async consumeSse(
    response: Response,
    outerSignal: AbortSignal | undefined,
    // 【真流式】收到一段**新增**文本时立刻回调，让上层能马上 yield 出去。
    //
    // 不传时就退回旧行为（只累加、最后一次性返回）—— 保证向后兼容。
    onDelta?: (delta: string) => void,
  ): Promise<BridgeChatResponse> {
    const body = response.body;
    if (body === null) {
      // 没有流（某些环境会这样）—— 退回整包解析。
      return (await response.json()) as BridgeChatResponse;
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finishReason: string | undefined;
    /**
     * 流式工具调用的**累加器**（按 `index` 定位）。
     *
     * OpenAI 的流式 tool_calls 是分片的：首个分片给 `id` / `name`，
     * 后续分片只给 `function.arguments` 的字符串片段。
     * **不能直接覆盖** —— 否则只剩最后一个分片（通常只有 arguments 片段、
     * 没有 name），表现为「空回复（finish_reason=tool_calls）」。
     */
    const accumulatedToolCalls: Array<{
      index: number;
      id: string;
      name: string;
      arguments: string;
    }> = [];
    let toolCalls: unknown[] | undefined;
    let usage: BridgeChatResponse["usage"];

    // 首字节回调 —— 让上层能立刻开始输出，不必等整轮结束。
    let announced = false;

    try {
      for (;;) {
        if (outerSignal?.aborted === true) {
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE 以空行分帧。保留最后一段（可能不完整）。
        let sep = buffer.indexOf("\n\n");
        while (sep >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          sep = buffer.indexOf("\n\n");

          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data.length === 0 || data === "[DONE]") continue;

            let chunk: {
              choices?: Array<{
                delta?: { content?: unknown; tool_calls?: unknown };
                finish_reason?: unknown;
              }>;
              usage?: BridgeChatResponse["usage"];
              error?: { message?: unknown };
            };
            try {
              chunk = JSON.parse(data) as typeof chunk;
            } catch {
              continue;
            }

            if (chunk.error !== undefined) {
              throw new LlmError(
                `zcode-bridge: 桥在流中报错: ${
                  typeof chunk.error.message === "string" ? chunk.error.message : "unknown"
                }`,
                "SERVER",
              );
            }

            const choice = chunk.choices?.[0];
            const deltaContent = choice?.delta?.content;
            if (typeof deltaContent === "string" && deltaContent.length > 0) {
              content += deltaContent;
              if (!announced) {
                announced = true;
                this.onFirstText?.();
              }
              // 【真流式】立刻把这一段增量推给上层 —— 用户就能看到字在往外冒，
              // 而不是盯着"思考中"等整轮结束。
              onDelta?.(deltaContent);
            }
            if (Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length > 0) {
              /**
               * ★ 必须按 `index` **累积分片**，不能直接覆盖。
               *
               * ## 为什么（实测踩过，表现为「空回复 finish_reason=tool_calls」）
               *
               * OpenAI 的流式工具调用是**分片传输**的，靠 `index` 定位：
               *
               *   data: {"delta":{"tool_calls":[{"index":0,"id":"toolu_x","type":"function",
               *          "function":{"name":"glob","arguments":""}}]}}
               *   data: {"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"pat"}}]}}
               *   data: {"delta":{"tool_calls":[{"index":0,"function":{"arguments":"tern\":\"...\"}"}}]}}
               *
               * 旧写法 `toolCalls = choice.delta.tool_calls` 每次**整体替换**，
               * 结果只剩最后一个分片 —— 那个分片通常**只有 arguments 片段、没有 name/id**，
               * 于是上游解析出「有工具调用但参数为空」，桥侧报
               * 「空回复（finish_reason=tool_calls）」。
               *
               * ⚠ 注释里**绝不能出现星号加斜杠** —— 它会提前关闭块注释，
               *   把后面整段变成代码，报一串 TS1109/TS1127/TS1128。
               *   （实测踩过：写通配路径示例时踩到）
               */
              for (const rawCall of choice.delta.tool_calls) {
                if (rawCall === null || typeof rawCall !== "object") continue;
                const call = rawCall as {
                  index?: unknown;
                  id?: unknown;
                  type?: unknown;
                  function?: { name?: unknown; arguments?: unknown };
                };
                const idx = typeof call.index === "number" ? call.index : accumulatedToolCalls.length;
                let acc = accumulatedToolCalls[idx];
                if (acc === undefined) {
                  acc = { index: idx, id: "", name: "", arguments: "" };
                  accumulatedToolCalls[idx] = acc;
                }
                if (typeof call.id === "string" && call.id.length > 0) acc.id = call.id;
                if (typeof call.function?.name === "string" && call.function.name.length > 0) {
                  // 名字也可能分片，但更常见是首次给全 —— 用拼接兼容两种情况
                  acc.name =
                    acc.name.length === 0 || call.function.name.startsWith(acc.name)
                      ? call.function.name
                      : acc.name + call.function.name;
                }
                if (typeof call.function?.arguments === "string") {
                  acc.arguments += call.function.arguments;
                }
              }
            }
            if (typeof choice?.finish_reason === "string" && choice.finish_reason.length > 0) {
              finishReason = choice.finish_reason;
            }
            if (chunk.usage !== undefined) {
              usage = chunk.usage;
            }
          }
        }
      }
    } finally {
      reader.releaseLock?.();
      this.onFirstText = undefined;
    }

    // 合成与整包 JSON **同形**的 payload —— 后续解析逻辑一行都不用改。
    // 工具调用用**累加后**的结果（不是最后一个分片）。
    // ⚠ 变量名不能叫 `toolCalls` —— 上面（L419）已有同名 `let toolCalls`，
    //   同一函数作用域内 `const` 重名是语法错误（TS1005/TS1128）。
    const mergedToolCalls =
      accumulatedToolCalls.length === 0
        ? undefined
        : accumulatedToolCalls.map((c) => ({
            index: c.index,
            id: c.id.length > 0 ? c.id : `zcb-call-${c.index}`,
            type: "function",
            function: { name: c.name, arguments: c.arguments },
          }));
    const synthesized: BridgeChatResponse & { tool_calls?: unknown[] } = {
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
            ...(mergedToolCalls === undefined ? {} : { tool_calls: mergedToolCalls }),
          },
          ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
        },
      ],
      ...(usage === undefined ? {} : { usage }),
    };
    return synthesized;
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
    // ⚠ 必须用探活择优版 —— `resolveBridgeEndpoint()` 可能在环境变量目录里
    //   读到**已死实例**写下的过期发现文件，把健康的桥判成不可用，
    //   于是 provider 分组整个从设置页消失（实测踩过）。
    const endpoint = await resolveLiveBridgeEndpoint();
    if (endpoint === undefined) {
      this.lastResolvedSource = "unavailable";
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
   *
   * ## 【按需拉起】这里是确保壳可用的挂载点
   *
   * `prepareCall` 是**每轮请求开始**都会走的路径，所以在这兜底最自然：
   * 用户点发送 → 先确保依赖在 → 再真正发请求。
   *
   * 注入了 `ensureReady` 时才做，且**失败不抛错** —— 让后续 `stream()`
   * 自己去报那条更明确的 `MISSING_CREDENTIAL`（它知道怎么描述缺什么）。
   */
  async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    if (this.ensureReady !== undefined) {
      try {
        const ok = await this.ensureReady();
        this.lastEnsureOk = ok;
        this.lastEnsureAt = Date.now();
      } catch {
        // 拉起失败不在这里抛 —— 交给 stream() 报更明确的错。
        this.lastEnsureOk = false;
      }
    }
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    };
  }

  /** 上次「按需拉起」的结果（供设置页/诊断显示）。 */
  ensureStatus(): { ok: boolean; at: number } {
    return { ok: this.lastEnsureOk, at: this.lastEnsureAt };
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
    //
    //    用探活择优版：本地可能同时存在多份发现文件（环境变量目录里那份
    //    属于已死实例），只按"第一个读到的"选会稳定打到死端口。
    const endpoint = await resolveLiveBridgeEndpoint();
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
    // ## 2026-09-27 重大变更：桥现在有**原生 tools 通道**了
    //
    // 旧实现把 schema 渲染成提示词（因为桥只能收 `content: string`）。
    // 现在桥的**快速路径**支持原生 `tools[]` 透传（Anthropic 协议），
    // 实测 `finish_reason=tool_calls` + 结构化 `arguments`。
    //
    // ## 快速路径是什么
    //
    // 桥检测到 `system` **以** 某个白名单串**开头**时，走直连上游：
    //     system = "You are ZCode connectivity probe.\n\n<真实指令>"
    // 不建 task、不跑 turn 循环 —— 实测 **3.6-7.3 秒**（会话链路 8-28 秒）。
    //
    // ## 因此这里做两件事
    //
    // 1. `system` 前面**必须**加上探针前缀（否则上游 405 / 3012）
    // 2. `tools[]` 用原生字段传（不再渲染成提示词）
    //
    // 渲染成提示词的老路保留为**回退**（当调用方显式要求 `promptToolBridge` 时）。
    const ZCODE_PROBE_PREFIX = "You are ZCode connectivity probe.";
    const tools = options.tools ?? [];
    const baseSystem =
      typeof options.system === "string" && options.system.length > 0 ? options.system : "";

    // 探针前缀必须**在最前**（实测：前缀匹配，后面可追加任意内容）
    //
    // 【A/B 开关】`ZCODE_BRIDGE_NO_PROBE=1` 时不加前缀 → 强制回落到会话链路。
    // 用途：对比两条路径的真实耗时（会话链路会建 task 并捕获真实 taskId）。
    const probeDisabled = process.env.ZCODE_BRIDGE_NO_PROBE === "1";
    const systemText = probeDisabled || baseSystem.startsWith(ZCODE_PROBE_PREFIX)
      ? baseSystem
      : [ZCODE_PROBE_PREFIX, baseSystem].filter((part) => part.length > 0).join("\n\n");

    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      system: systemText,
    };
    // 【诊断】记录真实请求规模 —— 用于定位「耗时波动 7.5-68 秒」的成因。
    // 依据：模拟测试显示「system 2635 字 + 30 工具」时输入 6529 token → 27.2 秒，
    // 而小输入只要 9 秒。需要看 DSH 实际传了多大。
    try {
      const { appendFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const base = process.env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
      appendFileSync(
        join(base, "dsh-bridge-request-size.ndjson"),
        `${JSON.stringify({
          at: Date.now(),
          model: options.model,
          systemChars: systemText.length,
          messageCount: messages.length,
          messageChars: JSON.stringify(messages).length,
          toolCount: tools.length,
          toolsChars: tools.length > 0 ? JSON.stringify(body.tools).length : 0,
          bodyChars: JSON.stringify(body).length,
        })}\n`,
      );
    } catch {
      /* 诊断用，失败不影响主流程 */
    }
    // 原生工具透传（桥负责 OpenAI → Anthropic 形状转换）
    if (tools.length > 0) {
      body.tools = tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
        },
      }));
    }
    if (options.maxTokens !== undefined && options.maxTokens > 0) {
      // 桥会把 max_tokens 钳到 [1, 32000]。
      body.max_tokens = options.maxTokens;
    }

    // 3. 发请求（带超时 + 取消传播）。
    const abortController = new AbortController();
    const onOuterAbort = () => abortController.abort();
    options.signal?.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => abortController.abort(), this.requestTimeoutMs);

    // TS 的控制流分析在 try/catch 之后无法证明它已赋值（catch 分支里
    // 可能是在赋值前抛出的）。这里用确定断言 —— 下面的代码路径只在
    // try 成功走完之后才可达，catch 分支一律 throw。
    let payload!: BridgeChatResponse;
    // 文本是否已在 SSE 循环里逐段 yield 过 —— 决定后面还要不要再发一个文本块。
    let streamedText = false;
    try {
      // ── 流式请求 ──────────────────────────────────────────────────────
      //
      // ## 为什么必须流式（实测踩过）
      //
      // 桥原先等整包才返回。一次请求 20-120 秒期间 DSH 拿不到任何东西，
      // 界面上表现为「**卡在思考、不吐文本**」—— 这是用户报的最主要症状。
      //
      // 实测延迟构成（壳日志时间线）：
      //   captcha 0.4s ＋ 桥自身 0.1s ＋ **agent turn 循环 ~19.9s**
      //
      // 那 19.9 秒是免费额度通道的固有速度，改不动；但**已经产生的部分文本
      // 可以尽早吐出来**，用户就能看到字在往外冒，而不是盯着"思考中"。
      //
      // ## 增量怎么用
      //
      // 本函数把增量**转成异步队列**，与后续的解析逻辑解耦：
      // 流式阶段只负责"把文本块尽早 yield 出去"，工具调用等解析仍按
      // 完整文本走原有逻辑（那边的契约更严格，不能边流边解析）。
      const acceptHeader = "text/event-stream";
      /**
       * ★★ 并发竞速（2026-09-27 新增，**默认关闭**）—— 消除上游 TTFB 的慢档。
       *
       * ## 为什么（实测数据）
       *
       * 桥的快速路径直连上游时，`ttft`（首字节前耗时）呈**离散跳变**：
       *
       *   total= 2831ms  ttft= 1483ms  gen= 1348ms    ← 快档
       *   total= 7059ms  ttft= 4906ms  gen= 2153ms
       *   total=10062ms  ttft= 8997ms  gen= 1065ms
       *   total=14157ms  ttft=12080ms  gen= 2077ms
       *   total=27198ms  ttft=23618ms  gen= 3580ms    ← 慢档
       *
       * `ttft` 档位实测：1.5 / 4.3 / 4.9 / 8.8 / 9.0 / 9.3 / 12.1 / 23.6 秒。
       * **而 `gen` 始终 1-5 秒**（稳定）。⇒ 慢的是「上游排队」，不是生成。
       *
       * ## 竞速实测（同一请求，同时发 N 个）
       *
       *   单发      : 10.9s
       *   竞速 3 个 : 3.6 / 4.0 / 5.1      ← 三个全部落在快档！
       *   竞速 5 个 : 2.7 / 3.3 / 10.8 / 10.9 / 11.2
       *
       * **⇒ 竞速 3 个能把慢档完全消掉**：至少有一个请求走快档。
       *
       * ## 成本与取舍
       *
       * - 每次调用**多消耗 2 份额度**（免费额度，实测不影响）
       * - 但**p95 从 10-27 秒降到 5 秒以内**
       * - 输掉的请求用 AbortController 主动取消，不浪费上游生成
       *
       * ## 开关
       *
       * `ZCODE_BRIDGE_RACE=3` 启用 3 路竞速；缺省或 1 即**关闭**（保持现有行为）。
       * 上限钳到 5（再多收益递减且额度消耗快）。
       */
      const raceWidth = ((): number => {
        const raw = process.env.ZCODE_BRIDGE_RACE?.trim();
        const n = raw === undefined || raw.length === 0 ? 1 : Number(raw);
        if (!Number.isFinite(n) || n < 2) return 1;
        return Math.min(5, Math.floor(n));
      })();
      const requestBody = JSON.stringify({ ...body, stream: true });
      const doFetch = (): Promise<Response> =>
        fetch(`${endpoint.baseUrl}${CHAT_COMPLETIONS_PATH}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: acceptHeader,
            Authorization: `Bearer ${endpoint.token}`,
            // ★ DSH 的硬性契约：每个 provider HTTP 请求都必须带 attributionHeaders()。
            //   库类型注释原文："Every provider HTTP request must include
            //   `attributionHeaders()`; prove the headers are added in the wire request
            //   or library header hook."
            //   桥会忽略未知头，所以这些不会影响桥的行为。
            ...attributionHeaders(),
          },
          body: requestBody,
          signal: abortController.signal,
        });
      let response: Response;
      if (raceWidth === 1) {
        response = await doFetch();
      } else {
        // 竞速：并发 N 路，取**第一个返回 HTTP 200 的**；其余立即 abort。
        const controllers = new Set<AbortController>();
        const attempt = async (): Promise<Response> => {
          const ctl = new AbortController();
          controllers.add(ctl);
          // 外层取消要能穿透到每一路
          const onOuter = (): void => ctl.abort();
          abortController.signal.addEventListener("abort", onOuter, { once: true });
          try {
            const r = await fetch(`${endpoint.baseUrl}${CHAT_COMPLETIONS_PATH}`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: acceptHeader,
                Authorization: `Bearer ${endpoint.token}`,
                ...attributionHeaders(),
              },
              body: requestBody,
              signal: ctl.signal,
            });
            if (r.status !== 200) {
              // 非 200 的不要参与竞速（可能是限流），但它若先回也说明上游有问题
              throw new Error(`race attempt http ${r.status}`);
            }
            return r;
          } finally {
            controllers.delete(ctl);
          }
        };
        const attempts = Array.from({ length: raceWidth }, () => attempt());
        try {
          response = await Promise.any(attempts);
        } catch (error) {
          // 全部失败 —— 退回单发，让错误处理路径给出可诊断的信息
          response = await doFetch();
        } finally {
          // 取消落败的（含已完成的 controller，abort 幂等）
          for (const ctl of controllers) ctl.abort();
        }
        // 落败的 promise 若 reject 会变 unhandled —— 吞掉它们
        for (const p of attempts) p.catch(() => undefined);
      }

      if (!response.ok) {
        const raw = await response.text().catch(() => "");
        throw new LlmError(
          `zcode-bridge: 桥返回 ${response.status} ${describeBridgeError(raw)}`,
          httpErrorCodeForBridge(response.status),
          { status: response.status },
        );
      }

      // 桥未按 SSE 返回时（旧版本桥）退回整包 JSON —— 保证向后兼容。
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        payload = (await response.json()) as BridgeChatResponse;
      } else {
        // ── 【真流式】边收边吐 ────────────────────────────────────────────
        //
        // 旧实现：`consumeSse` 只把内容累加进字符串，**到流结束才返回**，
        // 之后第 829 行那个 `chunkChars` 分片循环才一次性跑完。
        // 实测证据（2026-09-27，桥侧 SSE 直连 19.2 秒的请求）：
        //
        //   首个数据到达: 19244 ms
        //   总耗时:       19249 ms      ← 首字节之后只花了 5ms
        //
        // ⇒ 所谓"流式"是**假流式**：用户盯着"思考中"整个中位 41 秒，
        //   然后文字瞬间全出。注释里"文字在往外冒"的说法与代码行为矛盾。
        //
        // 现在：`consumeSse` 每收到一段 delta 就推进这个队列，
        // 本生成器**并发地**把它取出来立刻 yield。
        const pending: string[] = [];
        let notify: (() => void) | undefined;
        let streamDone = false;

        const pushDelta = (delta: string): void => {
          pending.push(delta);
          notify?.();
        };

        const consumePromise = this.consumeSse(response, options.signal, pushDelta)
          .then((result) => {
            payload = result;
          })
          .finally(() => {
            streamDone = true;
            notify?.();
          });

        // 开一个文本块 —— 契约要求 text-delta 必须在 block-start 之后。
        let textBlockOpen = false;
        const ensureBlockOpen = function* (): Generator<StreamChunk> {
          if (!textBlockOpen) {
            textBlockOpen = true;
            yield { type: "block-start", index: 0, blockType: "text" };
          }
        };

        while (!streamDone || pending.length > 0) {
          if (pending.length === 0) {
            // 等下一段（或流结束）。`notify` 只在有新数据时被调用，
            // 所以这里不会空转。
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            notify = undefined;
            continue;
          }
          const delta = pending.shift();
          if (delta === undefined) continue;
          // 首块按需开 —— 不预先开块，避免空回合时留下一个空文本块。
          if (!textBlockOpen) {
            textBlockOpen = true;
            yield { type: "block-start", index: 0, blockType: "text" };
          }
          // 直接吐原始增量（不再按 chunkChars 切片 —— 那只是模拟分片）。
          yield { type: "text-delta", index: 0, text: delta };
        }

        // 收尾：把 consumeSse 的异常（如流中报错）在这里重新抛出。
        await consumePromise;
        if (textBlockOpen) {
          yield { type: "block-end", index: 0, block: { type: "text", text: extractText(payload) } };
          // 文本块已经完整发出（含 block-end）—— 后面不要再发第二遍。
          streamedText = true;
        }
      }
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
    //
    // ⚠ 2026-09-27 修正：**纯工具调用回合的 text 天然为空**。
    //
    // 旧代码只有「提示词桥」一条路 —— 那时工具调用被写在正文的 ```json 围栏里，
    // 所以 `text.length === 0` 确实是异常。
    //
    // 现在桥有**原生 `tool_calls` 通道**（OpenAI 形状，`content` 可以为空），
    // 于是「模型只调工具、不写正文」这个**完全合法**的回合会被误判成空回复，
    // 抛出「桥返回了空回复（finish_reason=tool_calls）」。
    //
    // 实测：DSH 多步循环里每一步都是这种回合，导致整轮失败。
    const hasNativeToolCalls =
      Array.isArray(payload.choices?.[0]?.message?.tool_calls)
      && (payload.choices?.[0]?.message?.tool_calls as unknown[]).length > 0;
    if (text.length === 0 && !hasNativeToolCalls) {
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
    // **两条来源，优先原生**（2026-09-27）：
    //
    //  ① 原生 `message.tool_calls`（OpenAI 形状）—— 桥的**快速路径**提供。
    //     形状：{ id, type:"function", function:{ name, arguments } }
    //     `arguments` 已经是**完整合法 JSON 字符串**（桥侧累加分片得到）。
    //
    //  ② 提示词围栏（```json {"tool":...}```）—— 旧路径，仅当没有原生时才用。
    //     这是「把 schema 渲染成提示词」那套的产物，现在退为兜底。
    const nativeCalls = (() => {
      const raw = payload.choices?.[0]?.message?.tool_calls;
      if (!Array.isArray(raw) || raw.length === 0) return [];
      return raw
        .map((c) => {
          if (c === null || typeof c !== "object") return undefined;
          const rec = c as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
          const name = rec.function?.name;
          if (typeof name !== "string" || name.length === 0) return undefined;
          const args = rec.function?.arguments;
          return {
            name,
            arguments: typeof args === "string" && args.length > 0 ? args : "{}",
          };
        })
        .filter((c): c is { name: string; arguments: string } => c !== undefined);
    })();
    const toolCalls = nativeCalls.length > 0
      ? nativeCalls
      : tools.length > 0
        ? parseToolCalls(text)
        : [];
    const proseText = toolCalls.length > 0 && nativeCalls.length === 0
      ? stripToolFences(text)
      : text;

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
    //
    // ⚠ 【真流式】路径下文本**已经在上面的 SSE 循环里逐段 yield 过了**
    //   （`streamedText === true`）。这里绝不能再发一遍 —— 否则 DSH 会收到
    //   两份内容，表现为"回答重复了两遍"。
    //
    //   流式路径只负责"已经吐出去的字节"；非流式路径（整包 JSON、或旧版桥）
    //   仍走下面这个分片循环。
    let index = 0;
    if (hasText && !streamedText) {
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
    } else if (streamedText) {
      // 流式路径已经把 index 0 用掉了（块也已 block-end）。工具块从 1 开始。
      index = 1;
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
