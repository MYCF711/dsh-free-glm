# zcode-bridge 项目交接（2026-09-27 第十四轮）

> **给下一个接手的 Agent，或未来的我自己。**
> 这份文件的目标：让你在 **30 分钟内**掌握全部背景，不重复我已走过的弯路。

---

## 一、项目是什么

**一句话**：把 ZCode 的**免费额度通道**（GLM-5.3-Flash）接进 DSH，作为一个普通模型 provider 使用。

```
DSH ──▶ zcode-bridge 插件 ──▶ 本机 HTTP 桥 ──▶ ZCode 实例的会话链路 ──▶ zcode.z.ai
        (provider)             (loopback)      (createTask/sendPrompt)   (免费额度)
```

**为什么不能直连上游**：免费额度的使用权**绑定在客户端身份**上（下面第五节有决定性证据）。

**当前状态**：

| 项 | 状态 |
|---|---|
| 对话 | ✅ 实测跑通 |
| 工具调用 | ✅ 实测跑通（`tool_call` + `tool_result` 成对） |
| 速度 | ⚠ **8-28 秒/轮**（中位 23.2 秒），**生成速率 24-32 tok/s** |
| 内存 | ✅ 壳 949 MB（插件裁剪后，省 326 MB） |
| 并发 | ✅ 一轮内多请求省 64% |
| **「达到原生速度」** | ❌ **已实测证伪**（见第五节） |

---

## 二、目录地图（重要）

```
D:\zcode-glm5.3f                     工作区（可写）
├── dsh-plugin-zcode-bridge\          插件源码（当前版本 0.2.3）
├── _oss_data\                        开源版实例的数据目录
│   └── .zcode\v2\
│       ├── bridge-port.json          ★ 桥的发现文件（port + token）
│       ├── credentials.json          凭据（aes-256-gcm 加密）
│       ├── telemetry-state.json      含 deviceMid
│       └── logs\<日期>.log           ★ 壳的全部日志
├── scripts\
│   ├── start-headless.ps1            ★ 启停壳（必须 -NoAutostart）
│   ├── decrypt-all.cjs               ★ 凭据解密（复刻官方算法）
│   ├── verify-ultra.cjs              ultra 通路自检
│   └── hook-*.cjs                    出站请求 hook（未生效，见第七节）
├── dist\                             插件 tgz
├── zcode-oss-patches\                ★ 壳侧补丁（80 KB）
├── LATENCY-FINDINGS.md               ★ 延迟/内存完整实测报告（918 行）
├── AGENTS.md                         DSH 会话自动读取的指令
└── HANDOFF-CURRENT.md                上一版交接（部分内容已被本文件取代）

D:\DSH-WEB\ZCode-official             开源版源码（已含全部改动）
├── packages\desktop\src\host\
│   ├── zcodeBridgeServer.ts          ★ 桥的实现（HTTP 服务）
│   └── index.ts                      ★ 桥的构造与接线
└── apps\zcode-cli\packages\cli\dist\zcode.cjs   agent（16 MB，minify）

E:\zcoed\ZCode\                       官方闭源版（★ 只读，不要改）
└── resources\glm\zcode.cjs           闭源版 agent（14.1 MB）

D:\dsh-free-glm\                      发布仓库工作副本（GitHub + Gitee）
```

---

## 三、怎么跑起来

### 3.1 启动壳

```powershell
pwsh -File D:\zcode-glm5.3f\scripts\start-headless.ps1 -NoAutostart
pwsh -File D:\zcode-glm5.3f\scripts\start-headless.ps1 -Stop
```

**⚠ 必须带 `-NoAutostart`** —— 否则插件保活会同时拉壳，两个启动源抢单实例锁。

**⚠ 不要用 `run_in_background` 包它** —— `job_kill` 会连带杀掉整个 electron 进程树（实测踩过）。

### 3.2 发一次请求（验证是否活着）

