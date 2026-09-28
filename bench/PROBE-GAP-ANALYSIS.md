# DSH 侧 GLM 与 ZCode 原生 GLM 的差距分析（探路报告）

日期：2026-09-28
范围：`zcodeBridgeServer.ts` + `zcode-official-identity.ts` + DSH 插件 `dsh-zcode-bridge`
方法：静态读码 + **活体请求 dump 取证** + 日志统计

> **证据分级**：本文每条都标注「实测」或「推测」。
> 「实测」= 有命令输出原文或落盘 dump 原文；
> 「推测」= 只有代码事实，尚无行为对照实验。

---

## 零、最重要的一条（先说结论）

**DSH 整天跑的是 `GLM-5.3-Flash`，不是 `GLM-5.3`。而 `LATENCY-FINDINGS.md` 的实测结论是 GLM-5.3 最快最准。**

这一条的影响**远超**其他所有条目，且是**唯一一条改一个词就能生效**的。

---

## 一、实测取证的基础设施（本次新发现）

`zcodeBridgeServer.ts` 里有一段**常开的落盘诊断**（不是开关控制的）：

```ts
// zcodeBridgeServer.ts，搜索 `bridge-last-request.ndjson`
if (true) {
  try {
    const { writeFileSync } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    writeFileSync(
      joinPath(deps.dataBaseDir, "bridge-last-request.ndjson"),
      JSON.stringify({ at, url, headerNames, headers, bodyLength, body }, null, 2),
      "utf8",
    );
  } catch { /* 诊断失败不影响主流程 */ }
}
```

**产物**：`D:\zcode-glm5.3f\_oss_data\bridge-last-request.ndjson`
**内容**：**桥实际发给上游的完整请求体**（`body` 是字符串字段）。

⇒ **本报告绝大多数「实测」都来自这个文件。** 它比读代码可信 —— 可以直接看到最终字节。

⚠ 注意注释里写的是「只在 `ZCODE_BRIDGE_DUMP_REQUEST=1` 时落盘」，但代码是 `if (true)` —— **注释与实现不符**，实际是每次都写。这既是取证利器，也是**每请求一次同步写盘的性能损耗**（见条目 8）。

---

## 二、★ 差异清单（按影响大小排序）

---

### 【P0-1】默认模型是 Flash，不是 GLM-5.3 —— 白送的性能损失

**现象**
全天 639 次 fast path 请求中（`stream_completed` + `completed` 两个端点合计），
**607 次是 `GLM-5.3-Flash`，仅 32 次是 `GLM-5.3`** —— **95.0% 跑在 Flash 上**。

```
PS> Select-String -Path '<log>' -Pattern 'bridge\.fast_path\.(stream_completed|completed)' | ...分组
Count Name
   32 GLM-5.3
  607 GLM-5.3-Flash
TOTAL: 639
```

**证据（实测）**

证据①：日志按小时分组的模型分布 ——

```
PS> Select-String -Path '<log>' -Pattern 'bridge\.fast_path\.stream_completed' | ...分组
Count Name
  130 2026-09-28 07  GLM-5.3-Flash
   54 2026-09-28 08  GLM-5.3-Flash
   28 2026-09-28 09  GLM-5.3-Flash
   21 2026-09-28 11  GLM-5.3-Flash
   58 2026-09-28 12  GLM-5.3-Flash
   33 2026-09-28 13  GLM-5.3-Flash
   23 2026-09-28 14  GLM-5.3-Flash
    8 2026-09-28 15  GLM-5.3-Flash
   34 2026-09-28 16  GLM-5.3-Flash
   25 2026-09-28 17  GLM-5.3          ← 17 点才首次出现
   67 2026-09-28 17  GLM-5.3-Flash
```

**07-16 点全是 Flash，一次 GLM-5.3 都没有。**
GLM-5.3 首次出现在 `17:09:00`（`pid:65968` 那次重启之后）—— 那是有人**手动**在模型选择器里切换的结果。

证据②：配置里**硬编码**了默认模型 ——

```yaml
# C:\Users\Administrator\AppData\Roaming\in.dsh-plug.dsh-launcher\homes\0.1.7-rc.2\profiles\web\cordis.patch.yml
# 第 66-70 行
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: zcode-bridge
    model: GLM-5.3-Flash
```

⇒ **不是 DSH「默认选列表第一个」的问题** —— `product.ts` 里 `MODELS[0]` 确实是 `GLM-5.3`，但**根本没轮到它**：profile 配置里的 `agent-default-model` 直接指定了 Flash，覆盖了列表顺序。

