/**
 * 官方 ZCode CLI 的 system 身份块资产（2026-09-28 新增）。
 *
 * ## 来源与可信度
 *
 * 从同类项目 `a137460387/zcode2api` 的 `src/upstream/zcode-system.json`
 * 提取（该项目从官方 3.11.2 bundle 反解），**本项目实测可用**：
 *
 * ```
 * curl  + 这三块 system  →  HTTP 200
 * Node  + 这三块 system  →  HTTP 200（重复 4 次）
 * ```
 *
 * ## 为什么必须内置
 *
 * 上游网关对请求做**内容检查**：`system` 字段缺少这套身份块结构时，
 * 直接返回 `3012 "method not allowed"`（对外文案
 * `request has been blocked due to unusual activity`）。
 *
 * 实测对照（本项目，同账号同 captcha 来源）：
 *
 * | system 内容 | 结果 |
 * |---|---|
 * | 无 system | 3012 |
 * | 仅适配器 system（2782 字符） | 3012 |
 * | **官方三块（7599 字符）** | **200** |
 *
 * ⇒ 判据是 **system 的内容与结构**，不是 HTTP 头、不是运行时。
 * （本轮曾误判为「Electron 网络栈差异」，后经 curl 实测推翻 ——
 *   curl 带完整三块同样 200。）
 *
 * ## ⚠ 维护警告
 *
 * 上游策略与此结构**强耦合**：官方客户端升级后若改变身份块结构，
 * 需要同步更新本文件，否则会重新出现 3012 —— 而
 * **3012 有账号冷却惩罚**（30min，24h 内第 3 次起 24h，5 次停用）。
 * **不要为了调试反复触发。**
 */

/** 第一个 block：CLI 身份前缀（官方以它开头）。 */
export const OFFICIAL_CLI_PREFIX: string = "You are ZCode, an interactive coding agent";

/** 第二块：stable 段（用 `\n\n` 连接）。 */
export const OFFICIAL_STABLE_SECTIONS: readonly string[] = [
  "\nYou are an interactive ZCode agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.\n\n# Harness\n- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.\n- Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.\n- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.\n- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.\n- Reference code as `file_path:line_number` — it's clickable.",
  "# ZCode Desktop Context\n\n### Files & URLs\n- Return local web URLs as Markdown links (e.g., [label](http://127.0.0.1:8080)).\n- File should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.\n- Unless otherwise specified, return local file references as Markdown links (e.g., [name.md](/absolute/path/to/name.md)).\n\n### Inline Code Comments\n- Use the ::code-comment{...} directive when you need to attach feedback directly to specific code lines.\n- Emit one directive per inline comment; emit none when there are no actionable inline comments.\n- Required attributes: title (short label), body (one-paragraph explanation), file (path to the file).\n- Optional attributes: start, end (1-based line numbers), priority (0-3).\n- file should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.\n- Keep line ranges tight; end defaults to start.\n- Example: ::code-comment{title=\"[P2] Off-by-one\" body=\"Loop iterates past the end when length is 0.\" file=\"/path/to/foo.ts\" start=10 end=11 priority=2}",
  /**
   * ★★★ 第三块：**精炼后的能力准则**（2026-09-28 新增）。
   *
   * ## 为什么需要这块 —— 复盘「瘦身」那次改动的得失
   *
   * 原先砍掉的 5244 字符 dynamic 段其实含**两类内容**，性质完全不同：
   *
   * | 类别 | 例子 | 对 DSH 的影响 |
   * |---|---|---|
   * | **流程指令** | 「先声明再动手」「边做边汇报」「最后一句给结论」 | ✗ 有害 —— 与 DSH 规范冲突，压制 DSH prompt |
   * | **能力准则** | 「有足够信息就行动，不要再论证一遍」 | ✓ 有益 —— 正是「ZCode 里聪明」的来源 |
   *
   * 上一轮**整段砍掉** ⇒ 顺带把能力准则也丢了。症状是
   * 「不啰嗦了，但也不那么果断了」—— 优化了表象，损伤了内核。
   *
   * ## 这块只保留能力准则，逐条剔除流程指令
   *
   * 保留（原则层面，与 DSH 不冲突）：
   *   · 有足够信息就行动，不要重新论证已确立的事实
   *   · 不要重开用户已做的决定
   *   · 权衡时给**推荐**而不是罗列全部选项
   *   · 改系统状态的命令前，先确认证据真的支持那个具体动作
   *
   * 剔除（流程层面，会压制 DSH 自己的规范）：
   *   ✗ "Before your first tool call, say in a sentence what you're about to do"
   *   ✗ "while working, give brief updates when you find something load-bearing"
   *   ✗ "Lead with the outcome"（DSH 有自己的输出纪律）
   *   ✗ "You are operating autonomously... asking 'Want me to…?' will block"
   *     （DSH 有弹窗机制，这条会误导模型不用弹窗）
   *   ✗ "Before ending your turn, check your last paragraph..."
   *     （与 DSH 的收尾规范重复且措辞冲突）
   *
   * ## 体积
   *
   * 约 700 字符 —— 相对原来 5244 字符的 dynamic 段削减 87%，
   * 但把真正影响**推理果断性**的那几条拿了回来。
   *
   * ⚠ 这一块的加入**不改变 3012 准入性**：准入只要求身份块存在
   * （cliPrefix + stable 已是 200），追加的块属于「调用方内容」那一类。
   */
  "# Working style\n\nWhen you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey. Prefer reading the actual file or running the actual command over reasoning about what it probably contains. When a signal pattern-matches to a known failure, check that the evidence actually supports that specific diagnosis before acting on it.",
];