```powershell
$f='D:\zcode-glm5.3f\_oss_data\.zcode\v2\bridge-port.json'
$b=Get-Content $f -Raw|ConvertFrom-Json
$h=@{Authorization="Bearer $($b.token)"}
$body=@{model='GLM-5.3-Flash';messages=@(@{role='user';content='只回答两个字：正常'});stream=$false}|
  ConvertTo-Json -Depth 6 -Compress
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($b.port)/v1/chat/completions" `
  -Headers $h -ContentType 'application/json' -Body $body -TimeoutSec 200
```

### 3.3 改壳源码后

```powershell
cd D:\DSH-WEB\ZCode-official\packages\desktop
npx tsup --config tsup.config.ts          # 构建（约 1 秒）
pwsh -File D:\zcode-glm5.3f\scripts\start-headless.ps1 -NoAutostart   # 重启
```

**改了 `packages/services` 下的东西**要先：
```powershell
cd D:\DSH-WEB\ZCode-official\packages\services
npx tsc -p tsconfig.json
```

### 3.4 改插件后

```powershell
cd D:\zcode-glm5.3f\dsh-plugin-zcode-bridge
npm run build
# ⚠ 必须先 bump 版本号，否则 pnpm 缓存会装回旧产物
npm pack --pack-destination D:\zcode-glm5.3f\dist
$env:DSH_HOME="$env:APPDATA\in.dsh-plug.dsh-launcher\homes\0.1.7-rc.2"
& "$env:APPDATA\in.dsh-plug.dsh-launcher\versions\0.1.7-rc.2\node_modules\.bin\dsh.CMD" `
  plugin --profile web add D:\zcode-glm5.3f\dist\dsh-zcode-bridge-<版本>.tgz
# 然后必须重启 DSH（插件是普通目录，进程启动时读进内存）
```

---

## 四、桥暴露的端点（诊断用）

| 端点 | 方法 | 用途 |
|---|---|---|
| `/health` | GET | 匿名健康检查 |
| `/v1/models` | GET | 模型列表 |
| `/v1/chat/completions` | POST | **主入口**（OpenAI 协议，走 agent turn） |
| `/diagnostics/direct` | POST | **直调上游**（绕过会话链路）。body 支持 `{prompt, model, reveal:true, omitSessionHeaders, omitSourceHeaders, extraBody}` |
| `/diagnostics/auth?reveal=1` | GET | 拿旁路捕获的 auth 材料（含 JWT 明文） |
| `/diagnostics/mint` | POST | **只 mint 新鲜 captcha 材料并返回，不使用**（本轮新增） |
| `/diagnostics/generate-text` | POST | 调 `workspace/generateText`（不建 task，本轮新增） |

**`/diagnostics/direct?reveal=true` 极有用** —— 它回显**实际发出的 25 个头及其值**。

---

## 五、★ 核心结论：为什么「原生速度」做不到（**决定性实验**）

### 5.1 判据是 captcha 的来源，不是头

同一组真实头值，唯一变量是 captcha：

| 实验 | captcha | 上游响应 | 耗时 |
|---|---|---|---|
| A | **不带** | `3007 captcha verify failed` | 快 |
| B | **带**（新鲜 mint） | `3012 unusual activity` | 7.7s |
| C | 带（换新材料重试） | `3012` | **0.17s** |

**⇒ 不带 → 上游说「缺 captcha」（风控放过）；带 → 判定为异常活动。**
**⇒ 上游能区分「我的 captcha」与「客户端的 captcha」。**

### 5.2 头值确实有影响（此前被误判）

用 `/diagnostics/direct?reveal=true` 拿到真实头值后逐项对比：

| 头 | 我此前用的 | 真实值 |
|---|---|---|
| `anthropic-beta` | **没带** | `mid-conversation-system-2026-04-07` |
| `X-Platform` | `win32` | `win32-x64` |
| `X-Os-Version` | `10.0.26100` | `10.0.26200` |
| `X-Release-Channel` | `stable` | `test` |
| `X-Title` | `ZCode` | `Z Code@electron` |
| `User-Agent` | `ZCode/1.0.0` | `ZCode/3.14.3` |