**影响评估：大**
`LATENCY-FINDINGS.md` 记录 GLM-5.3 是最快最准的档位。整天跑 Flash ⇒ 每轮都在用弱一档的模型，而且**用户以为自己是在用 GLM-5.3**（system prompt 里 DSH 注入的自我认知写的就是 `powered by the GLM-5.3-Flash model`，实测见 `dsh-role-dist.ndjson` 166/166 全是 Flash）。

**修复方案**
改 profile 配置的一行：

```yaml
# profiles/web/cordis.patch.yml 搜 `agent-default-model`
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: zcode-bridge
    model: GLM-5.3        # ← GLM-5.3-Flash 改为 GLM-5.3
```

⚠ **是用户级配置，不是插件源码**。改完**必须重启 DSH**。
⚠ 这是**用户取舍**（Flash 更省额度），应报给用户拍板 —— 不能擅自改。
⚠ 同时注意：`product.ts` 的 `MODELS` 顺序**已经是对的**，不需要改。

---

### 【P0-2】tools 数组**完全没有 `cache_control`** —— 24 个工具 schema 每次全量重算

**现象**
官方客户端给 **system 的每个 block** 都带 `cache_control:{type:"ephemeral"}`。桥照做了 system，但 **`tools` 数组一个都没有**。

**证据（实测，dump 原文）**

```jsonc
// bridge-last-request.ndjson → body 解析后
=== TOP-LEVEL KEYS ===
model, max_tokens, system, stream, tools, tool_choice, messages

=== system blocks ===
  len=42    hasCacheControl=True   head=You are ZCode, an interactive coding agent
  len=2856  hasCacheControl=True   head= You are an interactive ZCode agent ...
  len=2836  hasCacheControl=True   head=You are ZCode connectivity probe. ...

=== tools count: 24 ===
  first tool keys: name, description, input_schema      ← ★ 没有 cache_control
```

工具 schema 的**实测体积**（`ConvertTo-Json -Depth 20` 后）：

```
19492 bytes
   222  create_goal      59  edit            250  exit_plan_mode
    87  get_goal        235  glob            206  grep
   202  interrupt_agent  49  job_kill         85  job_list
   116  job_output      276  list_agents    1663  pwsh
    56  read            174  read_image      169  send_message
   139  skill           434  subagent       438  subagent_fork
   317  todo_write       24  update_goal      74  web_fetch
   101  web_search     1667  workflow         42  write
```

**接近 20 KB / 约 5K token 的工具 schema，每个请求都要重算。**

对比：`system` 三块合计 5734 字符且**都带** `cache_control`。

**代码位置**
`zcodeBridgeServer.ts`，搜 `const fastTools = rawTools`：

```ts
const fastTools = rawTools
  .map((t) => {
    ...
    return {
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      input_schema: /* ... */,
    };   // ← 没有 cache_control
  })
```

而 system 侧（`zcode-official-identity.ts` 的 `buildOfficialSystemBlocks`）带：

```ts
const ephemeral = { type: "ephemeral" as const };
blocks.push({ type: "text", text: callerSystem, cache_control: ephemeral });
```

⇒ **两侧不对称**：system 走了缓存，tools 没走。

**影响评估：大（性能）**

Anthropic 协议的 prompt caching 是按**前缀**断点的：缓存断点越靠后，能复用的前缀越长。
官方形态的断点顺序是 `tools → system → messages`。
**桥只在 system 上打断点，等于放弃了 tools→system 这一段的前缀复用。**

具体代价：**每个请求都要重新处理约 5K token 的工具定义**。多步 agent 循环里一轮要发 5-10 个请求 ⇒ 白烧 25-50K token 的**重复 prefill**。

**这条同时解释了一个实测异常**：日志里 `ttftMs` 波动极大 ——

```
{"modelId":"GLM-5.3-Flash","durationMs":5477, "ttftMs":1286,  "mintMs":380}
{"modelId":"GLM-5.3-Flash","durationMs":8686, "ttftMs":4978,  "mintMs":561}
{"modelId":"GLM-5.3-Flash","durationMs":8681, "ttftMs":4061,  "mintMs":197}
{"modelId":"GLM-5.3-Flash","durationMs":15500,"ttftMs":15006, "mintMs":292}
{"modelId":"GLM-5.3-Flash","durationMs":26377,"ttftMs":25079, "mintMs":702}
{"modelId":"GLM-5.3-Flash","durationMs":15136,"ttftMs":13510, "mintMs":422}
```

`mintMs` 稳定在 200-700ms，**`ttftMs` 却从 1.3 秒一路飙到 25 秒**。
差值全在「上游首字」这一段 —— 而**冷缓存 prefill 正是这一段的主要成本**。

