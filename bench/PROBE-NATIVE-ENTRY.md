# 探路结论：ZCode 原生侧可脚本化入口

> 实测日期：2026-09-28
> 桥运行中：端口 60713（取自 `_oss_data\.zcode\v2\bridge-port.json`），`instancePid: 22292`
> 本文件区分标记：**【实测】** = 我跑过/读过原文；**【推测】** = 未验证的推断

---

## 0. 一句话结论

**原生 CLI 入口存在且可用**（`apps/zcode-cli/packages/cli/dist/zcode.cjs`，`zcode 0.16.9`），
`-p/--prompt` 无头模式已实测能真正到达上游。
但**默认配置下它选了余额耗尽的 provider**（`account:bigmodel-individual-coding-plan`，错误码 1113），
所以当前**跑不通业务任务**——这是配置问题，不是入口缺失问题。

**关键判定**：`E:\zcoed\ZCode\resources\glm\zcode.cjs`（`run-cli.ps1` 指向的路径）**不存在**，
`run-cli.ps1` 目前是坏的。可用的 CLI 在**开源版仓库**里。

---

## 1. 问题一：原生 ZCode 有没有可脚本化的 headless/CLI 入口？

### 答案：有。三处入口逐一核实如下。

### 1.1 `D:\zcode-glm5.3f\scripts\run-cli.ps1` —— **指向一个不存在的文件（已损坏）**

读完 `run-cli.ps1`（共 34 行），它做四件事：
1. 清代理相关环境变量
2. 设 `$env:ZCODE_ENV = 'production'`、`$env:ZCODE_BASE_URL = $BaseUrl`（默认 `http://127.0.0.1:18777`）
3. 拼 `$cli = 'E:\zcoed\ZCode\resources\glm\zcode.cjs'`
4. `& node $cli -p $Prompt --no-color`，计时并打印 exit/stdout/stderr

**【实测】该脚本引用的 CLI 路径不存在**：

```
PS> Test-Path 'E:\zcoed\ZCode\resources\glm\zcode.cjs'
False

PS> Get-ChildItem 'E:\zcoed\ZCode\resources\glm' -Recurse -File
FullName                                                 Length
--------                                                 ------
E:\zcoed\ZCode\resources\glm\provider\zcode-builtin.json 188476
```

`resources\glm` 下**只有** `provider\zcode-builtin.json`，没有 `zcode.cjs`。
`resources\tools` 下只有 `cua-helper` / `ripgrep` / `ugrep`。

**【实测】官方版整个目录树里没有任何 `.cjs` / `.js` 文件**：

```
PS> Get-ChildItem 'E:\zcoed\ZCode' -Recurse -Include *.cjs,*.js -File -ErrorAction SilentlyContinue
（无输出）

PS> Get-ChildItem 'E:\zcoed\ZCode'
locales / resources / .zcode-install-manifest / Uninstall ZCode.exe / uninstallerIcon.ico
```

官方版顶层甚至没有 `ZCode.exe`（只有 `Uninstall ZCode.exe`），
也没有 `resources\app.asar`（`resources` 下只有 `app.asar.unpacked`，
且 `app.asar.unpacked` 内容只有 `node_modules`）。

**⇒ 结论：官方闭源版 `E:\zcoed\ZCode` 不提供 CLI 入口。它只是一个被解开/半解包过的资源目录。**
**⇒ `run-cli.ps1` 是写给一个不存在的目标的死脚本。（未修改官方版，只读探查）**

### 1.2 开源版仓库 —— **有，且已构建好**

**【实测】`D:\DSH-WEB\ZCode-official\package.json` 的 scripts 里有 CLI 相关项**：

```json
"build:sea": "pnpm --dir apps/zcode-cli build:sea",
"build:sea:all": "pnpm install && pnpm --dir apps/zcode-cli build:sea",
"release:cli": "pnpm --dir apps/zcode-cli run release",
```

**【实测】`apps\zcode-cli\packages\cli\package.json` 的 bin 字段**：

```json
{"zcode":"./dist/zcode.cjs"}   // name=@zcode/cli version=0.1.0
```

**【实测】产物已存在，且是完整的 16.7 MB bundle**：

```
D:\DSH-WEB\ZCode-official\apps\zcode-cli\packages\cli\dist\zcode.cjs   16753187 字节
D:\DSH-WEB\ZCode-official\apps\zcode-cli\packages\cli\dist\provider\zcode-builtin.json  186892 字节
```

