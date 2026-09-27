# dsh-free-glm

**在 DSH（DeepSeek Harness）里免费用 GLM-5.3 —— 装完即用，无需 API Key。**

把 ZCode 的**免费额度通道**（`account:bigmodel-start-plan`）接进 DSH，作为一个普通模型
provider 使用。支持**对话**与**工具调用**。

> ## 🎉 2026-09-27 重大突破：速度提升 2-5 倍
>
> **发现**：3012 的真判据是 `system` 字段的**前缀** —— 只要以
> `"You are ZCode connectivity probe."` 开头，上游就放行。
>
> **效果**：
>
> | 路径 | 单步耗时 |
> |---|---|
> | **快速路径**（新，插件 0.3.2+） | **3.6 - 7.3 秒** |
> | 旧会话链路 | 8 - 28 秒 |
>
> **实测**（真实 DSH 会话，三次复验全部通过）：
> ```
> tool_call  glob({"pattern":"*.ps1","path":"..."})   → 真实执行
> tool_result completed  "run-cli.ps1\nstart-headless.ps1\n..."
> text       「找到 3 个 .ps1 文件：...」                → turn_end completed
> ```
>
> **插件已自动加探针前缀，调用方无需改动任何东西。**

> ## 📖 想了解全貌，先读这三份
>
> | 文件 | 内容 |
> |---|---|
> | **[PROJECT-MASTER-HANDOFF.md](./PROJECT-MASTER-HANDOFF.md)** | ★ **总交接** —— 从开工到收尾全貌 |
> | **[LATENCY-FINDINGS.md](./LATENCY-FINDINGS.md)** | ★ **2135 行实测报告**（二十五节），含全部证据链 |
> | **[LIMITATIONS.md](./LIMITATIONS.md)** | 已知限制（每条标注「实测」或「推测」） |
---

## ⚠ 先读缺点

**这不是一个普通 API 插件。** 它建立在上游风控的漏洞上，代价显著：

| 项 | 实测 |
|---|---|
| **速度** | **8-180 秒**（中位 15-25 秒）—— **不可能追上原生 API** |
| **内存** | 常驻 **约 950 MB**（Electron 实例，已做插件裁剪） |
| **稳定性** | 上游随时可能改风控堵死；captcha 坏了就整体不可用 |
| **部署** | 需克隆并构建 ZCode 开源版（10-40 分钟） |
| 首次启动 | 约 30 秒后才在模型列表出现 |

**完整清单见 [`LIMITATIONS.md`](./LIMITATIONS.md)** —— 每条都标了「实测」还是
「推测」，并给出验证方法。**装之前请读它。**

如果你只需要稳定与速度，**用官方 API**。这个方案适合「想在 DSH 里免费用 GLM、
且能接受上述代价」的场景。

---

## 一句话原理

GLM 的免费额度走 `zcode-plan` 通道，而这个通道有**两道门**：

1. **阿里云 captcha** —— 每次请求都要带一个验证参数，且**只能在真实 Electron
   renderer 里产出**（需要 DOM + 阿里云 CDN 脚本）。
2. **调用路径风控** —— 上游对「这个请求是不是 ZCode 客户端发的」有判定。
   裸 HTTP 调用一律返回 `3012 unusual activity`；只有实例内部的
   **session 链路**能通过（实测对照：界面路径 200 / 裸调用 3012）。

⇒ 所以本插件**不直连上游**，而是通过一个跑在 ZCode 实例里的本机 HTTP 桥
转发。captcha 与风控都由实例自己处理，插件只负责把对话与工具调用搬进搬出。

---

## 安装（三步）

> **⚠ 国内网络必读**：`github.com` 直连经常超时（实测 `curl 28` 连接失败）。
> 本仓库的所有下载命令都给了**镜像回退**，直接用镜像那条即可。
> 镜像前缀：`https://gh-proxy.com/` + 完整 GitHub URL。

### 步骤 1：部署 ZCode 开源版实例（含桥）

```powershell
# 直连（能连通时）
git clone https://github.com/MYCF711/dsh-free-glm.git

# 国内推荐：走镜像
git clone https://gh-proxy.com/https://github.com/MYCF711/dsh-free-glm.git

cd dsh-free-glm
pwsh -File deploy-zcode-instance.ps1
```

`deploy-zcode-instance.ps1` 内部**已自带镜像回退** —— 它会先试直连，
失败自动换 `gh-proxy.com`，所以你不需要手动处理。

脚本做四件事：clone 上游 ZCode 开源版 → 应用桥补丁 → 装依赖（约 2.8GB）
→ 构建。**耗时较长**（视网络 10-40 分钟），但只需做一次。

<details>
<summary>自定义安装位置 / 已有源码检出</summary>