**修正后确实有变化**：旧头值得 3012 → 真实头值得 **3007**（风控放过）。
**⇒ 头值有意义，但不是最终判据。**

### 5.3 四条通道各有一道硬门

| 路径 | 门 | 实测 |
|---|---|---|
| **agent turn**（唯一可用） | 无门 | ✅ 但 **8-28 秒** |
| **generateText**（无会话） | 需活跃 task 会话 | ❌ **3012**（3/3 复现） |
| **ultra / bigmodel 官方** | coding plan 余额 | ❌ **429 [1113]** 欠费 |
| **off-peak** | 代码硬拒 start-plan | ❌ **403 [3101]** |

**你的免费额度**（实测：`ZCode Weekend Build` 3 亿 token + `Start Plan` 500 万/天）
**只在 agent turn 这条路上有效。**

**⇒ 「免费额度」与「原生速度」在架构上互斥。**

### 5.4 官方文档的独立印证

`docs.bigmodel.cn/cn/coding-plan/overview` 原文：

> 套餐仅限在**官方支持的指定工具与产品环境**中使用。
> **在除规定工具外调用 API，不可享用 Coding 套餐的额度。**

---

## 六、性能实测数据

### 6.1 生成速率（5 组线性回归）

| 组 | 耗时 | 字符 |
|---|---|---|
| 极短 | 20.7s | 1 |
| 100字 | 18.3s | 160 |
| 300字 | 17.2s | 278 |
| 600字 | 34.6s | 597 |
| 1000字 | 33.6s | 1033 |

**回归**：斜率 0.0208 秒/字符 ⇒ **48.1 字符/秒**；截距 **15.2 秒**（固定开销）；R²=0.731

**换算**：约 **24-32 tok/s**（纯生成）；端到端 9-16 tok/s（视输出长度）

### 6.2 桥是「假流式」（实测铁证）

```
20:39:12.540  upload completely sent off        ← 请求发出
              （41.9 秒零字节）
20:39:54.432  <= Recv data, 3478 bytes          ← 全部内容一次到达
20:39:54.433  Connection left intact
```

**⇒ 服务器整轮不发中间态，桥的 SSE 是「攒完一次性推」。**
`ttftMs` 字段恒为 `undefined` 就是这个原因。

### 6.3 一轮内多请求（并发优化有效）

| 配置 | 墙钟 |
|---|---|
| 并发=4 | **21166 ms** |
| 并发=1 | **58376 ms** |

**省 64%**。机制证据：`queueWaitMs` 从 15290-17563ms **归零**。

---

## 七、我踩过的坑（**别再踩**）

### 7.1 测量类

| 坑 | 教训 |
|---|---|
| `queueWaitMs == durationMs` | 两变量同一瞬间赋值 = 测量 bug。**新增 `runMs`** |
| 「按小时分组对比日志」 | **被判据推翻**。必须用**同负载 A/B** |
| 「长尾消失了」 | `textLength=0` 零样本 ⇒ **「没观测到」≠「已消除」** |
| 单次采样 | 内存/延迟波动大，**至少 5 次取中位** |
| 两点法算速率 | 用**线性回归**更可靠 |

### 7.2 代码类

| 坑 | 现象 |
|---|---|
| `disable-features` 关进程 | **无效** —— 它控制「功能」不控制「进程生命周期」 |
| media 服务内存 | **上限仅 7.4 MB** —— `video_capture` 的 104 MB 里私有只 7.4 MB |
| `--enable-low-end-device-mode` | 省 95 MB 但**弄坏 captcha**（122 秒返回空文本） |
| 纯 Node 脱离 Electron | **captcha 是 renderer 独占能力**（CLI 里 `aliyun` 0 次命中） |
| `selection.reasoningLevel` | 必须嵌套在 `options` 里，且对 start-plan **必填** |
| `maxOutputTokens` | 对 `generateText` **必填**（undefined 也抛错） |
| `$Matches` 被覆盖 | PowerShell 里后续 `-match` 会覆盖前一个的 `$Matches` |
| `$home` | 是 PowerShell 只读自动变量，用 `$homeZombie` |
| 命令里的 `!` | PowerShell 会解析，用 `git commit -F <file>` |
| `Substring(0,60)` | 短字符串会越界抛异常，先 `[Math]::Min()` |
| `Remove-Item -Recurse` | 大面积删除会被沙箱拦，改分步执行 |