**【实测】`node <该路径> --help` 输出（原文摘要）**：

```
zcode 0.16.9

Usage:
  zcode [command] [options]

With no command, zcode opens the full-screen TUI.

Commands:
  app-server Run the ZCode Protocol stdio app server
  commands   List custom slash commands
  doctor     Inspect runtime and packaging assumptions
  login [zai|bigmodel]  Sign in through browser authorization
  logout     Remove the shared Z.AI login credentials
  plugins    Manage plugins and marketplaces
  skills     List local skills
  tui        Open the terminal UI
  version    Print the CLI version

Options:
  -p, --prompt <text>  Run a single prompt without opening the TUI
  --target <text>  Run or set the session goal in headless mode
  --mode <mode>    Permission mode for prompts: build, edit, plan, or yolo
                   (default: yolo for --prompt)
  --cwd <path>     Run this command from the given directory
  --json           Print machine-readable JSON where supported
  --output-format  (已验证合法值: text | json | stream-json)
  --resume <sessionId>  Resume a persisted session
  -c, --continue        Resume the latest session for the current directory
  --disallowed-tools <tools...>  Remove whole tools for this run
  --attach <path>  Attach a local file to --prompt
  --enable-workflow / --memory-bench / --browser-use <headless> / --surface
  --force-mcs / --locale / --verbose / --no-color / --no-browser
  -h, --help / -v, --version
```

**参数定义源码**（`apps\zcode-cli\packages\cli\src\arguments.ts`，`parseGlobalArgs`）：
`prompt` 有 `short: "p"`，`strict: true`。

**【实测】`doctor` 子命令可用**：

```
PS> node <cli> doctor --no-color --json
{
  "cli": { "name": "zcode", "processName": "zcode-cli", "version": "0.16.9" },
  "runtime": { "arch": "x64", "cwd": "D:\\zcode-glm5.3f",
               "execPath": "C:\\Program Files\\nodejs\\node.exe",
               "node": "v24.20.0", "platform": "win32", "sea": false },
  "packaging": { "default": "node-bundle", "sea": "optional" }
}
```

### 1.3 有没有更多入口（`app-server` / `agent-server`）

**【实测】** `arguments.ts` 的 `isProtocolServerInvocation()` 显示存在两个协议子命令：

```ts
parsed.positionals[0] === "app-server" || parsed.positionals[0] === "agent-server"
```

即 CLI 还能以 **stdio 协议服务器**形态运行（`--stdio` / `--surface` 等选项也印证这一点）。
这条路径本次未实测跑通业务任务，但**它存在**，是后续可探索的第二个脚本化入口。

---

## 2. 问题二：实测它能否跑一个有客观对错的小任务？

### 答案：入口本身跑通了（真正到达上游），但**默认配置下被 provider 余额挡住**，任务未完成。

### 2.1 测试任务构造（客观对错：期望 `10`）

**【实测】** 在 `D:\zcode-glm5.3f\bench\_probe\t1\sum.mjs` 写入带 off-by-one bug 的文件：

```js
export function sum(arr) {
  let t = 0;
  for (let i = 0; i <= arr.length; i++) {   // ← bug: <= 应为 <
    t += arr[i];
  }
  return t;
}

console.log('sum=', sum([1, 2, 3, 4]));
```

**【实测】bug 复现**：

```
PS> node D:\zcode-glm5.3f\bench\_probe\t1\sum.mjs
sum= NaN          ← 期望 10
```

### 2.2 用 CLI 跑修复任务

**【实测】命令与结果**：

```powershell
$env:ZCODE_ENV='production'
$cli='D:\DSH-WEB\ZCode-official\apps\zcode-cli\packages\cli\dist\zcode.cjs'
node $cli -p "Fix the off-by-one bug in sum.mjs so that node sum.mjs prints sum= 10. ..." --cwd <t1> --no-color
```