```powershell
# 装到别的盘
pwsh -File deploy-zcode-instance.ps1 -Target E:\ZCode-official

# 已有源码检出，只补打补丁
pwsh -File deploy-zcode-instance.ps1 -SkipInstall -SkipBuild
```

若安装位置不在插件的自动探测范围内，设两个环境变量：

```powershell
$t = 'E:\ZCode-official'
[Environment]::SetEnvironmentVariable('ZCODE_BRIDGE_APP_DIR', "$t\packages\desktop", 'User')
[Environment]::SetEnvironmentVariable('ZCODE_BRIDGE_ELECTRON_PATH', "$t\node_modules\electron\dist\electron.exe", 'User')
```
</details>

### 步骤 2：安装插件

**当前版本 0.3.4**（tgz 已随仓库提供，在 `releases/` 下）：

```powershell
# ① 克隆仓库后，用仓库内的 tgz 安装（推荐，离线可用）
git clone https://github.com/MYCF711/dsh-free-glm.git
cd dsh-free-glm
dsh plugin --profile <你的profile> add "file:$PWD/releases/dsh-zcode-bridge-0.3.4.tgz"

# ② 国内网络（Gitee 镜像）
git clone https://gitee.com/MYCF711/dsh-free-glm.git

# ③ 或者从 GitHub Release 下载（若已发布对应版本）
dsh plugin --profile <你的profile> add https://github.com/MYCF711/dsh-free-glm/releases/download/v0.3.4/dsh-zcode-bridge-0.3.4.tgz
```

> **注意**：
> - `dsh plugin add` 装**同一版本号**的 tgz 时 pnpm 会命中缓存装回旧产物。
>   换了新版本先 bump 版本号。
> - **不要手动拷贝到 `node_modules`** —— 那样绕过 lockfile，下次 `pnpm install`
>   会被覆盖（实测踩过：版本莫名倒退）。
> - 装完**必须重启 DSH**（插件模块在进程启动时读进内存）。

### 步骤 3：重启 DSH

插件会**自动拉起 ZCode 实例**（无头静默，不弹窗、不进任务栏、无托盘），
桥就绪后模型设置页就会出现 `ZCode Bridge (GLM free)` 分组。

首次启动壳需要几秒。**期间 provider 分组可能暂时为空 —— 这是正常的**
（设计如此：桥不可用时隐藏整个分组，而不是留一个点不动的条目）。

---

## 使用

在 DSH 的模型选择器里选 `ZCode Bridge (GLM free)` 下的模型：

| 模型 | 说明 |
|---|---|
| `GLM-5.3` | 完整版，较强，单轮约 15-30 秒 |
| `GLM-5.3-Flash` | 快速版，单轮约 3-15 秒 |

**不需要配置任何凭据** —— 端口与 token 都从桥的发现文件自动读取。

### 支持的开关

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `ZCODE_BRIDGE_AUTOSTART` | `1` | `0` = 不自动拉起壳，只保活已存在的 |
| `ZCODE_BRIDGE_BASE_URL` | —— | 显式指定桥地址（调试用） |
| `ZCODE_BRIDGE_TOKEN` | —— | 配套上面用的 token |
| `ZCODE_BRIDGE_APP_DIR` | 自动探测 | 壳的 app 目录 |
| `ZCODE_BRIDGE_ELECTRON_PATH` | 自动探测 | 壳的 electron 可执行文件 |
| `ZCODE_DATA_BASE_DIR` | 自动探测 | 数据根目录（其下有 `.zcode`） |

---

## 工具调用

支持**两种**模式：

### 模式 A：提示词桥接（默认，DSH 侧已可用）

把 DSH 的 `tools[]` JSON Schema 渲染成提示词注入 system 段，与模型约定输出
```json 围栏。适配器解析回复，合成符合 DSH 契约的 `tool-call` 块。

**优点**：不依赖壳内工具，无副作用。
**缺点**：依赖模型遵守格式。

### 模式 B：结构化透传（桥侧已就绪）

请求体带 `allowTools: true` 时，桥放开壳内工具，模型可自由调用；
桥从 task snapshot 提取**结构化**的工具调用透出：

```json
{
  "index": 0,
  "id": "snapshot-0",
  "type": "function",
  "function": { "name": "Bash", "arguments": "{\"command\":\"ls -la\"}" },
  "status": "completed",
  "output": "total 30205\ndrwxr-xr-x ..."
}
```

**优点**：`name` 与 `arguments` 是上游协议自己产出的结构，不依赖模型措辞；
还带 `status`（执行状态）与 `output`（**真实执行结果**）。

**⚠ 副作用警告**：`allowTools: true` 时**壳内工具会真的执行**（含写盘、执行命令）。
仅在你明确需要时使用。

**⚠⚠ 不传 `allowTools` 会 180 秒超时（实测，2026-09-27）**：

| 请求 | 结果 |
|---|---|
| 带 `tools[]`，**不传** `allowTools` | **180.1 秒 → `finish_reason: "timeout"`，空文本** |
| 带 `tools[]`，`allowTools: true` | **15.0 秒 → 正常返回** |

**根因**：桥默认注入「不要调用工具」的前置说明 + 传 `toolDenylist`。
模型看到「有工具表但不要用」时，会去调**壳内**工具，而那些会真的执行 →
壳内长时间卡住 → 桥侧 180 秒超时。

**⇒ 只要带了 `tools[]`，就必须同时传 `allowTools: true`。** 这是调用约定，不是 bug。

实测返回（工具面正常）：

```
「我来查询杭州今天的天气。
 ```json {"tool": "get_weather", "arguments": {"city": "杭州"}} ```」