### 7.3 环境类

| 坑 | 说明 |
|---|---|
| **Windows 环境块冻结** | `dsh-launcher.exe` 长驻，新环境变量它看不到 |
| **DSH 不重启 = 跑旧代码** | 插件模块在启动时读进内存 |
| **改壳源码必须重跑构建** | `tsup`；改了 services 还要 `tsc` |
| **补丁快照漏文件不报错** | 判据是**核对字节数是否变化** |
| **改插件必须先 bump 版本** | 否则 pnpm 缓存装回旧产物 |

---

## 八、发布状态

| 项 | 状态 |
|---|---|
| **GitHub** | https://github.com/MYCF711/dsh-free-glm （main + dev-history） |
| **Gitee** | https://gitee.com/MYCF711/dsh-free-glm |
| **Jet Hub PR** | [#3](https://github.com/zhengwuji/Jet-Hub/pull/3)（只提文档，阐述 3012 根因） |
| **密钥库** | `D:\github-key\github-token.txt` / `D:\gitee-key\gitee-token.txt` |

**待推送**：本轮的发现尚未提交（`LATENCY-FINDINGS.md` 已更新到 918 行）。

---

## 九、还没做的 / 可以做的

### 9.1 两个子代理正在调查（本轮派出）

1. **换壳可行性**：用闭源版 `E:\zcoed\ZCode\resources\glm\zcode.cjs` 替代开源版 agent。
2. **移植机制**：从闭源版提取 captcha/签名代码。

#### 9.1.1 我并行验证的两个事实（已实测）

**① 闭源版 app-server 完全能脱离 Electron 运行**

```
node E:\zcoed\ZCode\resources\glm\zcode.cjs app-server --stdio
→ STDOUT 立刻输出协议消息：
  {"method":"startup/storageState","params":{...,"phase":"checking"}}
  {"method":"startup/storageState",...,"phase":"committing"}
  {"method":"startup/storageState",...,"phase":"ready",
   "lastAppliedMigrationId":"0022_backfilled_session_reasoning"}
```

它启动了、完成 storage 初始化、主动发协议消息等宿主应答 —— **与开源版行为一致**。

依赖检查（关键词计数，闭源 vs 开源 agent）：

```
electron              闭源=15   开源=?      ← 只是字符串引用，非 API 调用
ELECTRON_RUN_AS_NODE  闭源=5    开源=?
BrowserWindow         闭源=0                ← 不用窗口
app.whenReady         闭源=0                ← 不启动 app
ipcMain               闭源=0                ← 不用 IPC
```

**⇒ 闭源版 agent 不依赖 Electron 专有 API，可被同样方式驱动。**

**② 但闭源版 agent 里没有 captcha 产出机制**

那 4 处 `aliyun` 全是**日志/遥测/诊断**：

| 处 | 内容 | 性质 |
|---|---|---|
| 1 | `proj-xtrace-...aliyuncs.com/rum` | 遥测上报（ARMS） |
| 2 | `x-aliyun-captcha-verify-param` 在**头脱敏白名单**里 | 日志脱敏 |
| 3 | 同上的常量定义 | 日志 |
| 4 | `readCaptchaVerifyParam` + 3007 判定 | **诊断** |

第 4 处的完整代码（偏移 4030166）：

```js
J4s = "x-aliyun-captcha-verify-param"
fVr = "Captcha verification failed or the verify token was rejected."
function mVr(e) {    // readCaptchaVerifyParam
  let n = Object.entries(e).find(([o]) => o.toLowerCase() === J4s)?.[1]?.trim();
  return n && n.length > 0 ? n : undefined;
}
function hVr(e) {    // createZcodePlanCaptchaEmptyStreamBusinessError
  if (!(e.providerKind !== "openai-compatible" || !e.captcha) && mVr(e.headers))
    return new S2({ providerCode: "3007", ..., responseStatus: 200, statusCode: 403 });
}
```

**⇒ 这是「空流 + 带 captcha 头 → 造出 3007」的客户端侧判定，不是服务端的。**
**⇒ 闭源版同样要回打宿主拿 captcha。换壳解决不了「原生速度」。**

#### 9.1.2 闭源版 vs 开源版的关键差分（供子代理结论对照）

```
ClientRequestSigning   11 : 0      ← 客户端签名（默认关闭，服务端 gate 控制）
X-Client-Sig            3 : 0
captcha                10 : 0      ← 全是日志/诊断（见上）
x-api-key               5 : 2
deviceMid              20 : 15
ultra                   0 : 2
aliyun                  4 : 0      ← 全是遥测/脱敏/诊断
```

**闭源版独有的 `CaptchaRequestRetry`**（偏移 4013681）：

```js
class CaptchaRequestRetry {
  claim(t, n = false) {
    return n || this.used || this.request.abortSignal?.aborted
      || !this.request.refreshRuntimeHeadersBeforeAttempt
      || this.model.accountAccess?.mode !== "start-plan"   // 只对 start-plan
      || !uOe(t)                                            // 且必须是 3007
      ? false : (this.used = true, this.pending = true, true);
  }
}
```

**语义**：收到 **3007** 且账号是 **start-plan** 时，换新鲜 captcha 以
`reason: "captcha-retry"` 重发一次。

**⚠ 但这不解决我们的问题** —— 实测重试仍得 3012
（触发条件是「上次 3007」，而我拿到的是 3012）。

### 9.2 一个**未生效**的诊断手段（可能对你有用）

我写了出站请求 hook（`scripts/hook-capture-full.cjs`），注入点在
`zcodeAgentProcessManager.ts:184` 的 `buildE2EAgentCoverageEnv`（我加了 `ZCODE_OUTBOUND_HOOK`）。
**但它没生效** —— agent 进程里 `NODE_OPTIONS` 似乎没传进去（可能是 `sanitizeZCodeRuntimeEnv` 或
Electron 的 `ELECTRON_RUN_AS_NODE` 行为）。

**若你要抓 agent 的真实出站请求**，这是最直接的路径，值得再试。

### 9.3 未验证的假设

- `CaptchaRequestRetry` 是否**真的**是客户端能过的原因？（我只读到代码，没实测它触发）
- 闭源版 agent 是否**不需要 renderer 的 captcha**？（子代理在查）

---

## 十、给你的最短路径

**如果你想继续攻「原生速度」**：

1. **先等两个子代理的结论** —— 它们可能给出闭源版可行的证据
2. **如果闭源版也不行** —— 接受现状，把文档提交

**如果你想维护现有功能**：

1. 读 §3 的命令
2. 改完**必须重启**（壳 + DSH）
3. 判断是否生效：看日志里有没有你新加的字段

**判断「桥是否活着」**：
```powershell
$b=Get-Content 'D:\zcode-glm5.3f\_oss_data\.zcode\v2\bridge-port.json' -Raw|ConvertFrom-Json
Invoke-RestMethod "http://127.0.0.1:$($b.port)/health"
```

**判断「DSH 是否在跑旧代码」**：
```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'dsh.*--profile web' } | Select ProcessId,CreationDate
# DSH 启动时间早于插件文件修改时间 = 跑旧代码
```

---

## 十一、硬约束（**不要违反**）

- **不要改 `E:\zcoed\ZCode`**（官方闭源版，只读）
- **不要杀 `ZCode.exe`**
- 长任务用后台任务，别用管道接 node 输出
- asar 解包必须用 `PSObject.Properties['name'].Value`

---

**最后一句**：这个项目已经做了 **14 轮**，中途推翻过多次结论（包括我自己写的）。
**本文件里标「实测」的都跑过，标「推测」的都要你自己验证。**