```
=== exit=1 elapsed=1.8s ===
ZCode Built-in missing
ProviderBusinessError: [1113][余额不足或无可用资源包,请充值。][202609281724192eae1ed488134a74]
    at detectProviderBusinessError (zcode.cjs:2051:10053)
    ...
  code: 'PROVIDER_BUSINESS_ERROR',
  isProviderBusinessError: true,
  providerCode: '1113',
  providerId: 'account:bigmodel-individual-coding-plan',   ← ★ 关键
  providerKind: 'anthropic',
  providerMessage: '[1113][余额不足或无可用资源包,请充值。][...]',
  responseStatus: 429,
Error: Turn execution failed (traceId: f1593834-9f33-4ca5-b744-d8e4c42abe72)
```

**【实测】结果解读**：

| 观察 | 说明 |
|---|---|
| `elapsed=1.8s` 就拿到响应 | 网络链路通，**不是**连接失败 |
| `providerId: account:bigmodel-individual-coding-plan` | CLI 自己选了这个 plan |
| `responseStatus: 429` + `1113` | 上游明确应答：该 plan 余额/资源包耗尽 |
| `Turn execution failed (traceId: ...)` | CLI 的 agent turn 已经**启动**过 |

**⇒ 这不是 CLI 故障。CLI 已完整走完「解析参数 → 建 turn → 鉴权 → 发请求 → 收到上游应答」全链路。**
失败点在**账号余额**，不在入口能力。

### 2.3 对照：桥用的是另一个 provider（有余额）

**【实测】`_oss_data\.zcode\v2\quota-guard.ndjson`**：

```json
{"at":"2026-09-28T06:42:20.805Z","event":"tick","summary":"额度 9653.8 万（ZCode Trust Build，发现 1 个可领 plan，均已领取或不可领）","claimed":true,"remaining":96538255,"planName":"ZCode Trust Build","period":"one_time"}
```

**【实测】桥源码硬编码**（`zcodeBridgeServer.ts`）：

```
Line 57: const DEFAULT_PROVIDER_ID = "account:bigmodel-start-plan";
Line 91:   "account:bigmodel-start-plan",   // ALLOWED_PROVIDER_IDS 白名单首位
```

**【实测】桥正在正常工作的日志**（`_oss_data\.zcode\v2\logs\2026-09-28.log`）：

```
[zcode-bridge] bridge.fast_path.stream_completed {"modelId":"GLM-5.3-Flash","durationMs":15050,
  "sawToolCall":true,"ttftMs":4035,"genMs":11015,"deltaCount":425,...}
```

**⇒ 桥走 `start-plan`（余额 9653.8 万），CLI 默认走 `individual-coding-plan`（余额耗尽）。二者选了不同的 provider。**

### 2.4 尝试修正 provider 选择（未成功，但定位到确切原因）

**【实测】运行痕迹证明 CLI 被大量使用过**：

```
C:\Users\Administrator\.zcode\cli\
  db\db.sqlite          22454272 字节
  debug\                294 个 model-io-sess_*.jsonl
  exec\                 16 个 session 执行目录 + shell-snapshots
  log\zcode-2026-09-27.jsonl  35770442 字节
```

**【实测】这 294 个 session 全部是 `account:bigmodel-start-plan`**：

```
tools 数 | providerId                         | session 数
26       | account:bigmodel-start-plan        | 213
34       | account:bigmodel-start-plan        | 74
0        | account:bigmodel-start-plan        | 4
35       | account:bigmodel-start-plan        | 2
33       | account:bigmodel-start-plan        | 1
```

其中 **78 个 session 的工具面含 ZCode 原生工具**（`Bash`/`Edit`/`Write`/`Glob`/`Agent`/`AskUserQuestion`/`WebFetch`/`mcp__node_repl__js` 等 34 个），
且 `system` 是**官方三块结构**（7828 字符，与桥注释里记载的「官方三块 7599 字符」吻合），
首块原文 = `You are ZCode, an interactive coding agent`。

**【推测】** 这批 34 工具的 session 是**原生 CLI 曾经成功跑通**的痕迹（含原生工具面 + start-plan + 官方身份块）。
**但这批日志的归属无法百分百确证**——它们同时可能来自桥的会话链路（桥也会注入官方身份块）。
标为推测，不作为结论依据。

**【实测】失败根因链（源码 + 实测双重确认）**：

① `provider_config.json` 决定默认模型选择：

```
C:\Users\Administrator\.zcode\v2\provider_config.json
  "defaultModelSelection": {
      "providerId": "account:bigmodel-individual-coding-plan",   ← ★ 就是它
      "modelId": "GLM-5.3"
  }
```

