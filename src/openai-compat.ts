/**
 * OpenAI 兼容协议层的共享实现：消息序列化 + SSE 消费 + 错误归类。
 *
 * ## 为什么单独成模块
 *
 * `src/buddy-adapter.ts` 与 `src/lobsterai-adapter.ts` 各自内联了一套**完全同源**
 * 的逻辑（消息序列化约 200 行、SSE 消费约 230 行），差异只在 URL、请求头与
 * 少数厂商特有字段上。第三个 OpenAI 兼容 provider（qoder）若再复制一份，
 * 这三份实现会在后续修 bug 时逐渐分叉 —— 而它们处理的都是
 * **OpenAI 协议层的通用陷阱**（工具配对、null 字段、分片合并），与厂商无关。
 *
 * 因此本模块把这部分抽出来给 **qoder 适配器**使用。
 *
 * ⚠️ **既有适配器（buddy / lobsterai）刻意不改用它**：那两份实现已被大量
 * 单测与线上流量验证过，重构它们属于与本任务无关的高风险改动。若将来要
 * 统一，应作为独立任务并配以逐条对拍测试。
 *
 * ## 本模块承载的实测教训（逐条都有真实缺陷背景）
 *
 * - **`typeof x === 'string'` 而非 `!== undefined`**：真实 SSE 里一个模型要么走
 *   `content`、要么走 `reasoning_content`，**另一侧恒为 `null`**。只判 undefined
 *   会让 `.length` 在 null 上崩溃（表现为每轮对话第一帧就报
 *   `Cannot read properties of null`）。
 * - **工具配对剔除**：孤儿 tool_call / tool_result 会让后端 400，且坏历史被每次
 *   请求原样重放 —— 会话彻底报废。发出前剔除可让会话自愈。
 * - **`function.name` 只允许非空覆盖**：后续分片带空串 `""` 会清空已解析出的
 *   工具名 → `unknown tool ""`。
 * - **残缺参数不补 `{}`**：那会伪造出合法外观，让 harness 报 schema 错误而非
 *   重试；正确做法是判 `max-tokens` 让 dsh 重试。
 */

import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { isTruncatedArguments, normalizeToolArguments, readWithIdleTimeout, resolveToolPairing } from './sse.js'

/** 将消息内容载荷展平为纯文本字符串。 */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text: unknown } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
    .map((block) => String(block.text))
    .join('')
}

/** 工具结果内嵌图片的载体文本（与 buddy / lobsterai 适配器同名同义）。 */
export const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:'

/**
 * 把 harness 内容块转成 OpenAI 多模态 parts。
 *
 * 图片必须转成 `{type:'image_url', image_url:{url}}` —— 这是服务端**唯一**接受的
 * 形态：`{type:'image'}` 与裸 base64 字符串都返回 HTTP 500。
 *
 * 返回 `undefined` 表示「无图」；只要出现过图片块就一定返回数组（即便字节
 * 解析失败也留 `[image unavailable]` 占位符），以免图片被静默吞掉。
 *
 * 与 {@link collectImages} 对称地**递归**处理 `tool-result` 内层：收集侧是任意
 * 深度，序列化侧若只走一层，深层图片会被收进 refs 却在序列化时静默丢弃。
 */
export function userContentParts(
  content: readonly unknown[],
  imageUrls: ReadonlyMap<string, string>,
): Array<Record<string, unknown>> | undefined {
  const parts: Array<Record<string, unknown>> = []
  let hasImage = false
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as {
      type?: unknown
      text?: unknown
      attachment?: { attachmentId?: unknown }
      content?: unknown
    }
    if (block.type === 'text') {
      const text = String(block.text ?? '')
      if (text.length > 0) parts.push({ type: 'text', text })
      continue
    }
    if (block.type === 'image') {
      hasImage = true
      const url = block.attachment?.attachmentId === undefined
        ? undefined
        : imageUrls.get(String(block.attachment.attachmentId))
      // 解析不到字节时留占位文本，而不是静默吞掉整张图。
      parts.push(url === undefined
        ? { type: 'text', text: '[image unavailable]' }
        : { type: 'image_url', image_url: { url } })
      continue
    }
    if (block.type === 'tool-result' && Array.isArray(block.content)) {
      const inner = userContentParts(block.content, imageUrls)
      if (inner !== undefined) {
        hasImage = true
        parts.push(...inner)
      } else {
        // 内层无图：保留其文本，避免内容丢失。
        const text = contentToText(block.content)
        if (text.length > 0) parts.push({ type: 'text', text })
      }
    }
  }
  return hasImage && parts.length > 0 ? parts : undefined
}