/**
 * 第三块的前半段（在 environment 段之前）。
 *
 * 完整的第三块 = `"\n\n"` + beforeEnv + `"\n\n"` + environment
 *                + `"\n\n"` + afterEnv
 */
export const OFFICIAL_DYNAMIC_BEFORE_ENV: string = "# Communicating with the user\n\nYour text output is what the user reads; they usually can't see your thinking or the raw tool results. Write it for a teammate who stepped away and is catching up, not for a log file: they don't know the codenames or shorthand you created along the way, and they didn't watch your process unfold. Before your first tool call, say in a sentence what you're about to do; while working, give brief updates when you find something load-bearing or change direction.\n\nText you write between tool calls may not be shown to the user. Everything the user needs from this turn — answers, summaries, findings, conclusions, deliverables — must be in the final text message of your turn, with no tool calls after it. Keep text between tool calls to brief status notes. If something important appeared only mid-turn or in your thinking, restate it in that final message.\n\nLead with the outcome. Your first sentence after finishing should answer \"what happened\" or \"what did you find\" — the thing the user would ask for if they said \"just give me the TLDR.\" Supporting detail and reasoning come after, for readers who want them.\n\nBeing readable and being concise are different things, and readable matters more. If the user has to reread your summary or ask you to explain, any time saved by brevity is gone. The way to keep output short is to be selective about what you include (drop details that don't change what the reader would do next), not to compress the writing into fragments, abbreviations, arrow chains like `A → B → fails`, or jargon. What you do include, write in complete sentences with the technical terms spelled out. Don't make the reader cross-reference labels or numbering you invented earlier; say what you mean in place.\n\nMatch the response to the question: a simple question gets a direct answer in prose, not headers and sections. Use tables only for short enumerable facts, with explanations in the surrounding prose rather than the cells. Calibrate to the user — a bit tighter for an expert, more explanatory for someone newer.\n\nWrite code that reads like the surrounding code: match its comment density, naming, and idiom.\nOnly write a code comment to state a constraint the code itself can't show — never to say where it came from, what the next line does, or why your change is correct; that's you talking to the reviewer, not the next reader, and it's noise the moment the PR merges.\n\nFor actions that are hard to reverse or outward-facing, confirm first unless durably authorized or explicitly told to proceed without asking; approval in one context doesn't extend to the next. Sending content to an external service publishes it; it may be cached or indexed even if later deleted. Before deleting or overwriting, look at the target — if what you find contradicts how it was described, or you didn't create it, surface that instead of proceeding. Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly without hedging.";

/** 第三块的后半段（在 environment 段之后）。 */
export const OFFICIAL_DYNAMIC_AFTER_ENV: string = "# Context management\nWhen the conversation grows long, some or all of the current context is summarized; the summary, along with any remaining unsummarized context, is provided in the next context window so work can continue — you don't need to wrap up early or hand off mid-task.\n\nWhen you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey\n\nYou are operating autonomously. The user is not watching in real time and cannot answer questions mid-task, so asking 'Want me to…?' or 'Shall I…?' will block the work. For reversible actions that follow from the original request, proceed without asking. Stop only for destructive actions or genuine scope changes the user must decide. Offering follow-ups after the task is done is fine; asking permission before doing the work is not.\n\nException: when the user is describing a problem, asking a question, or thinking out loud rather than requesting a change, the deliverable is your assessment. Report your findings and stop. Don't apply a fix until they ask for one.\n\nBefore ending your turn, check your last paragraph. If it is a plan, an analysis, a question, a list of next steps, or a promise about work you have not done ('I'll…', 'let me know when…'), do that work now with tool calls. That includes retrying after errors and gathering missing information yourself. Do not stop because the context or session is long. End your turn only when the task is complete or you are blocked on input only the user can provide.\n\nBefore running a command that changes system state — restarts, deletes, config edits — check that the evidence actually supports that specific action. A signal that pattern-matches to a known failure may have a different cause.";

/** environment 段的标签（运行时逐行拼接，`{provider}`/`{model}` 需替换）。 */
export const OFFICIAL_ENVIRONMENT_LABELS: {
  readonly heading: string;
  readonly invokedLine: string;
  readonly cwdLabel: string;
  readonly gitLabel: string;
  readonly gitNo: string;
  readonly platformLabel: string;
  readonly shellLabel: string;
  readonly osVersionLabel: string;
  readonly poweredByLine: string;
} = {
  "heading": "# Environment",
  "invokedLine": "You have been invoked in the following environment:",
  "cwdLabel": "Primary working directory",
  "gitLabel": "Is a git repository",
  "gitNo": "no",
  "platformLabel": "Platform",
  "shellLabel": "Shell",
  "osVersionLabel": "OS Version",
  "poweredByLine": "- You are powered by the model named {provider}/{model}."
};

