/**
 * 工具调用的「提示词化」桥接。
 *
 * ## 为什么需要这一层
 *
 * DSH 的适配器契约允许在 `stream()` 里产出 `tool-call` 块，但**桥没有 tools 通道**：
 * `POST /v1/chat/completions` 的 `sendPrompt` 只收 `content: string`，没有 `tools`
 * 字段（只有 `toolDenylist`，无 allowlist）。
 *
 * 于是唯一可行的路径是：
 *
 *   1. 把 DSH 给的 `tools[]`（JSON Schema）**渲染成提示词**，追加到 system 段
 *   2. 与模型约定一个**明确的结构化输出格式**（见下）
 *   3. 在 `stream()` 里解析模型回复文本，命中则**合成** `tool-call` 块序列
 *   4. `finish` 用 `{ kind: 'tool-calls' }`
 *
 * 这条路径完全满足 DSH 契约 —— 契约只约束 chunk 序列，不关心工具调用是谁产生的。
 *
 * ## 输出格式的选定（实测对比过）
 *
 * 约定用单个 ```json 围栏包裹：
 *
 * ```json
 * {"tool":"read_file","arguments":{"path":"D:\\x.txt"}}
 * ```
 *
 * 选它的理由：
 *   - **GLM 对 ```json 围栏的遵循度极高**（实测 19 秒内一次命中，格式完全正确）
 *   - 单个对象而非数组 → 解析简单，且一个围栏 = 一个调用，天然对应一个 index
 *   - 与模型的自然语言前缀可以共存（"我来看看" + 围栏），不会误伤普通回复
 *
 * **不使用** XML 风格（`<tool_call>`）或裸 JSON：前者 GLM 偶尔改写成别的标签，
 * 后者会把普通回复里的 JSON 片段误判成工具调用。
 *
 * ## 一个刻意的取舍：不解析「多调用同时出现」
 *
 * 模型一次回复里可能给多个围栏（并行调用）。这里**全部解析并依次编号** ——
 * 每个围栏一个 index，符合 DSH「一个工具调用一个 index」的规则。
 */

import type { ToolSchema } from "@deepseek-ai/dsh-llm";

/** 解析出的一个工具调用。 */
export interface ParsedToolCall {
  /** 工具名。 */
  readonly name: string;
  /** 参数 —— **原始 JSON 字符串**（DSH 要的就是字符串，不要先 parse 再 stringify）。 */
  readonly arguments: string;
}

/**
 * 渲染工具表为提示词。
 *
 * 参数以 JSON Schema 原文贴出，不做简化 —— DSH 传下来的 schema 已经是
 * 模型友好的形状（`dsh-tools` 负责投影），二次加工只会丢信息。
 */
export function renderToolInstructions(tools: readonly ToolSchema[]): string {
  if (tools.length === 0) {
    return "";
  }

  const lines: string[] = [
    "## 工具调用协议（最高优先级，覆盖其它输出习惯）",
    "",
    "你可以调用下列工具。**需要调用工具时，必须在回复里输出一个 ```json 代码块**，",
    "内容是一个 JSON 对象，形如：",
    "",
    "```json",
    '{"tool":"<工具名>","arguments":{<参数>}}',
    "```",
    "",
    "规则：",
    "1. `tool` 必须是下表里的工具名，不得自创。",
    "2. `arguments` 必须严格符合该工具的 JSON Schema。",
    "3. **一次只在一个代码块里放一个调用**；要并行调用多个工具就输出多个代码块。",
    "4. 调用工具时**不要**自己编造工具的执行结果 —— 结果会由宿主回传给你。",
    "5. 不需要工具时正常用自然语言回答，**不要**输出这个 JSON 结构。",
    "6. **不要**用你自己的内置工具（Bash/Read/Write 等）去完成这些事，只走上面的协议。",
    "",
    "### 可用工具",
    "",
  ];

  for (const tool of tools) {
    lines.push(`#### \`${tool.name}\``);
    lines.push("");
    if (tool.description.length > 0) {
      lines.push(tool.description);
      lines.push("");
    }
    lines.push("参数 JSON Schema：");
    lines.push("");
    lines.push("```json");
    lines.push(safeStringify(tool.parameters));
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * 从模型回复里抽出全部工具调用。
 *
 * 只认 ```json（大小写不敏感、允许 `JSON` / ` json`）围栏，且**内容必须能解析成
 * 带 `tool` 字段的对象**。任何一步不满足就跳过该围栏 —— 宁可漏判也不要误判：
 * 误判会让 DSH 去执行一个模型根本没要求的工具，后果比漏判严重得多。
 */
export function parseToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  // ```json ... ``` —— 非贪婪，允许围栏内换行。
  const fence = /```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(text)) !== null) {
    const body = match[1]?.trim();
    if (body === undefined || body.length === 0) {
      continue;
    }
    const call = tryParseOne(body);
    if (call !== undefined) {
      calls.push(call);
    }
  }

  return calls;
}

/** 解析单个围栏内容；不是合法工具调用时返回 undefined。 */
function tryParseOne(body: string): ParsedToolCall | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as { tool?: unknown; name?: unknown; arguments?: unknown; parameters?: unknown };
  // 兼容 `name` —— 模型偶尔把 `tool` 写成 `name`（同义改写，不是错误）。
  const rawName = record.tool ?? record.name;
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    return undefined;
  }

  const rawArgs = record.arguments ?? record.parameters ?? {};
  const args =
    typeof rawArgs === "string"
      ? rawArgs
      : safeStringify(rawArgs);

  return { name: rawName.trim(), arguments: args };
}

/**
 * 剥掉回复里的工具调用围栏，留下纯自然语言部分。
 *
 * 用途：模型常常「先说一句 + 再给围栏」。如果原样把整段文本作为 `text` 块发给
 * DSH，界面上会同时显示那段话**和**一个原始 JSON —— 后者是协议噪音，
 * 用户不该看到。所以把围栏摘掉再发文本块。
 *
 * 若摘完只剩空白，则**不发文本块**（纯工具调用回合，DSH 会照常处理）。
 */
export function stripToolFences(text: string): string {
  const stripped = text.replace(/```[ \t]*(?:json)?[ \t]*\r?\n[\s\S]*?```/gi, (whole) => {
    const body = whole.replace(/```[ \t]*(?:json)?[ \t]*\r?\n?/gi, "").replace(/```/g, "").trim();
    return tryParseOne(body) === undefined ? whole : "";
  });
  return stripped.trim();
}

/** JSON 化，永不抛。schema 里可能有循环引用以外的任意值。 */
function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? "{}" : text;
  } catch {
    return "{}";
  }
}