/** 收集消息中的图片附件引用（含工具结果内嵌图片），按 attachmentId 去重。 */
export function collectImages(content: readonly unknown[], refs: Map<string, unknown>): void {
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as { type?: unknown; attachment?: { attachmentId?: unknown }; content?: unknown }
    if (block.type === 'image' && typeof block.attachment?.attachmentId === 'string') {
      refs.set(block.attachment.attachmentId, block.attachment)
      continue
    }
    if (block.type === 'tool-result' && Array.isArray(block.content)) collectImages(block.content, refs)
  }
}

/**
 * 将 harness 对话消息序列化为 OpenAI chat-completions 传输格式。
 *
 * 保留的**通用协议要求**：
 * - 孤儿工具调用清理（见 `resolveToolPairing` 的说明，后端会 400）；
 * - 正文为空且有 `tool_calls` 时 `content` 必须为 `null`（OpenAI 规范）；
 * - 工具结果内嵌图片不能留在 `role:'tool'` 消息里（该角色 content 只能是
 *   字符串，且必须紧跟其 assistant tool_call，中间插消息会 400），
 *   故提升为其后的独立 user 消息。
 *
 * 图片：`imageUrls` 为 `undefined` 表示整个请求没有图片；非 undefined
 * （**含空 Map**）时把 user 消息升级为多模态 parts。空 Map 不能降级为
 * undefined —— 那会让「图片存在但字节读取失败」的 `[image unavailable]`
 * 占位符也被跳过，图片静默消失。
 */