⚠ **诚实标注**：`ttftMs` 与缓存命中率**没有直接对照实验**。上面这是**推测**（代码事实 + 数值相关性），不是实测因果。
要坐实需要一次 A/B：加 `cache_control` 后对比 `ttftMs` 分布。

**修复方案**
`zcodeBridgeServer.ts`，`fastTools` 的构建处，给**最后一个** tool 打一个断点（Anthropic 规范：断点打在末尾即覆盖整个前缀；每请求上限 4 个）：

```ts
const fastTools = rawTools
  .map((t) => { /* ... 原逻辑 ... */ })
  .filter((t): t is {...} => t !== undefined)
  // ★ 新增：只给最后一个 tool 打断点，覆盖 tools 全段前缀
  .map((t, i, arr) =>
    i === arr.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t,
  );
```

⚠ **只打一个断点**，不是每个都打 —— Anthropic 每请求最多 4 个 `cache_control`，超了报错。
⚠ system 现在占了 3 个（三个 block 各一个），加上 tools 就是 4 个，**正好到上限**。
若要给 `messages` 再打断点，必须先把 system 收敛成 1 个断点。

---

### 【P0-3】environment 段**完全没发** —— 模型不知道 cwd / 平台 / shell / 自己是什么模型

**现象**
`zcode-official-identity.ts` 定义了完整的 `OFFICIAL_ENVIRONMENT_LABELS`，但 `buildOfficialSystemBlocks()` **一次都没用过它**。发出的 system 里**没有任何 environment 段**。

**证据（实测，dump 原文）**

```
PS> 检查 system 三块是否含 'Environment' 或 'powered by the model'
no-env
no-env
no-env
```

第三块（调用方块）的全文以 `# Working style` 段落**开头**，没有任何 `# Environment` 标题：

```
=== system block[2] head ===
You are ZCode connectivity probe.

You are an AI agent powered by DeepSeek Harness.
...
```

**代码证据**：`buildOfficialSystemBlocks` 函数体（`zcode-official-identity.ts` 末尾）**只 push 三个 block**，从不引用 `OFFICIAL_ENVIRONMENT_LABELS`：

```ts
const blocks = [
  { type: "text", text: OFFICIAL_CLI_PREFIX,     cache_control: ephemeral },
  { type: "text", text: stable,                  cache_control: ephemeral },
];
if (callerSystem?.trim().length > 0) {
  blocks.push({ type: "text", text: callerSystem, cache_control: ephemeral });
}
return blocks;
// ← environment 段从未被拼进去
```

而它本该拼在 `OFFICIAL_DYNAMIC_BEFORE_ENV` 与 `OFFICIAL_DYNAMIC_AFTER_ENV` 之间（见文件顶部注释原文）：
`完整的第三块 = "\n\n" + beforeEnv + "\n\n" + environment + "\n\n" + afterEnv`

**行为后果（实测）**

直接问桥「你是什么模型」：

```
PS> 请求 system="You are ZCode, an interactive coding agent",
     user="Which model are you? Answer in one short line."
CONTENT: I'm ZCode, powered by GLM (trained by Z.ai).
```

**模型只能答出笼统的「GLM」** —— 因为官方那句 `- You are powered by the model named {provider}/{model}.` 根本没发出去。

**影响评估：中-大**
丢失的信息有六项（`OFFICIAL_ENVIRONMENT_LABELS` 里逐字定义）：
`Primary working directory` / `Is a git repository` / `Platform` / `Shell` / `OS Version` / `powered by the model named X/Y`。

- **cwd 缺失**：模型不知道自己在哪个目录 ⇒ 更容易用相对路径猜错
- **Platform / Shell / OS Version 缺失**：不知道是 Windows 还是 Linux ⇒ 影响命令形态选择（本机是 `pwsh`，不是 `bash`）
- **git 是否仓库缺失**：无法判断能否用 git 相关操作
- **自我认知缺失**：实测已证明（答「GLM」而非具体型号）

⚠ **与 P0-1 联动**：一旦把默认模型改成 `GLM-5.3`，这条**必须同时修** —— 否则模型仍不知道自己跑在哪个模型上。两条应**一起改**。

**修复方案**
`zcode-official-identity.ts`，`buildOfficialSystemBlocks` 函数内，在 `blocks[2]`（调用方块）**之前**插入 environment 块：