② 而 `_oss_data` 下的同名文件**是空的**（只有 206 字节骨架，无 `defaultModelSelection`）。

③ CLI 的 selection 解析链（源码原文）：

```ts
// packages/bootstrap/src/app/runtime-config.ts:212  resolveInitialRegistrySelection()
const initial = resolveInitialModelSelection({
  configuredDefault: options.configuredDefaultModelSelection,
  registry: registry.getView(),
});
if (initial.source === "none") return undefined;      // ← 无默认选择 → 返回 undefined
```

```ts
// packages/bootstrap/src/app/provider-registry-model-runtime.ts:~40
if(!t.selection) throw Gr(fr.ConfigurationError,
    "Select a model before continuing", {recoverable:!0});
```

**【实测】** 我把隔离副本的 `provider_config.json` 改成 `start-plan` + `GLM-5.3-Flash`，
并把 `zcode-builtin.json` 全量拷入，结果：

```
Error: Model creation failed (traceId: 8cc99469-...)
Cause: Error: Select a model before continuing      ← 就是上面那句
```

④ 原因：`zcode-builtin.json` 只有 **provider 骨架**，没有模型目录与 `optionSpecs`：

```
account:bigmodel-start-plan:
  builtinModelIds: ["GLM-5.3-Flash","GLM-5.2","GLM-5-Turbo"]   // 注意：不含 GLM-5.3
  access: { type: "zhipu-account", mode: "start-plan", accountType: "bigmodel" }
  api: { type: "anthropic-messages", baseUrl: ".../zcode-plan/anthropic" }
  optionSpecs: null      ← 全部 8 个 provider 的 optionSpecs 都是 null
```

模型目录（含 `reasoningLevel` 档位）由**账户级快照在运行时注入**，纯文件配置喂不出 selection。
而 start-plan 的模型**必需 `reasoningLevel`**（桥源码注释原话：

```
zcodeBridgeServer.ts:509  /** reasoning level（start-plan 通道的模型必需）。缺省 "max"。 */
```

）——CLI 拿不到这个默认档位，selection 永远解析不出来。

⑤ **最终确认：CLI 没有 `--model` / `--provider` 命令行选项**。实测 `zcode.cjs` 里
`parseGlobalArgs` 的 options 表**完整列出**（原文）：

```js
options:{help:{short:"h"},json:{},"output-format":{},"no-color":{},"no-browser":{},
  "browser-use":{},"browser-executable":{},prompt:{short:"p"},"memory-bench":{},
  "enable-workflow":{},attach:{multiple:!0},cwd:{},locale:{},resume:{},target:{},
  "target-replace":{},continue:{short:"c"},force:{short:"f"},"force-mcs":{},mode:{},
  verbose:{},version:{short:"v"},"prepare-storage":{},stdio:{},surface:{},all:{short:"a"},
  available:{},"keep-data":{},scope:{short:"s"},sparse:{multiple:!0}}
```

**没有 `model`，没有 `provider`。** ⇒ CLI 的模型/provider 选择**只能来自持久化配置**，
无法在命令行上为单次调用指定。

---

## 3. 问题三：桥的「会话链路」是否等价于原生 ZCode 的 agent 循环？

### 答案：**执行循环等价，但工具面的归属不同 —— 不能直接当作原生能力的代理。**

### 3.1 会话链路是什么

**【实测】桥源码**（`zcodeBridgeServer.ts`）对 `runConversation` 的定义（L448-508）：

```ts
readonly runConversation: (params: {
  workspacePath: string;
  providerId: string;        // ← 桥显式传，绕开了 CLI 的配置解析
  modelId: string;
  reasoningLevel?: string;   // ← 桥自己补默认值 "max"
  messages: ZCodeBridgeMessage[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
  mcpServers?: ZCodeBridgeMcpServer[];
  allowTools?: boolean;
  onPartialText?: (accumulated: string) => void;
}) => Promise<{ text; usage?; finishReason?; toolCalls? }>;
```

且 L441-443 明确规定实现步骤：

```
1. zcodeTaskService.createTask({ workspacePath, modelSelection, v4Create: true })
2. zcodeTaskService.sendPrompt({ taskId, traceId, content, modelSelection })
3. 订阅事件流，收集 assistant 文本直到 turn 结束
4. 返回 { text, usage?, finishReason? }
```