export function serializeMessages(
  messages: readonly { role: string; content: unknown }[],
  imageUrls?: ReadonlyMap<string, string>,
): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = []
  const { keepCallIds, keepResultIds } = resolveToolPairing(messages)

  let pendingToolImages: Array<Record<string, unknown>> = []
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    wire.push({
      role: 'user',
      content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages],
    })
    pendingToolImages = []
  }

  for (const message of messages) {
    if (message.role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : []
      const toolCalls = content
        .filter((block): block is { type: string; id: unknown; name: unknown; arguments: unknown } =>
          typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-call')
        .filter(block => keepCallIds.has(String(block.id)))
        .map((block) => ({
          id: String(block.id),
          type: 'function' as const,
          function: { name: String(block.name), arguments: normalizeToolArguments(String(block.arguments)) },
        }))
      const reasoning = content
        .filter((block): block is { type: string; text: unknown } =>
          typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'reasoning')
        .map((block) => String(block.text))
        .join('')
      const text = contentToText(content)
      // 挂起的工具结果图片必须在 assistant 之前发出，否则会漂到这条
      // assistant 之后，与产生它们的工具调用脱节。
      flushToolImages()
      wire.push({
        role: 'assistant',
        // 正文为空且有工具调用时 content 必须为 null（OpenAI 规范）。
        content: text.length === 0 && toolCalls.length > 0 ? null : text,
        ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
      })
      continue
    }
    if (message.role === 'system') {
      flushToolImages()
      wire.push({ role: 'system', content: contentToText(message.content) })
      continue
    }
    // user 角色：工具结果搭载在 harness 用户消息中，展开为独立的 role:'tool' 消息。
    const content = Array.isArray(message.content) ? message.content : []
    const toolResults = content.filter((block): block is { type: string; toolCallId: unknown; content: unknown } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result')
    const text = contentToText(message.content)
    // 工具结果之外的常规内容（含顶层图片）。
    const regular = content.filter((block) =>
      !(typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result'))
    const parts = imageUrls === undefined ? undefined : userContentParts(regular, imageUrls)
    if (parts !== undefined) {
      flushToolImages()
      wire.push({ role: 'user', content: parts })
    } else if (text.length > 0 || toolResults.length === 0) {
      flushToolImages()
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      // 丢弃孤儿工具结果：没有对应 assistant tool_call 的结果同样会让后端 400。
      if (!keepResultIds.has(String(result.toolCallId))) continue
      // 内嵌图片挂起到其后的 user 消息；文本留在 tool 消息里。
      let resultText = '(no output)'
      if (imageUrls !== undefined && Array.isArray(result.content)) {
        const resultParts = userContentParts(result.content, imageUrls)
        if (resultParts !== undefined) {
          pendingToolImages.push(...resultParts.filter((part) => part.type !== 'text'))
          const joined = resultParts
            .filter((part) => part.type === 'text')
            .map((part) => String(part.text))
            .join('')
          if (joined.length > 0) resultText = joined
        } else {
          resultText = contentToText(result.content) || '(no output)'
        }
      } else {
        resultText = contentToText(result.content) || '(no output)'
      }
      wire.push({
        role: 'tool',
        tool_call_id: String(result.toolCallId),
        content: resultText,
      })
    }
  }
  flushToolImages()
  return wire
}

/** 安全读取 Error.message。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try { return String(error) } catch { return 'unknown error' }
}

/** 从错误体提取可读 detail 文本。 */
export function errorDetail(body: string): string {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const parts = [
      typeof data.code === 'number' || typeof data.code === 'string' ? `code=${String(data.code)}` : undefined,
      typeof data.message === 'string' ? data.message : undefined,
      typeof data.msg === 'string' ? data.msg : undefined,
    ].filter((value): value is string => value !== undefined)
    if (parts.length > 0) return parts.join(' ')
  } catch {
    // 非 JSON 错误体
  }
  return body
}

/** 将 HTTP 状态码映射为 harness 错误码。 */
export function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * 判断是否为传输级错误（可重试的 TRANSPORT）。
 *
 * 半开连接与 TCP 重置都会以这些特征出现。
 */
export function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  if (message.includes('terminated')) return true
  if (error.name.startsWith('UND_ERR_')) return true
  if (message.includes('fetch failed')) return true
  if (message.includes('econnreset') || message.includes('epipe') || message.includes('socket hang up')) return true
  return false
}

/** {@link consumeOpenAiSse} 的选项。 */
export interface ConsumeOpenAiSseOptions {
  /** provider 标签，仅用于错误消息前缀（如 `qoder`）。 */
  label: string
  /** 等待首 token 的空闲超时（毫秒）。 */
  firstTokenTimeoutMs: number
  /** 两次 chunk 之间的空闲超时（毫秒）。 */
  chunkTimeoutMs: number
}

/**
 * 消费 OpenAI 兼容的 SSE 响应并产出 `StreamChunk`。
 *
 * 三处兼容处理（都来自实测）：
 * 1. **容忍 `data:` 后无空格** —— 靠 `line.slice(5).trim()` 天然兼容两种形态；
 * 2. `reasoning_content` 单独成块；
 * 3. `tool_calls` 按 `index` 合并（首片带 id/name，后续只带 arguments 片段）。
 *
 * 另外两条防坑规则（见模块头注释）：
 * - `function.name` 只允许非空覆盖；
 * - `finish_reason` 映射：`length` / 中途断流 / 参数残缺一律归为 `max-tokens`。
 */
export async function* consumeOpenAiSse(
  response: Response,
  options: { signal?: AbortSignal },
  config: ConsumeOpenAiSseOptions,
): AsyncIterable<StreamChunk> {
  const { label } = config
  if (!response.body) throw new LlmError(`${label}: empty model response body`, 'EMPTY_RESPONSE')

  const blocks: Array<{ index: number; kind: 'text' | 'reasoning'; text: string }> = []
  let nextIndex = 0
  const toolCalls = new Map<number, { index: number; text: string; callId?: string; name?: string }>()
  const toolOrder: number[] = []
  const toolIds = new Map<number, string>()
  let buffer = ''
  let streamEnded = false
  let finishReason: 'stop' | 'tool_calls' | 'length' | undefined
  /**
   * 是否已通过 `delta.content` 收到过正文。
   *
   * 用途：一旦为 true，就不再采纳 `message.content` 这条兼容回退路径，
   * 避免两种下发形态同时出现时把内容重复拼接。
   */
  let gotAnyContent = false
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let firstTokenReceived = false

  try {
    for (;;) {
      if (streamEnded) break
      let result
      try {
        const timeoutMs = firstTokenReceived ? config.chunkTimeoutMs : config.firstTokenTimeoutMs
        const phase = firstTokenReceived ? 'chunk' : 'first-token'
        result = await readWithIdleTimeout(reader, timeoutMs, label, options.signal, phase)
        if (!result.done) firstTokenReceived = true
      } catch (error) {
        if (options.signal?.aborted) throw error
        if (error instanceof LlmError) throw error
        if (isTransportError(error)) {
          throw new LlmError(`${label}: sse transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error as Error })
        }
        throw error
      }
      if (result.done) break
      buffer += decoder.decode(result.value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith('data:')) continue
        // 兼容 "data: {...}" 与 "data:{...}"（部分上游实测无空格）。
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') {
          streamEnded = true
          break
        }
        let data: {
          error?: { message?: string }
          /**
           * Qoder 风格的**顶层**错误字段。
           *
           * ⚠️ 实测（2026-09-19）Qoder 的错误帧**不是** OpenAI 的
           * `{error:{message}}` 形态，而是：
           * ```
           * event: error
           * data: {"code":"invalid_model_error","message":"Unsupported model \"qfmodel\"",
           *        "request_id":"...","type":"invalid_model_error"}
           * ```
           * 只判 `data.error` 会让整帧被当成「无内容」静默丢弃，
           * 用户看到「没回复就终止」（真实缺陷）。
           */
          code?: string | number
          message?: string
          type?: string
          request_id?: string
          choices?: Array<{
            delta?: {
              content?: string | null
              reasoning_content?: string | null
              tool_calls?: Array<{
                index?: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
            }
            /** 有的上游把完整消息放在 message 而非 delta。 */
            message?: { content?: string | null }
            finish_reason?: string
          }>
          usage?: {
            prompt_tokens?: number
            completion_tokens?: number
            prompt_tokens_details?: { cached_tokens?: number }
            completion_tokens_details?: { reasoning_tokens?: number }
            prompt_cache_hit_tokens?: number
          }
        }
        try {
          data = JSON.parse(payload)
        } catch {
          continue
        }
        if (data.error !== undefined) {
          throw new LlmError(`${label}: ${data.error.message ?? 'unknown error'}`, 'SERVER')
        }
        // Qoder 风格错误：顶层 code/message/type（且无 choices）。
        // 判据要求**同时**出现 code 与 message，避免把正常帧里恰好叫
        // message 的字段误判成错误。
        if (
          data.choices === undefined
          && data.code !== undefined
          && typeof data.message === 'string'
        ) {
          const detail = [String(data.code), data.type].filter(Boolean).join('/')
          throw new LlmError(
            `${label}: ${data.message}${detail.length > 0 ? ` (${detail})` : ''}`,
            'SERVER',
          )
        }
        const choice = data.choices?.[0]
        const delta = choice?.delta
        if (typeof choice?.finish_reason === 'string') {
          finishReason = choice.finish_reason as 'stop' | 'tool_calls' | 'length'
        }
        // `message.content` 只是**兼容回退**：它与 delta 是互斥的两种下发形态，
        // 不能同时采纳（无守卫的 `??` 会把两段都拼进去）。
        //
        // 注意 `typeof === 'string'` 而非 `!== undefined`：真实线上形态里
        // 一个模型要么走 content、要么走 reasoning_content，**另一侧恒为
        // `null`**。只判 undefined 会让 `.length` 在 null 上崩溃。
        const deltaContent = delta?.content
        const textDelta = typeof deltaContent === 'string' && deltaContent.length > 0
          ? deltaContent
          : (!gotAnyContent && typeof choice?.message?.content === 'string' ? choice.message.content : undefined)
        if (textDelta !== undefined && textDelta.length > 0) {
          if (typeof deltaContent === 'string' && deltaContent.length > 0) gotAnyContent = true
          let block = blocks.find(candidate => candidate.kind === 'text')
          if (block === undefined) {
            block = { index: nextIndex++, kind: 'text', text: '' }
            blocks.push(block)
            yield { type: 'block-start', index: block.index, blockType: 'text' }
          }
          block.text += textDelta
          yield { type: 'text-delta', index: block.index, text: textDelta }
        }
        // 同样必须用 `typeof === 'string'`：reasoning_content 也会显式返回 null。
        const reasoningDelta = delta?.reasoning_content
        if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
          let block = blocks.find(candidate => candidate.kind === 'reasoning')
          if (block === undefined) {
            block = { index: nextIndex++, kind: 'reasoning', text: '' }
            blocks.push(block)
            yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
          }
          block.text += reasoningDelta
          yield { type: 'reasoning-delta', index: block.index, text: reasoningDelta }
        }
        for (const call of delta?.tool_calls ?? []) {
          const wireIndex = call.index ?? 0
          if (typeof call.id === 'string' && call.id.length > 0) toolIds.set(wireIndex, call.id)
          const callId = toolIds.get(wireIndex) ?? `call_${wireIndex}`
          let block = toolCalls.get(wireIndex)
          if (block === undefined) {
            block = { index: nextIndex++, text: '', callId }
            toolCalls.set(wireIndex, block)
            toolOrder.push(block.index)
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
          }
          block.callId = callId
          // 只允许非空名字覆盖：后续分片带空串 "" 会清空首个分片解析出的工具名，
          // 表现为 `unknown tool ""`。
          if (typeof call.function?.name === 'string' && call.function.name.length > 0) {
            block.name = call.function.name
          }
          const fragment = call.function?.arguments ?? ''
          block.text += fragment
          yield {
            type: 'tool-call-delta',
            index: block.index,
            id: ToolCallId(callId),
            ...block.name !== undefined ? { name: block.name } : {},
            argumentsDelta: fragment,
          }
        }
        if (data.usage) {
          const promptTokens = data.usage.prompt_tokens ?? 0
          // 缓存命中字段有多处来源，取首个有值的。
          const cachedTokens = data.usage.prompt_tokens_details?.cached_tokens
            ?? data.usage.prompt_cache_hit_tokens
            ?? 0
          const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens
          yield {
            type: 'usage',
            usage: {
              // inputTokens 只计**未命中缓存**的部分，命中部分单列
              // cacheReadTokens，否则缓存命中率显示会偏大。
              inputTokens: cachedTokens > 0 ? promptTokens - cachedTokens : promptTokens,
              outputTokens: data.usage.completion_tokens ?? 0,
              ...cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {},
              ...reasoningTokens !== undefined && reasoningTokens > 0 ? { reasoningTokens } : {},
            },
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  // 按创建顺序关闭每个块
  const textBlock = blocks.find(block => block.kind === 'text')
  for (const index of toolOrder) {
    const block = [...toolCalls.values()].find(candidate => candidate.index === index)!
    yield {
      type: 'block-end',
      index,
      block: {
        type: 'tool-call',
        id: ToolCallId(block.callId ?? ''),
        name: block.name ?? '',
        // 仅把「无参数工具下发的空分片」补成 {}；**残缺参数保持原样**，
        // 由 max-tokens 判定触发重试 —— 把残缺 JSON 补成 {} 会伪造出
        // 合法外观，让 harness 报 missing required property 而非重试。
        arguments: isTruncatedArguments(block.text)
          ? block.text
          : normalizeToolArguments(block.text),
      },
    }
  }
  if (textBlock !== undefined) {
    yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: textBlock.text } }
  }
  const reasoningBlock = blocks.find(block => block.kind === 'reasoning')
  if (reasoningBlock !== undefined && reasoningBlock.text !== '') {
    yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: reasoningBlock.text } }
  }
  // 三种「不完整」都必须报告 max-tokens 而非 tool-calls：
  // - 'length'：被 max_tokens 显式截断；
  // - 未收到 finish_reason：连接被中途掐断，参数必然是半截 JSON；
  // - 参数无法解析：分片丢失（并行工具调用时偶发）。
  // 报告 tool-calls 会让 harness 执行缺参调用并报 schema 错误，
  // 模型收到莫名错误后陷入重试循环；报告 max-tokens 则丢弃并重试。
  const argsTruncated = [...toolCalls.values()].some(block => isTruncatedArguments(block.text))
  const reason = finishReason === 'length'
    || (finishReason === undefined && toolOrder.length > 0)
    || argsTruncated
    ? { kind: 'max-tokens' as const }
    : finishReason === 'tool_calls' || toolOrder.length > 0
      ? { kind: 'tool-calls' as const }
      : { kind: 'stop' as const }
  yield { type: 'finish', reason }
}