```ts
// zcode-official-identity.ts，buildOfficialSystemBlocks 内
const L = OFFICIAL_ENVIRONMENT_LABELS;
const envBlock = [
  L.heading,
  L.invokedLine,
  `- ${L.cwdLabel}: ${options.cwd}`,
  `- ${L.gitLabel}: ${L.gitNo}`,          // ← 需要真实探测，见下
  `- ${L.platformLabel}: ${process.platform === "win32" ? "win32-x64" : process.platform}`,
  `- ${L.shellLabel}: pwsh`,
  `- ${L.osVersionLabel}: ${os.release()}`,
  L.poweredByLine
    .replace("{provider}", options.providerId ?? "zcode")
    .replace("{model}", options.model ?? "unknown"),
].join("\n");

// 插在 callerSystem 之前（官方顺序：identity → env → caller）
if (callerSystem?.trim().length > 0) {
  blocks.push({ type: "text", text: envBlock, cache_control: ephemeral });
  blocks.push({ type: "text", text: callerSystem, cache_control: ephemeral });
} else {
  blocks.push({ type: "text", text: envBlock, cache_control: ephemeral });
}
```

调用点同步补参数（`zcodeBridgeServer.ts` 搜 `buildOfficialSystemBlocks`）：

```ts
const fastSystemBlocks = buildOfficialSystemBlocks(fastSystem, {
  cwd: bridgeWorkspacePath(),
  model: modelId.toLowerCase(),
  // ★ 新增 providerId 透传，供 poweredByLine 用
  providerId: resolveProviderId(body["providerId"]),
});
```

⚠ 官方注释明说「cwd is never `unknown` in real traffic」，所以**必须给真值**（现在的 `bridgeWorkspacePath()` 已经是真值）。
⚠ `Is a git repository` 需要真实探测（`fs.existsSync(join(cwd, ".git"))`），**不要硬编码 `no`** —— 工作目录 `D:\zcode-glm5.3f` 就是 git 仓库。
⚠ 加这一块会**再多一个 `cache_control`**（变成 4 个）。若同时做 P0-2，需要先把 system 三个断点收敛成一个。

---

### 【P1-4】`# Working style` 被放在**调用方块内部** —— 位置与官方不一致

**现象**
`OFFICIAL_DYNAMIC_BEFORE_ENV` 与 `OFFICIAL_DYNAMIC_AFTER_ENV` 这两大段**在代码里完整存在**，但 `buildOfficialSystemBlocks` **只用了 700 字符的 `# Working style`**，而且这段被直接拼进了 `OFFICIAL_STABLE_SECTIONS[2]`。

**证据（实测）**
`system block[2]` 的内容顺序是：

```
You are ZCode connectivity probe.          ← 插件加的探针前缀
You are an AI agent powered by DeepSeek Harness.   ← DSH 注入
...
# Working style                            ← 能力准则（stable 第三个元素）
When you have enough information to act, act. ...
```

也就是说 `# Working style` 是 `OFFICIAL_STABLE_SECTIONS[2]`（见该文件数组定义），被 `join("\n\n")` 进了 **stable 块**，而不是作为 dynamic 段。

**逐句分析那 5KB（任务要求的方向 B）**

`OFFICIAL_DYNAMIC_AFTER_ENV` 实测 **1926 字符**，逐句归类：

| 原句 | 类别 | 判定 |
|---|---|---|
| `# Context management` + 「对话变长时会摘要，不需要提前收尾」 | 环境说明 | **有益，可留** —— 它告诉模型"不要因为上下文长就急着结束" |
| 「有足够信息就行动，不要重新论证已确立的事实…」 | 能力准则 | **已在 `# Working style` 里保留** ✓ |
| 「You are operating autonomously…asking 'Want me to…?' 会阻塞」 | 流程指令 | **应继续剔除** —— 与 DSH 的弹窗机制冲突（原注释判断正确） |
| 「Exception: 用户在描述问题/提问时，交付物是你的评估，不要擅自修」 | **能力准则** | ⚠ **被误砍了** —— 这条与 DSH 的 ask_user/评估语义一致，**有益** |
| 「Before ending your turn, check your last paragraph…」 | 流程指令 | 应继续剔除（DSH 有自己的收尾规范）✓ |
| 「Before running a command that changes system state — 检查证据是否真的支持该动作」 | **能力准则** | **已在 `# Working style` 末句保留** ✓ |

`OFFICIAL_DYNAMIC_BEFORE_ENV` 实测 **3086 字符**，逐句归类：