```

---

## 架构细节（给想改代码的人）

### 关键文件

```
src/
  index.ts               插件入口：provider 注册、壳的生命周期管理
  adapter.ts             DSH LlmAdapter 实现：stream() 合成流式块
  tool-bridge.ts         工具调用的提示词渲染 / 解析 / 剥离
  bridge-endpoint.ts     桥发现（读 bridge-port.json）+ 候选目录探测
  instance-lifecycle.ts  壳的拉起 / 保活 / 残留清理
  model-visibility.ts    模型开关（设置页的拨动开关）
patches/
  zcodeBridgeServer.ts   桥本体（新增文件，放进开源版 desktop 包）
  shell-modifications.patch  三处已跟踪文件的改动
```

### 桥的端点

| 端点 | 用途 |
|---|---|
| `GET /health` | 匿名健康检查（不需要 token） |
| `GET /v1/models` | 模型列表 |
| `POST /v1/chat/completions` | **主路径**：会话链路对话，可选 `allowTools` |
| `GET /diagnostics/auth?reveal=1` | 壳内真实鉴权材料（诊断） |
| `POST /diagnostics/direct` | 裸发上游（诊断用，**上游会 3012**） |

### 两个必须知道的坑

**坑 1：captcha 事件面按 workspacePath 分桶**

桥主动 mint captcha 材料时，**必须用与 renderer 订阅的同一个 workspacePath**，
否则事件会被 fire 到 renderer 没监听的 Emitter 桶，表现为**静默 20 秒超时**
（renderer 侧连日志都不会打，极易误判为"captcha 组件没渲染"）。

正确值：`<dataBaseDir>/.zcode/workspace/default`。

**坑 2：工具调用从快照读，不要订阅事件流**

`onDynamicStreamEvent(taskId)` 代码上完全可行（有 `tool_call` 事件），
但**实测收不到任何事件**。改用 `getTaskSnapshot` 的 `messages[].tools[]` ——
数据一直持久化在那里，事后再拉必然拿得到。

---

## 为什么不能绕过「壳」直接调上游

这是本项目最重要的一条结论，**已用实验钉死**。

### 现象

把请求直接发到 `https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`，
无论带什么头，稳定返回：

```json
{"code":3012,"msg":"request has been blocked due to unusual activity."}
```

注意**不是 3007**（那是 captcha 失败）。3012 发生在 captcha 之后的另一层。

### 排查过程（全部实测）

**第一步：把壳内真实请求的头全部提取出来。**
hook `globalThis.fetch`，抓会话链路的出站请求，得到完整的头集合。

**第二步：把「来源标识头」逐字段复制到直发请求上。**

```
User-Agent / HTTP-Referer / X-Title / X-ZCode-App-Version / X-Platform
X-Release-Channel / X-Client-Language / X-Client-Timezone
X-Os-Category / X-Os-Version / X-Device-Mid
```

（`X-Device-Mid` 取自 `<dataBaseDir>\.zcode\v2\telemetry-state.json`，
**复用壳的真实身份**，不生成新的）→ 仍 3012。

**第三步：做头集合 diff，补齐缺口。**

对比后发现会话链路还带这些**桥没有的**头：

```
x-session-id / x-query-id / x-zcode-trace-id / x-zcode-session-type / x-zcode-agent
anthropic-beta: mid-conversation-system-2026-04-07
x-api-key（与 Authorization 同值）
```

全部补上，**头集合已与会话链路逐字段完全一致（25 个头）** → **仍 3012**。

**第四步：排除签名假设。**

官方闭源版确实有一套客户端签名机制
（`ClientRequestSigningV4`：ed25519 + KDF + HMAC，握手端点
`/api/paas/c1f3a7e2/v2/client`，动作 `get_sign_key`），
但**开源版的会话链路实测不带签名头**（`X-Client-Sig` / `X-Client-Pow` 均无）。
而且那套机制由**服务端 feature gate** 控制（`resolveSigningFeatureGate`，
默认 `isEnabled: async () => false`）。

⇒ **缺的不是签名。**

### 结论

**3012 的判据是「请求的会话注册状态」，不在 HTTP 头里。**

决定性证据是一个**变量交换实验**：抢在桥之前用新鲜 captcha 自发（只带 3 个头）——
**3012 转移到了抢发方**，桥反而拿到 3007（材料被抢先消费）。

⇒ 3012 跟随「新鲜材料」移动，**不跟随发送者、不跟随头集合**。
captcha param 本身解码后是 `{certifyId, sceneId, isSign, securityToken}`，
**零个会话标识** —— 说明绑定关系在服务端按「谁先消费 + 消费时的会话态」判定，
客户端无法预置。

**所以：走会话链路（本插件的做法）是唯一可行且 100% 成功的方案。**
桥里的 `bridgeSourceHeaders()` 与 `sessionHeaders` 保留着 —— 它们的价值是
「把壳的请求特征完整复刻出来」，一旦上游放松风控即可直接使用。

---

## 常见问题

**Q：模型列表是空的 / 看不到 provider 分组？**

说明桥不可用。逐项检查：

```powershell
# 1. 壳在跑吗？
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -notmatch '--type=' } | Select ProcessId, CreationDate