**【实测】`reasoningLevel` 注释（L509）**：`/** reasoning level（start-plan 通道的模型必需）。缺省 "max"。 */`

**⇒ 会话链路 = 壳内 `createTask` + `sendPrompt`，是一次完整的 agent turn（建 task、跑 turn 循环、tools、快照）。**
这与原生 CLI 的 turn 循环**是同一套机制**——都走 `zcodeTaskService` 那层。

### 3.2 关键问题：壳内 agent 用的是自己的工具，还是把执行委托出去？

**【实测】桥源码给出了明确答案 —— 这是一个刻意的设计开关。**

L464-476 原文（`allowTools` 字段的文档）：

```
【实验】允许模型真的调用壳内工具。

默认 `false`：注入"不要调用任何工具"的前置说明 + 传 `toolDenylist`，
把壳当纯"代答"代理用。

置 `true`：两者都放开，模型可自由调用壳内工具。**用途是验证工具面透传**
—— 壳内工具真的执行，桥从 `onDynamicStreamEvent` 捕获结构化的
`tool_call` / `tool_call_update`，再透给调用方。

⚠ 放开意味着**壳内工具会真的执行**（含写盘/执行命令），且历史上是
  180 秒超时的主要来源。仅用于受控验证。
```

L516-517 原文：

```
会话链路（`runConversation`）把壳当**对话代理**用 —— 工具面进不去，
且壳内工具会真的执行，是 180 秒超时的根源。
```

L356-362 原文：

```
`zcodeTaskService.sendPrompt` 只接受 `toolDenylist`（隐藏工具），
...但 `createTask` 接受 `mcpServers`，且支持 `type: "http"`
```

L434 原文：

```
这是 DSH 工具面进入 ZCode 会话的**唯一**通道（见 {@link ZCodeBridgeMcpServer}）。
```

### 3.3 结论：会话链路**不能**当原生能力的代理

| 维度 | 原生 CLI / 原生壳 | 桥的会话链路（默认 `allowTools: false`） |
|---|---|---|
| agent 循环 | ZCode 自己的 turn 循环 | **同一个** `zcodeTaskService` turn 循环 ✅ 等价 |
| 工具面 | **壳内置工具**（Bash/Edit/Read/Write/Glob… 34 个） | **被 denylist 关掉**，只剩 DSH 经 MCP 注入的工具 ❌ 不同 |
| 工具执行者 | 壳自己执行 | `allowTools:true` 时才真的执行；默认不执行 ⚠️ |
| system 提示 | 官方三块（7599 字符） | 桥注入官方三块 + 调用方 system 追加在末尾 |
| 身份 | 原生 | 桥伪装（`buildOfficialSystemBlocks`）|

**⇒ 会话链路测的是「GLM 模型 + ZCode 的 turn 编排 + DSH 的工具面」，
不是「GLM 模型 + ZCode 的完整原生 agent」。**

**工具面是能力差异的主要来源之一**（原生 CLI 有 Bash/Edit/Glob/Grep，
桥链路默认没有），所以**用它当原生基线会低估原生能力**。

**可用的折中**：把 `allowTools` 置 `true`，壳内工具会真的执行、桥能捕获结构化 `tool_call`。
这时的会话链路**才接近**原生 agent（同样的 turn 循环 + 真实的壳内工具执行）。
代价是桥源码明确警告的「180 秒超时的主要来源」。

---

## 4. 问题四：`/v1/chat/completions`（fast path）与会话链路的工具调用能力差异

### 答案：**fast path 完整支持工具调用，且比会话链路更「原生」。**

### 4.1 fast path 确实支持工具调用

**【实测】桥源码 `zcodeBridgeServer.ts` L3266-3340** —— 从 OpenAI 形状映射到 Anthropic 形状：

```ts
const rawTools = Array.isArray(body.tools) ? body.tools : [];
const fastTools = rawTools.map((t) => {
    const fn = rec.function;
    if (fn === undefined || typeof fn.name !== "string" || fn.name.length === 0) return undefined;
    return {
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      input_schema: fn.parameters ?? { type: "object", properties: {} },
    };
}).filter(...)
```

L3403-3404 原文 —— 工具被真的塞进上游请求体：

```ts
...(fastTools.length === 0 ? {} : { tools: fastTools }),
...(fastToolChoice === undefined ? {} : { tool_choice: fastToolChoice }),
```