| 原句 | 类别 | 判定 |
|---|---|---|
| 「Before your first tool call, say in a sentence what you're about to do」 | 流程指令 | ✓ 应剔除（原注释正确） |
| 「while working, give brief updates」 | 流程指令 | ✓ 应剔除 |
| 「Lead with the outcome」 | 流程指令 | ✓ 应剔除（与 DSH 输出纪律冲突） |
| 「being readable and being concise are different things…」 | 风格 | 中性，低优先 |
| 「Match the response to the question: 简单问题直接散文回答，不要标题分节」 | **风格+能力** | ⚠ **可考虑保留** —— DSH 的输出纪律也强调「不要过度结构化」 |
| 「Write code that reads like the surrounding code: 匹配注释密度/命名/惯用法」 | **能力准则** | ⚠ **被误砍了** —— 这是纯粹的代码质量准则，与流程无关，**有益** |
| 「Only write a code comment to state a constraint the code itself can't show」 | **能力准则** | ⚠ **被误砍了** —— 同上，直接影响代码产出质量 |
| 「For actions that are hard to reverse or outward-facing, confirm first…」 | **能力准则（安全）** | ⚠ **被误砍了** —— 「不可逆操作先确认」对 agent 是重要护栏 |
| 「Before deleting or overwriting, look at the target…」 | **能力准则（安全）** | ⚠ **被误砍了** —— 同上 |
| 「Report outcomes faithfully: 测试失败就说失败，跳过步骤就说跳过」 | **能力准则** | ⚠ **被误砍了** —— 直接对应「不许谎报」，**很有益** |

**⇒ 结论：原注释「那 5KB 是流程指令」的说法不准确 —— 里面至少有 6 条是纯能力准则/安全准则，被连带砍掉了。**

具体被误砍的 6 条（建议补回 `# Working style`）：

1. `Write code that reads like the surrounding code: match its comment density, naming, and idiom.`
2. `Only write a code comment to state a constraint the code itself can't show — never to say where it came from...`
3. `For actions that are hard to reverse or outward-facing, confirm first unless durably authorized...`
4. `Before deleting or overwriting, look at the target — if what you find contradicts how it was described... surface that instead of proceeding.`
5. `Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that...`
6. `Exception: when the user is describing a problem, asking a question... the deliverable is your assessment. Report your findings and stop.`

**影响评估：中**
这 6 条直接对应**代码质量、安全护栏、诚实汇报** —— 都是「能力强弱」而非「啰嗦与否」。它们被砍是**原注释的误判**。

**修复方案**
`zcode-official-identity.ts`，`OFFICIAL_STABLE_SECTIONS[2]`（即 `# Working style` 那一项）末尾追加上述 6 句。

⚠ **不要整段恢复 `OFFICIAL_DYNAMIC_*`** —— 里面确实有与 DSH 冲突的流程指令（原注释这点是对的）。**逐条摘取**，别整段回滚。

---

### 【P1-5】`metadata.user_id` / `thinking` 未启用 —— 思考链全程关闭

**现象**
dump 显示请求体**没有** `thinking` 字段。

**证据（实测，dump 原文）**

```
has thinking: False
has metadata: False
has temperature: False
has top_p: False
has stop_sequences: False
```

**代码证据**（`zcodeBridgeServer.ts`）：

```ts
...(body["thinking"] !== null && typeof body["thinking"] === "object"
  ? { thinking: body["thinking"] }
  : {}),
```

**只有调用方显式传才带** —— 而 DSH 适配器实测不传（`adapter.ts` 里 `opts["thinking"]` 从未被 DSH 填充）。

**影响评估：中（能力）**
原注释自己写了：「GLM-5.3 **默认开启扩展思考**……DSH 侧全程**无思考链**」。
不开启的理由是「思考会显著增加 ttft」—— 这是**延迟与质量的取舍**，不是 bug。

⚠ 但注意：**如果 ZCode 原生默认开思考，那「无思考」就是一条实打实的能力差距**。
建议做成**开关**而不是硬编码：
```
ZCODE_BRIDGE_THINKING=1 → 发 { thinking: { type: "enabled", budget_tokens: N } }
```

**修复方案**
`zcodeBridgeServer.ts`，搜 `...(body["thinking"]`：改为「调用方显式传」**或**环境变量开启：

```ts
...(body["thinking"] !== null && typeof body["thinking"] === "object"
  ? { thinking: body["thinking"] }
  : process.env["ZCODE_BRIDGE_THINKING"] === "1"
    ? { thinking: { type: "enabled", budget_tokens: Number(process.env["ZCODE_BRIDGE_THINK_BUDGET"] ?? 8000) } }
    : {}),
```

---

### 【P2-6】`metadata` 透传存在，但 DSH 从不填 —— `user_id` 归因缺失

**现象**
`passthroughSampling()` 里有 `metadata` 透传逻辑（实测代码存在）：

```ts
if (body["metadata"] !== null && typeof body["metadata"] === "object") {
  out["metadata"] = body["metadata"];
}
```

但 dump 实测 `has metadata: False` —— **因为 DSH 侧根本不传这个字段**。