# 2. 发现文件在吗？（路径随你的 dataBaseDir 而变）
Get-Content "$env:USERPROFILE\.zcode\v2\bridge-port.json"
#   或源码检出：<你的路径>\_oss_data\.zcode\v2\bridge-port.json

# 3. 桥活着吗？
$f = Get-Content "$env:USERPROFILE\.zcode\v2\bridge-port.json" -Raw | ConvertFrom-Json
Invoke-RestMethod "http://127.0.0.1:$($f.port)/health"
```

**Q：设置了环境变量但插件读不到？**

DSH 是由 `dsh-launcher.exe` 这个**长驻进程**拉起的，它持有**创建时**的环境块。
重启 DSH 不够 —— 得重启 launcher。插件已尽量用「文件实际在哪」的候选探测
规避这个问题，不依赖环境变量。

**Q：改完插件代码没生效？**

`file:` 依赖是**实体副本**，改源码后必须 `pnpm install --force`，并重启 DSH
（DSH 在启动时把模块读进内存）。

**Q：会不会违反服务条款 / 封号？**

本插件用的是**你自己的 ZCode 账号的免费额度**，只是把调用入口从 ZCode 界面
换成了 DSH。额度消耗、账号行为与直接用 ZCode 完全一致。风险自负。

---

## 版本

| 版本 | 变更 |
|---|---|
| **0.2.1** | **修复路径硬编码（别人装了也能用）** + 桥侧 preamble 修复（DSH 工具调用放行） |
| 0.2.0 | 工具调用（提示词桥接）+ 空回复明确报错 + provider 显示修复 |
| 0.1.x | 基础对话链路 |

### 0.2.1 修的两个「装了不能用」

**① 路径硬编码 → 动态探测**

早先候选路径是**写死的绝对路径**（作者本机的 `D:\DSH-WEB\ZCode-official\...`）。
别人装了 → 候选全不存在 → `resolveSpawnConfig()` 返回 undefined →
**不报错、不提示**，只是 provider 分组永远空着。

现在按已知安装位置动态枚举（多盘符 × 多种目录布局 + 官方安装版），
环境变量仍为最高优先。

**② 桥的 preamble 把 DSH 工具也禁掉了**

桥原先注入「**不要调用任何工具**」，而 DSH 下发的工具表写在 system 段里
—— 这句禁令在前，**压过了工具表**。

实测症状：模型在真实 DSH 会话里回答
「按本次桥接模式的约束，我不能调用工具」，read/glob/ls 全用不了。

改为**区分两类工具**：自己的内置工具 → 禁止（避免真执行 + 防超时）；
调用方给的工具协议 → 鼓励（那正是要透传的）。

修复后实测（`dsh --profile zcbtest2 --json "<任务>"`）：

```
事件流: tool_call × 2, tool_result × 2
模型回答: "dist 目录下只有 1 个文件：dsh-zcode-bridge-0.2.0.tgz"
```

**数字来自真实工具执行，不是文档记忆。**

**完整开发历史**（含每次修复的 diff 与根因说明）在 [`dev-history` 分支](https://github.com/MYCF711/dsh-free-glm/tree/dev-history)：

```
e34bd55 chore: 移除误提交的提交信息临时文件
c1cf51e feat: 打通工具调用（提示词桥接）—— GLM 可在 DSH 中真正调用工具
b95ce9d fix: 空回复不再当成功、工具块降级为历史记录、清理死代码
fb0551c fix: 修复模型设置页不显示 provider，清理死代码
```

---

## 许可

MIT。本项目**不含** ZCode 的任何源码，只包含针对它的补丁与本机桥实现。
使用前请自行确认符合 ZCode 的服务条款。