### 4.2 `tool_choice` 全量映射（源码 L3288-3340 原文）

```
"none"                              → 不传（且不启用工具面）
"auto"                              → { type: "auto" }
"required"                          → { type: "any" }
{type:"function",function:{name}}   → { type: "tool", name }
```

源码注释还记录了旧实现的缺陷（已修正）：

```
旧实现：只判断 `=== "none"`，其余取值**一律降级成 `{type:"auto"}`**
- `"required"` → 本应 `{type:"any"}` → 静默失效，模型可能不调工具直接闲聊
- `{type:"function",...}` → 本应 `{type:"tool",name}` → 指定工具被忽略
```

### 4.3 工具调用结果的回传（`sawToolCall`）

**【实测】源码 L3631 / L3756-3767**：

```ts
let sawToolCall = false;
...
// 兜底只看 `sawToolCall`，而它**只在 `content_block_start` with ...
// 除 `sawToolCall` 外，再看两个信号：
const hadToolBlock = sawToolCall || blockToToolIndex.size > 0;
```

**【实测】运行日志证明 fast path 真的在产出工具调用**：

```
[zcode-bridge] bridge.fast_path.stream_completed {"sawToolCall":true,"deltaCount":425,...}
[zcode-bridge] bridge.fast_path.stream_completed {"sawToolCall":true,"deltaCount":37,...}
[zcode-bridge] bridge.fast_path.stream_completed {"sawToolCall":false,"deltaCount":240,...}
```

`sawToolCall` 真实出现过 `true`。

### 4.4 两者的实质差别（这张表是本节的核心）

| 维度 | fast path（`/v1/chat/completions`） | 会话链路（`runConversation`） |
|---|---|---|
| 工具面 | **协议原生一等公民**（`tools` / `tool_choice` 直传上游） | 默认被 denylist 关闭 |
| 工具由谁执行 | **调用方（DSH）执行**，桥只管转发 | 壳内工具（`allowTools:true` 时真的执行） |
| 壳内工具是否会跑 | **不会** | `allowTools:true` 时**会**（含写盘/执行命令） |
| 会话状态 | 无壳内状态串扰，可并发 | 有 task/turn 状态 |
| 延迟 | 源码记载「本路径实测**中位 5.1 秒**」 | 源码记载「**8-28 秒**」，中位 23.2 秒 |
| 超时风险 | 低 | 历史上 180 秒超时的主要来源 |
| 是否需 captcha | 需要（每次现取，见 L524-526） | 需要 |

**【实测】源码原文对照（L519-522 与 L2783）**：

```
拿到 `{ apiKey, headers }` 后，桥就能**裸发标准 HTTP 请求**到上游：
  - 工具面（`tools` / `tool_calls`）是协议原生的一等公民，不再丢失
  - 无壳内工具执行，无会话状态串扰，可并发
  - 单轮延迟接近裸 API
```

```
会话链路（`createTask` + `sendPrompt`）**8-28 秒**；本路径实测**中位 5.1 秒**
```

### 4.5 一个重要的旁证：fast path 与原生壳的 system 结构一致

**【实测】源码 L3357-3388 原文**：

```
官方客户端发的是**三块** `{type:"text", cache_control:{type:"ephemeral"}}`：
  ① "You are ZCode, an interactive coding agent"（42 字符）
  ② stable 段（Harness + ZCode Desktop Context，约 2311 字符）
  ③ "\n\n" 前缀 + dynamic 段（约 5000 字符）
总计约 7.6 KB，请求体约 8.3 KB —— 与官方 8.3-8.6 KB 吻合。
```

而我在原生 session 日志里实测到的 system 是 **3 块 / 7828 字符**，首块正是
`You are ZCode, an interactive coding agent` —— **与源码记载吻合**。

**⇒ fast path 在「模型侧呈现」上，与原生壳是一致的（同一身份块、同一模型名小写形态 `glm-5.3-flash`）；
差别只在工具由谁执行。**

---

## 5. 可直接复制的调用命令

### 5.1 基础调用（当前可用，但会撞 provider 余额）