**影响评估：低（仅归因/缓存亲和性）**
`metadata.user_id` 在 Anthropic 协议里用于**滥用归因**与**缓存亲和**。缺了它不会让模型变笨。
⚠ **但有一个潜在影响**：部分实现用 `user_id` 做**缓存分片键**。若上游如此，缺它可能**降低缓存命中率**——这条与 P0-2 **可能叠加**。
**标注为推测** —— 没有对照实验。

**修复方案**
若要补，在 `adapter.ts` 里构造一个稳定的 `user_id`（如机器指纹哈希 + 会话 ID）：
```ts
body.metadata = { user_id: <stable-hash> };
```
**优先级低**，除非 P0-2 验证后缓存仍不命中。

---

### 【P2-7】`max_tokens` 被钳到 32000，而插件声明 32768

**现象**
dump 实测 `max_tokens=32000`，而 `product.ts` 里声明 `maxTokens: 32_768`。

**证据（实测）**

```
model=glm-5.3-flash  max_tokens=32000  stream=True
```

桥侧钳制逻辑（`zcodeBridgeServer.ts`）：
```ts
const maxOutputTokens =
  typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens)
    ? Math.max(1, Math.min(32_000, Math.floor(body.max_tokens)))   // ← 32000 上限
    : undefined;
```

**影响评估：低**
768 token 的差（2.4%）几乎不会触发。但**声明与实现不一致** —— 若某次输出真到 32768，会被**静默截断**在 32000。

**修复方案**
对齐两处数字。要么把插件改 32000，要么把桥的上限提到 32768（需确认上游真实上限）。
LATENCY-FINDINGS 第十一节记过：`maxOutputTokens` 传超出模型取值域会报 `maxOutputTokens is outside the model option range` —— 所以**改之前要先确认上游上限**。

---

### 【P2-8】`bridge-last-request.ndjson` 每请求同步写盘 —— 注释与实现不符

**现象**
注释说「只在 `ZCODE_BRIDGE_DUMP_REQUEST=1` 时落盘」，实现是 `if (true)`。

**证据（实测，源码原文）**

```ts
/**
 * 只在 `ZCODE_BRIDGE_DUMP_REQUEST=1` 时落盘。
 */
if (true) {                                  // ★ 永远为真
  try {
    const { writeFileSync } = await import("node:fs");
    ...
    writeFileSync(joinPath(deps.dataBaseDir, "bridge-last-request.ndjson"), ...);
```

落盘文件实测 **29502 字节/请求**（`bodyLength: 29502`）。

**影响评估：低-中（性能）**
每次请求同步写 **~29 KB** 到磁盘。`writeFileSync` 会**阻塞事件循环**。
ⓘ 本项目 AGENTS.md 记载过同类坑：「同步 IO 阻塞事件循环 —— `appendFileSync` 每次请求都同步写盘。改为异步 + 节流」（`adapter.ts` 的 size-diag 已修，**桥侧这段没修**）。

**修复方案**
① **最小改动**：把 `if (true)` 改成真开关
```ts
if (process.env["ZCODE_BRIDGE_DUMP_REQUEST"] === "1") {
```
② **同时保留取证能力**（推荐）：改成异步 + 节流，并且**只写 body 摘要**而非全文：
```ts
if (Date.now() - lastDumpAt > 5000) { lastDumpAt = Date.now(); void writeFile(...) }
```
⚠ 这条**降低诊断能力**，是个取舍。建议先留着，等 P0-2 验证完再关。

---

### 【P3-9】first user message 的 `<system-reminder>` —— **已正确实现**（这条是澄清，不是缺陷）

任务方向 C 假设「日期注入缺失」。**实测证伪 —— 它是实现了的。**

**证据（实测，dump 原文）**

```json
// bridge-last-request.ndjson → body.messages[0]
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "<system-reminder>As you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is 2026-09-28.\n\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.</system-reminder>"
    },
    { "type": "text", "text": "把 lib/ 下三个文件里重复的 greet 实现..." }
  ]
}
```

**行为验证（实测）**

```
PS> 请求 system="You are ZCode, an interactive coding agent",
     user="What is today's date? Answer with just the date, no tools."
ELAPSED_MS=8923
CONTENT: 2026-09-28                    ← ★ 答对了
bridge: {"path":"fast","durationMs":8869,"upstreamStatus":200}
```

⇒ **日期注入工作正常，模型知道今天几号。方向 C 无缺陷。**

⚠ 附带发现：`withContextPrefix` 里有一段**实测会 429 的探针**（我试了「让模型复述 system-reminder 原文」，撞上 `{"code":3009,"msg":"model concurrency limit exceeded"}`）。**不是缺陷，只是探测选择不当** —— 记在这里避免后人重踩。

---

## 三、附带发现（非差距，但值得知道）