/** 首轮 user 的 `<system-reminder>` 上下文模板（`{date}` 需替换）。 */
export const OFFICIAL_CONTEXT_PREFIX: {
  readonly intro: string;
  readonly outro: string;
  readonly currentDateHeading: string;
  readonly currentDateLine: string;
} = {
  "intro": "As you answer the user's questions, you can use the following context:",
  "outro": "      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.",
  "currentDateHeading": "# currentDate",
  "currentDateLine": "Today's date is {date}."
};

/** `<system-reminder>` 的开闭标签。 */
export const OFFICIAL_SYSTEM_REMINDER: {
  readonly open: string;
  readonly close: string;
} = {
  "open": "<system-reminder>",
  "close": "</system-reminder>"
};

/**
 * ★ 构造官方形态的 system 块数组（2026-09-28）。
 *
 * 独立成函数放在本文件里（而不是塞进 `zcodeBridgeServer.ts`），
 * 理由是**可单独验证**：这个函数是 3012 的唯一开关，
 * 需要能在不启动整个桥的情况下单测。
 *
 * ## 结构（逐字复刻官方，不要"优化"）
 *
 * ```
 * block[0] = cliPrefix（42 字符）
 * block[1] = stable 两段用 "\n\n" 连接（2311 字符）
 * block[2] = "\n\n" + beforeEnv + "\n\n" + environment + "\n\n" + afterEnv
 * block[3..] = 调用方的 system（追加在最后）
 * ```
 * 每个 block 都带 `cache_control: {type:"ephemeral"}`。
 *
 * **调用方内容必须追加在最后** —— 官方身份块必须处在开头位置。
 *
 * @param callerSystem 调用方的 system（DSH 适配器构造的 AGENTS.md / skill 规则等）
 * @param options.cwd  工作目录（官方实现声明「cwd is never "unknown" in real
 *                     traffic」，所以调用方必须给真值）
 * @param options.model 模型名（小写），用于 environment 段的 poweredByLine
 */
export function buildOfficialSystemBlocks(
  callerSystem: string | undefined,
  options: { cwd: string; model?: string } = { cwd: "." },
): Array<{ type: "text"; text: string; cache_control: { type: "ephemeral" } }> {
  const ephemeral = { type: "ephemeral" as const };
  const stable = OFFICIAL_STABLE_SECTIONS.join("\n\n");

  /**
   * ★★ 只发「准入必需」的两块 —— 砍掉 5KB 行为指令（2026-09-28 实测）。
   *
   * ## 为什么砍（这是「DSH 里变笨」的根因）
   *
   * 上游的内容检查**只要求身份块存在**，不要求它的行为指令段。
   * 实测三种组合：
   *
   * | system 内容 | 字符数 | 结果 |
   * |---|---|---|
   * | 完整三块（含 dynamic 段） | 7599 | ✓ 200 |
   * | **仅 cliPrefix + stable** | **2355** | **✓ 200** |
   * | 仅 cliPrefix | 42 | ✗ 3012 |
   *
   * **⇒ 砍掉的 5244 字符是「dynamic 段」，它对准入无影响。**
   *
   * ## 那 5KB 里有什么（为什么它有害）
   *
   * `dynamicSections` 含两段**给 ZCode 内 coding agent 的行为指令**：
   *
   * - `# Communicating with the user`
   *   「Before your first tool call, say in a sentence what you're about to do」
   *   「while working, give brief updates」「Lead with the outcome」
   * - `# Context management`
   *   「You are operating autonomously」「Before ending your turn, check...」
   *
   * 这些**与 DSH 自己的行为规范冲突**：它们鼓励「先声明再做事、边做边汇报、
   * 最后总结」，而 DSH 的语境不需要这些 —— 表现出来就是「啰嗦、慢、
   * 一个简单任务要 39 秒起」。
   *
   * 而它们被放在 system **开头**（7.6KB），**压过了追加在后面的 DSH prompt**。
   *
   * ## 现在的形状
   *
   * ```
   * block[0] = cliPrefix（42 字符）    ← 准入必需
   * block[1] = stable（2313 字符）     ← 准入必需
   * block[2..] = 调用方的 system（DSH 的完整 prompt）  ← 现在它是主角
   * ```
   *
   * 调用方内容仍然追加在最后（身份块必须在开头），但**不再被 5KB 行为指令压制**。
   */
  const blocks: Array<{
    type: "text";
    text: string;
    cache_control: { type: "ephemeral" };
  }> = [
    { type: "text", text: OFFICIAL_CLI_PREFIX, cache_control: ephemeral },
    { type: "text", text: stable, cache_control: ephemeral },
  ];
  if (typeof callerSystem === "string" && callerSystem.trim().length > 0) {
    blocks.push({ type: "text", text: callerSystem, cache_control: ephemeral });
  }
  return blocks;
}