```powershell
# 清代理 + 设环境（照抄 run-cli.ps1 的做法）
foreach ($v in 'HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','https_proxy','http_proxy','all_proxy','NO_PROXY','no_proxy','NODE_TLS_REJECT_UNAUTHORIZED','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE') {
  Remove-Item "Env:\$v" -ErrorAction SilentlyContinue
}
$env:ZCODE_ENV = 'production'

$cli = 'D:\DSH-WEB\ZCode-official\apps\zcode-cli\packages\cli\dist\zcode.cjs'

# 单次无头任务
node $cli -p "你的任务描述" --cwd "D:\目标目录" --no-color

# 机器可读输出
node $cli -p "你的任务描述" --cwd "D:\目标目录" --json --no-color

# 流式 JSON
node $cli -p "你的任务描述" --cwd "D:\目标目录" --output-format stream-json --no-color

# 诊查
node $cli doctor --json
```

### 5.2 要让它真正能跑业务任务，必须先解决 provider 选择

**【实测】** 这是个**命令行无法覆盖**的问题（CLI 没有 `--model` / `--provider`）。
可行的方向（**均未经完整实测验证**，标注为待验证）：

```powershell
# 方向 A（未验证）：用 ~/.zcode 那套已被使用过的数据目录
$env:ZCODE_DATA_BASE_DIR = 'C:\Users\Administrator\.zcode'
node $cli -p "..." --cwd "..." --no-color
# 实测结果：Error: Model creation failed  （缺 ~/.zcode/v2/config.json 的 provider 段）

# 方向 B（未验证）：先让 CLI 走一次 /login，让它自己写入正确的 model selection
node $cli login bigmodel

# 方向 C（未验证）：先在 TUI 里 /model 选好模型（会持久化到 provider_config.json
# 的 defaultModelSelection），之后 -p 就能继承
node $cli tui
# 然后在 TUI 内输入: /model
```

**【实测】方向 A 已尝试并失败**（`Error: Model creation failed`），B/C 未实测。

### 5.3 若要评估「原生能力」，建议的对照口径

| 基线候选 | 命令/路径 | 等价性 |
|---|---|---|
| **原生 CLI（最优）** | `node <cli> -p "..." --cwd ... --mode yolo` | ✅ 真原生（自带 34 工具 + 官方 system） |
| 桥会话链路 `allowTools:true` | 桥内部 | ⚠️ 接近原生（同 turn 循环 + 真壳内工具），有 180s 超时风险 |
| 桥会话链路（默认） | 桥内部 | ❌ 工具面被关，会低估原生 |
| fast path | `POST /v1/chat/completions` | ❌ 工具由 DSH 执行，不是原生 agent |

---

## 6. 「实测到的」与「推测的」明确分界

### ✅ 我实测到的（有命令/输出/文件行号支撑）

1. `run-cli.ps1` 引用的 `E:\zcoed\ZCode\resources\glm\zcode.cjs` **不存在**（`Test-Path` → `False`）
2. 官方闭源版 `E:\zcoed\ZCode` 下**没有任何 `.cjs`/`.js` 文件**，也没有 `ZCode.exe`、`app.asar`
3. 开源版 CLI 产物存在且完好：`apps\zcode-cli\packages\cli\dist\zcode.cjs`（16753187 字节）
4. 该 CLI 版本 `0.16.9`，`--help` / `doctor --json` 均正常输出（原文已录）
5. `-p/--prompt` 存在，`--mode` 对 `--prompt` 默认为 `yolo`
6. **CLI 真的到达了上游**：1.8 秒内返回 `429 / 1113 / providerId: account:bigmodel-individual-coding-plan`
7. CLI 没有 `--model` / `--provider` 选项（`parseGlobalArgs` 的 options 表已完整列出）
8. `_oss_data` 的 `provider_config.json` 是空骨架；`~/.zcode/v2/provider_config.json` 的
   `defaultModelSelection` 指向 `individual-coding-plan`
9. `zcode-builtin.json` 只有 8 个 provider 骨架，`optionSpecs` 全为 `null`，无模型目录
10. `~/.zcode/cli/` 有 294 个 session 日志、22MB db、16 个 exec 目录——CLI 被实际使用过
11. 那 294 个 session **全部**是 `account:bigmodel-start-plan`；78 个含原生工具（Bash/Edit/…34 个）
12. 桥的 system 是官方三块结构；原生 session 的 system 实测为 3 块 / 7828 字符
13. 桥源码：`DEFAULT_PROVIDER_ID = "account:bigmodel-start-plan"`（L57），
    `runConversation` 显式接收 `providerId`/`modelId`/`reasoningLevel`（L448-476）