### 3.1 fast path 的准入条件是「system 是非空字符串」——不是探针前缀

`adapter.ts` 注释说「system 前面**必须**加上探针前缀」，但桥的实现是：

```ts
const isFastPathSystem = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
```

**任何非空字符串都行。**

**实测对照**：不带 `system` 的请求 → **落到慢的会话链路**（`bridge.chat.completed`，空回复，~230ms 就返回，因为会话链路要先建 task）。
带 `system`（哪怕只有 `"You are ZCode, an interactive coding agent"`）→ **走 fast path**（`bridge.path: "fast"`，真实回复）。

⇒ **插件加的探针前缀在功能上并非必需**（桥自己注入官方身份块），但**必须保证 `system` 非空**。`adapter.ts` 的注释与桥实现不一致，容易误导后人。

### 3.2 工具调用走的不是 `tool_use` 协议块，而是标记文本

`zcodeBridgeServer.ts` 里有 `TOOL_USE_MARK` / `TOOL_RESULT_MARK` 的文本扫描：

```ts
const iUse = text0.indexOf(TOOL_USE_MARK, cursor);
const iRes = text0.indexOf(TOOL_RESULT_MARK, cursor);
```

**实测的 messages 全部是纯字符串**，没有 `tool_use` / `tool_result` 结构化块：

```
=== roles ===
user user user assistant user assistant user user user user
=== messages[-2] content ===
"<path>...\\lib\\c.mjs</path>\n<type>file</type>\n<content>\n1: export const NAME = \"c\";..."
```

⇒ 工具往返是**把结构化块渲染成标记文本再解析回来**。这是**有损表示**（注释里也写了「提示词桥接」的对比）。**属于架构层面的已知做法，不列为缺陷**，但它意味着工具调用比原生 `tool_use` **多一层解析失败风险**。

---

## 四、★ 按投入产出比排序：最该先修的 3 件事

| 排名 | 做什么 | 投入 | 产出 | 风险 |
|---|---|---|---|---|
| **1** | **改默认模型 `GLM-5.3-Flash` → `GLM-5.3`** | **改 1 行 YAML + 重启 DSH** | **整天在用的模型从弱档换成实测最快最准档** | 额度消耗可能上升 —— **需用户拍板** |
| **2** | **给 `tools` 加 `cache_control`** | **改 1 个 `.map()`** | 每请求省约 5K token 重复 prefill；多步循环放大 5-10 倍 | 低（只加一个断点，不到 4 个上限） |
| **3** | **补 environment 段（含 `powered by the model named X/Y`）** | **改 1 个函数 + 1 个调用点** | 模型知道 cwd/平台/shell/OS/自身型号 —— 与第 1 条**联动生效** | 低；需真实探测 git 状态，别硬编码 |

**为什么是这三条**：

- **第 1 条是「白送的」** —— 配置里一个字，换来的是**整天**的模型档位差异。且证据是**时序性的**（07-16 点全 Flash，17 点手动切换后才出现 GLM-5.3），**无法用「负载不同」解释**。
- **第 2 条有最硬的字节级证据** —— dump 直接显示 `system` 三块都有 `cache_control`，`tools` 24 项一个都没有，且工具 schema 实测 19492 字节。**改法与风险都明确**。
- **第 3 条必须与第 1 条一起做** —— 否则改了模型名，模型自己还是不知道自己叫什么（实测已证明它现在只答得出笼统的「GLM」）。

**第 4 条（建议但非前三）**：把被误砍的 6 条能力准则补回 `# Working style`（P1-4）。这是**唯一一条我方原注释判断有误**的地方，值得单独排一次。

**明确不建议先做的**：
- P1-5（thinking）—— 延迟代价大，且是用户取舍
- P2-6（metadata）—— 影响未经证实
- P2-8（dump 写盘）—— 取证价值高，**先别关**

---

## 五、实测 vs 推测 一览

| 条目 | 实测？ | 依据 |
|---|---|---|
| P0-1 默认 Flash | **实测** | 日志分组统计 + 配置原文 + 时序（17 点才出现 GLM-5.3） |
| P0-2 tools 无 cache_control | **实测** | dump 原文（keys + hasCacheControl） |
| P0-2 的影响（冷缓存→慢） | **推测** | 代码事实 + `ttftMs` 与 `mintMs` 的相关性；**无 A/B** |
| P0-3 无 environment 段 | **实测** | dump 全文搜索 no-env + 函数体无引用 |
| P0-3 自我认知缺失 | **实测** | 问「你是什么模型」答「GLM」（笼统）|
| P1-4 Working style 位置 | **实测** | dump 的 block 内容顺序 |
| P1-4 6 条被误砍 | **实测（文本对照）** | 逐句比对 `OFFICIAL_DYNAMIC_*` 与 `# Working style` |
| P1-5 thinking 未启用 | **实测** | dump `has thinking: False` |
| P2-6 metadata 未传 | **实测** | dump `has metadata: False` |
| P2-7 max_tokens 32000 | **实测** | dump `max_tokens=32000` |
| P2-8 每请求写盘 | **实测** | 源码 `if (true)` + `bodyLength: 29502` |
| P3-9 日期注入已实现 | **实测（证伪「缺失」假设）** | dump messages[0] + 问日期答 `2026-09-28` |
| 3.1 fast path 准入 | **实测** | 不带 system → `bridge.chat.completed`；带 → `bridge.path: "fast"` |
| 3.2 工具走标记文本 | **实测** | dump messages 全是纯字符串 |

---

## 六、复现用的命令（留给下一个人）

```powershell
# ① 读桥端口与 token
Get-Content D:\zcode-glm5.3f\_oss_data\.zcode\v2\bridge-port.json

# ② 读「桥实际发给上游的完整请求体」（最重要）
$j = Get-Content D:\zcode-glm5.3f\_oss_data\bridge-last-request.ndjson -Raw | ConvertFrom-Json
$b = $j.body | ConvertFrom-Json
$b.PSObject.Properties.Name -join ", "          # 顶层字段
$b.system | ForEach-Object { "len=$($_.text.Length) cc=$($null -ne $_.cache_control)" }
$b.tools[0].PSObject.Properties.Name -join ", " # ← 验证 cache_control 缺失

# ③ 走 fast path 发一个真实请求（必须带非空 system，否则落会话链路）
$tok = (Get-Content D:\zcode-glm5.3f\_oss_data\.zcode\v2\bridge-port.json -Raw | ConvertFrom-Json).token
$body = @{ model="GLM-5.3"; system="You are ZCode, an interactive coding agent";
  messages=@(@{role="user";content="What is today's date?"}); max_tokens=200; stream=$false } |
  ConvertTo-Json -Depth 8
Invoke-RestMethod -Uri "http://127.0.0.1:60713/v1/chat/completions" -Method Post `
  -Headers @{Authorization="Bearer $tok"} -ContentType "application/json" -Body $body -TimeoutSec 180

# ④ 统计模型使用分布（验证 P0-1）
$log = 'D:\zcode-glm5.3f\_oss_data\.zcode\v2\logs\2026-09-28.log'
Select-String -Path $log -Pattern 'bridge\.fast_path\.stream_completed' |
  ForEach-Object { if ($_.Line -match '"modelId":"([^"]+)"') { $matches[1] } } |
  Group-Object | Select-Object Count,Name

# ⑤ 确认默认模型配置（P0-1 的修复点）
Select-String -Path "$env:APPDATA\in.dsh-plug.dsh-launcher\homes\0.1.7-rc.2\profiles\web\cordis.patch.yml" `
  -Pattern 'agent-default-model' -Context 0,4
```

⚠ **限流纪律**：上游有 `429 {"code":3009 model concurrency limit exceeded}` 与账号冷却惩罚。本次探测实际撞到过一次 429。**每个实验控制在 3-5 次请求内**，别压测。

---

## 七、本次未做 / 未验证的

1. **没有做 `cache_control` 的 A/B** —— 影响评估（P0-2）是推测。要坐实需：加断点前后，同负载对比 `ttftMs` 分布（注意 AGENTS.md 的判据原则：**同负载 A/B > 跨时段对比**）。
2. **没有验证环境段加入后是否影响 3012 准入** —— 原注释说「追加的块属于调用方内容那一类，不改变准入性」，但那是对 `# Working style` 说的。**environment 段是否也安全，未测**。改之前建议单发一次验证。
3. **没有测 `GLM-5.3` vs `GLM-5.3-Flash` 的实际延迟/质量差** —— 本报告引用的是 `LATENCY-FINDINGS.md` 的历史结论，**不是本轮复现**。
4. **没有改任何代码** —— 本报告是探路，修复方案给出的是**具体位置 + 代码片段**，未落地。按 AGENTS.md，落地需重建壳/插件并重启。
5. ~~`providerId` 在 `buildOfficialSystemBlocks` 里拿不到~~ —— **已核实：能拿到。**
   `resolveProviderId` 是**模块级函数**（`zcodeBridgeServer.ts:101`），调用点（同一函数内，第 3390 行附近）直接可见。
   实测注释：`grep -n 'resolveProviderId' zcodeBridgeServer.ts` → 101（定义）/ 2923 / 4063（调用）。
   ⇒ P0-3 的修复方案**可直接落地**。