14. 桥源码明写会话链路「把壳当**对话代理**用 —— 工具面进不去」（L516-517）
15. 桥源码明写 fast path「工具面是协议原生的一等公民」（L520）
16. 运行日志里 `sawToolCall:true` 真实出现 —— fast path 确实产出工具调用
17. 桥当前正常工作：`bridge.fast_path.stream_completed` 持续输出，`pid:22292`

### ⚠️ 我推测的（未验证，不可作为结论依据）

1. **那 78 个含原生工具的 session 是「原生 CLI 成功跑过任务」的痕迹** ——
   它们的工具面、providerId、system 结构都指向原生，但**无法排除**它们出自桥的会话链路
   （桥也会注入官方身份块与 start-plan）
2. **原生 CLI 在 provider 选对后能跑通完整任务** —— 证据链（turn 已启动 + 上游已应答 +
   历史 session 痕迹）支持这个判断，但我**没有**拿到一次成功的原生任务执行
3. **`zcode-builtin.json` 的模型目录来自账户级运行时快照** —— 从
   `resolveInitialModelSelection` / `registry.getView()` 的代码形态推断，未直接观测到注入过程
4. **`allowTools:true` 时桥会话链路足够接近原生** —— 从源码注释推断，未实测
5. **方向 B/C（login / TUI 选模型）能解决 provider 选择问题** —— 未实测

### ❌ 我未能完成的

- **没有成功执行一次完整的原生 CLI 业务任务**（被 provider 余额挡住，且无法在命令行覆盖）
- 未实测 `app-server` / `agent-server` 协议入口
- 未实测 `allowTools:true` 的会话链路

---

## 7. 总结：「ZCode 原生能力」这个基线，我们到底能不能测？

**能测，而且入口是现成的 —— 但当前卡在账号配置，不在能力缺失。**

三条结论：

**第一，入口有。** 原生 CLI 就在我们自己的开源版仓库里：
`D:\DSH-WEB\ZCode-official\apps\zcode-cli\packages\cli\dist\zcode.cjs`（v0.16.9），
`-p` 无头模式一行命令就能跑。`run-cli.ps1` 指向的官方版路径是个**不存在的死目标**，
把脚本的 `$cli` 换成上面这个路径即可（但见第二点）。

**第二，先修配置再谈测量。** CLI 默认选中的 `account:bigmodel-individual-coding-plan`
余额已耗尽（1113），而桥用的 `account:bigmodel-start-plan` 余额还有 9653.8 万。
**这不是 CLI 能力问题，是 provider 选择问题。** 麻烦在于 CLI **没有 `--model` / `--provider` 参数**，
只能靠 `provider_config.json` 的 `defaultModelSelection` 或 `login` / TUI `/model` 来改。
**这是测基线之前必须先解决的一件事。**

**第三，会话链路不能当原生的代理。** 桥源码自己写得很清楚：会话链路「把壳当对话代理用，
工具面进不去」。它测的是「GLM + ZCode 的 turn 编排 + DSH 的工具面」，
而原生 CLI 是「GLM + ZCode 的 turn 编排 + **ZCode 自己的 34 个工具**」。
**工具面不同，这就是能力差异的主要来源。**
如果非要拿会话链路顶替，必须开 `allowTools:true`，代价是历史上 180 秒超时的老问题。

**推荐路径**：
① 先把原生 CLI 的 provider 选择修好（`login bigmodel` 或 TUI `/model`，让
`provider_config.json` 的 `defaultModelSelection` 落到有余额的 plan）；
② 用 `node <cli> -p "<任务>" --cwd <目录> --mode yolo --json` 跑同一组客观任务，
与 DSH 走桥的那一组做**同负载 A/B**；
③ 把 fast path 单独作为「工具由调用方执行」的第三条基线，不要与原生混为一谈。

---

## 附：本次探路未触碰的东西

- ❌ 未修改 `E:\zcoed\ZCode`（全程只读 `Get-ChildItem` / `Get-Content` / `ConvertFrom-Json`）
- ❌ 未杀 `ZCode.exe` 或任何 electron 进程（`instancePid: 22292` 全程存活，日志持续输出）
- ❌ 未启动/停止/重启桥（端口 60713 全程可用）
- ✅ 临时文件全部在 `D:\zcode-glm5.3f\bench\_probe\` 下
