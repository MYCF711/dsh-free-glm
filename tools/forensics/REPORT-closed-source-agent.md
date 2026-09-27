# 闭源版 agent（zcode.cjs）替代可行性调查

调查者：独立工程调查员（只读）
时间：2026-09-27
范围：`E:\zcoed\ZCode\resources\glm\zcode.cjs`（只读）、`D:\DSH-WEB\ZCode-official`（只读）、
`D:\zcode-glm5.3f\zcode-oss-patches\`（只读）

---

## 结论先行

**换闭源 `zcode.cjs` 不能解决 8–28 秒的问题，而且会把它变得更糟。**

三条独立成立的硬事实：

1. **闭源 cjs 里 0 处 Electron 主进程 API**（`BrowserWindow` / `ipcMain` / `webContents` /
   `app.whenReady` / `app.isPackaged` 全部为 0），**0 处 `require("electron")`**，
   58 个外部模块全是 `node:*`。它是纯 Node 程序。
   ⇒ 它是**客户端**，不是**服务端**。它没有、也不可能"自己跑 captcha"。

2. **闭源版零 captcha 生产代码**。10 处 `captcha` 全部是**读取/诊断/错误分类**：
   读 `x-aliyun-captcha-verify-param` 头、判断 header 长度、识别 3007 业务码、脱敏头日志。
   没有一处调用阿里云 SDK、没有 `sceneId`、没有 `startTracelessVerification`。
   ⇒ captcha **仍然只能由 Electron renderer 产出**。闭源版不比开源版多任何东西。

3. **闭源版自己也要走 renderer**。`ZJo`（`createProviderRuntimeHeadersPort`，
   偏移 14434058）实现是 `e.requestClient("interaction/requestProviderRuntimeHeaders", …)`
   —— 把请求发给 renderer，等应答，超时 `BZa = 180000`（180 秒）。
   **这与开源版完全同构**，错误码 `-32022` 就是超时。
   ⇒ 闭源版**不是**"不需要 captcha"，而是"由 Electron 侧提供 captcha"。

**一句话**：闭源版之所以"能工作"，是因为它有那 326 MB 的 `app.asar` + Chromium renderer
提供 captcha；把 `zcode.cjs` 单独拿出来跑，captcha 就没了，它会以**同样的方式**、
甚至**更长的超时（180 秒）**卡住。

---

## A. 架构定位：zcode.cjs 是什么

### A1. 它是纯 Node 程序，不含 Electron

| 检索项 | 命中次数 |
|---|---|
| `require("electron")` | **0** |
| `BrowserWindow` | **0** |
| `ipcMain` | **0** |
| `webContents` | **0** |
| `app.whenReady` | **0** |
| `app.isPackaged` | **0** |
| `process.resourcesPath` | **0** |
| `.asar` | **0** |
| `require.resolve(` | **0** |
| `__dirname` | 3（全部是 `path.dirname(process.argv[1])` 类拼接，非资源定位） |

**外部 require 全部 58 个，全是 Node 内置**（按频次）：

```
node:path 133   node:crypto 62    node:fs/promises 56   node:fs 49
node:os 38      fs 21             node:child_process 18 stream 15
util 14         node:util 12      path 12               net 9
os 9            events 8          zlib 7                tls 7
...（其余为 http/https/dns/tty/perf_hooks/v8 等）
```
唯一非 Node 内置的是 5 个 `ajv/*`（JSON Schema 校验运行时，已内联）。

`E:\zcoed\ZCode\resources\glm\.node-bundle-meta.json`：
```json
{ "runtime": "electron-node", "entry": "zcode.cjs",
  "platform": "win32-x64",
  "source": "apps/zcode-cli/packages/cli/dist/zcode.cjs" }
```
`"runtime": "electron-node"` 指的是"**由 Electron 的 Node 运行时执行**"，
不是"**这个文件里有 Electron**"。这两件事必须分清。

### A2. 它依赖一个**外部** provider 配置文件

紧挨着 `zcode.cjs` 放着：

```
E:\zcoed\ZCode\resources\glm\provider\zcode-builtin.json       188476 字节
E:\zcoed\ZCode\resources\config\provider\zcode-builtin.json    188476 字节（同内容）
```

解析逻辑（偏移 1069481）：
```js
let n = path.dirname(path.resolve(entrypoint));
let o = [ join(n, "provider", "zcode-builtin.json"),
          path.resolve(n, "../../../../../config/provider/zcode-builtin.json") ];
let s = o.find(a => fs.existsSync(a));
if (s) return s;
throw new Error("无法定位 CLI ZCode Built-in Provider Config：" + o.join(", "));
```
还有 `node:sea` 分支（`e.sea.getAsset("zcode-provider/zcode-builtin.json")`），
但 `zcode.cjs` 明确不是 SEA（`.node-bundle-meta.json` 写 `"entry": "zcode.cjs"`，
C2o 分支用 `process.getBuiltinModule("node:sea").isSea()` 探测，为 false 时走文件路径）。

**结论**：单独拷 `zcode.cjs` 会直接抛
`无法定位 CLI ZCode Built-in Provider Config`，必须连 `provider/` 目录一起带上。

### A3. `app-server` 协议与开源版**逐字一致**

| 面 | 闭源 | 开源 |
|---|---|---|
| protocol 方法表 | 77 个 | 77 个 |
| `session/create` | ✓ | ✓ |
| `workspace/generateText` | ✓ | ✓ |
| `interaction/requestProviderRuntimeHeaders` | ✓ | ✓ |
| `app-server` 子命令 | ✓ | ✓ |
| `-p/--prompt` | ✓ | ✓ |
| `--surface` | ✓ | ✓ |
| `--version` | `0.16.9` | — |

闭源侧定义位置：
- 方法表 `va = {...}`：**偏移 784335**
- `app-server` case 分支：**偏移 14806633** → `return await xoc(e,T,L,u,n.values["prepare-storage"]===!0)`
- `xoc`（= `runZCodeProtocolCommand`）定义：**偏移 14803016** →
  `await (n.runZCodeProtocolAgent ?? (await Qg()).runZCodeProtocolAgent)({...})`
- `runZCodeProtocolAgent` 实现：**偏移 14685631**（导出名 `NXo`）

**这 77 个方法名逐个比对完全一致**，包括 `startup/storagePath`、`startup/storagePathReady`、
`computer-use/operation-event` 这些冷门项。

⇒ **协议面完全兼容。我们的桥不需要改一行就能说上话。**

### A4. 但 `app-server` 启动时会拉起**远超协议本身**的子系统

`runZCodeProtocolAgent` 的启动序列（偏移 14680114 起，约 4000 字符）包含：

```js
// ① 进程级 Provider Registry（读 zcode-builtin.json + SQLite）
U = await N3e({ ..., create: () => Ykt(z) });
// ② providerEndpointRoutingPort；sourceTitle 硬编码 "electron"
ie = e.providerEndpointRoutingPort ?? n3e({ appVersion, env, ..., sourceTitle: "electron" });
// ③ MCP 宿主（features.mcp !== false 时）
w = Pto({ clientVersion, env, logger, network: {...}, officialMcpAuth: ze, telemetry: I, workingDirectory });
T = w?.acquireLease({ leaseId: "protocol-settings" });
// ④ 浏览器控制端口
b = Nkt({ browserControlPort: Tt.browserControlPort, platform });
await N3e({ ..., create: () => Fe.ready });
// ⑤ 原生模块会话存储 dtt({dbPath: jie(B)})
g = await N3e({ ..., create: () => lPn({ dbPath: jie(B), ... }) });
// ⑥ 遥测（ARMS / resource 采样）
I = B.config.features.mcp === false ? void 0 : xmn({ idSalt: q ?? l.traceId, ... });
```

**这解释了 AGENTS.md 里"纯 Node 脱离 Electron 能启动、但 `--prompt` 报
`Model creation failed`"** —— 不是启动失败，是**模型请求阶段缺 renderer 材料**。

`zcode.cjs --version` 能跑（exit 0），只证明 CLI 骨架能加载；
**不能证明 app-server 或 `-p` 能完成一次模型调用**。

---

## B. captcha：闭源版**没有**任何替代机制（这是本次调查最重要的结论）

### B1. 闭源版 10 处 `captcha` 逐处定位与作用

| # | 绝对偏移 | 作用 | 类别 |
|---|---|---|---|
| 1 | 768288 | `Ysr = enum(["model-request","captcha-retry"])` —— 头请求的 reason 值域 | 协议 schema |
| 2 | 3986583 | `RFs` 敏感头集合（脱敏用）含 `x-aliyun-captcha-verify-param` | 日志脱敏 |
| 3 | 3989814 | `LFs(e)` → `NFs = "x-aliyun-captcha-verify-param"`；返回 `{hasCaptchaVerifyParam, captchaParamLength}` | **诊断（只读）** |
| 4 | 3994710 | `NFs` 常量定义 + `summarizeOutboundModelHeaders` `r()` 导出 | 诊断 |
| 5 | 4013181 | `x4s = "3007"`；`uOe(e)` = `isCaptchaRejection` | **错误分类** |
| 6 | 4029673 | `J4s = "x-aliyun-captcha-verify-param"`；`mVr(e)` = `readCaptchaVerifyParam`；`fVr = "Captcha verification failed or the verify token was rejected."` | **读头** |
| 7 | 4029859 | 同上（重复命中，`createZcodePlanCaptchaEmptyStreamBusinessError`） | 读头 |
| 8 | 4037411 | `hVr({captcha: St.accountAccess?.mode === "start-plan", headers: St.headers, ...})` | **判定 + 构造错误** |
| 9 | 12726091 | `Pxo(e)` → `{hasCaptchaVerifyParam, captchaParamLength}` | 诊断 |
| 10 | 12726112 | 同上（重复命中） | 诊断 |

**关键点：这 10 处没有一处生产 captcha。**

反面证据（闭源版里**缺失**的东西）：

| 检索项 | 闭源命中 | 说明 |
|---|---|---|
| `AliyunCaptcha` | **0** | 完全没有阿里云 SDK 引用 |
| `startTracelessVerification` | **0** | 无痕迹验证调用 |
| `sceneId` | **0** | 无场景 ID |
| `initAliyunCaptcha` | **0** | 无 SDK 初始化 |
| `o.alicdn.com` | **0** | 无 SDK CDN 地址 |
| `captchaVerifyParam` | **0** | 无参数构造 |

对比开源版（`D:\DSH-WEB\ZCode-official\packages\ui\src\captcha\`）：

| 文件 | 行数 | captcha 命中行 |
|---|---|---|
| `aliyunCaptchaProvider.ts` | **1086** | 206 |
| `useProviderRuntimeHeadersCaptcha.ts` | 322 | 40 |
| `providerRuntimeHeadersResponder.ts` | 224 | 21 |
| `index.ts` | 71 | 40 |
| `AliyunCaptchaAnchor.tsx` | 53 | 14 |

`aliyunCaptchaProvider.ts` 第 26–27 行：
```ts
export const ALIYUN_CAPTCHA_SDK_URL =
  "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
```
第 282 行注释（**这是开源版作者写的，说明他做过同样的对比**）：
> `闭源里锚点由 React 组件 Xtn 渲染（本模块的 AliyunCaptchaAnchor.tsx）`

⇒ **结论 1**：captcha 生产代码在闭源版里**根本不在 `zcode.cjs`**，
它在 `app.asar` 打出的 renderer bundle 里。搬到闭源 agent 上，captcha 生产能力**一样为零**。

### B2. 闭源版自己也要等 renderer（180 秒超时）

`ZJo` —— `createProviderRuntimeHeadersPort`，定义在**偏移 14434058**：

```js
function ZJo(e, t) {                       // e = 协议客户端, t = workspace
  return {
    shouldRefreshBeforeModelRequest() { return true; },
    async refreshBeforeModelRequest(n) {
      let o = `${n.sessionId}:provider-runtime-headers:${crypto.randomUUID()}`;
      let s;
      try {
        s = await e.requestClient(
          va.interactionRequestProviderRuntimeHeaders,   // ← 与开源版同名
          { requestId: o, sessionId: n.sessionId, turnId: n.turnId,
            workspace: t,
            modelSelection: { providerId: n.providerId, modelId: n.modelId },
            providerId: n.providerId,
            ...(n.accountAccess ? { accountAccess: n.accountAccess } : {}),
            reason: n.reason },
          DGt,                                             // 响应 schema
          { signal: n.abortSignal, trace: r3e(n.traceContext), timeoutMs: BZa }
        );
      } catch (a) {
        let l = a instanceof sf && a.code === JJo;
        if (n.abortSignal?.aborted || l) {
          e.notify({ method: BR.providerRuntimeHeadersCancelled, ... });   // ← 超时则取消
        }
        if (l) {
          let u = new sf(JJo, "Captcha verification request timed out. Please send your message again.", a.data);
          throw u;
        }
        throw a;
      }
      if (!s.headersApplied)
        throw new sf(-32031, s.errorMessage ?? "Provider runtime headers were not applied before model request attempt.", ...);
      return s;
    },
  };
}
// 同处定义：
BZa = 18e4;      // 180000 ms = 180 秒
JJo = -32022;    // 超时错误码
```

**逐条对照开源版**：

| 项 | 闭源 | 开源 |
|---|---|---|
| 触发点 | `shouldRefreshBeforeModelRequest` → 返回 true | 同 |
| 请求方式 | `requestClient("interaction/requestProviderRuntimeHeaders", …)` | 经 emitter 面 fire |
| 超时 | **180000 ms**（`BZa`） | 20000 ms（`mintProviderAuthMaterial` 缺省） |
| 超时错误 | `sf(-32022, "Captcha verification request timed out. Please send your message again.")` | `finish(undefined)` → 桥侧 502 `credential_unavailable` |
| 未应用头 | 抛 `-32031` | 直接不返回 |

⇒ **结论 2**：闭源版**没有任何"用签名替代 captcha"的路径**。
它的模型请求前置步骤**也是**"向 renderer 要 captcha 头"，**超时还是 180 秒**
—— 比我们的 20 秒**更糟**。

### B3. 签名机制（ClientRequestSigningV4）**与 captcha 正交，且默认关闭**

规格（偏移 848258 起）：

```js
n7i = "get_sign_key"
r7i = "/api/paas/c1f3a7e2/v2/client"
cur = "zcode"
o7i = 10000        // 握手超时
lur = 16           // nonce 字节数
i7i = 8            // PoW 难度（powBits）
```

装配链（三段，缺一不可）：

**(a) 特征开关** —— 偏移 3721146：
```js
if (!t.codingPlanSignature) return;                   // ← 没配置就整个跳过
let u = { ...t.codingPlanSignature.headers, "x-api-key": a };
let g = () => new aPe({ headers: u, transport: f, url: t.codingPlanSignature.configUrl });
this.signingManager = new lPe({
  isEnabled: (a, l) => s(a)?.isEnabled(l) ?? Promise.resolve(false),   // ← 默认 false
  keyCache: ...,
  observer: ...
});
```

**(b) 特征开关实现** —— `aPe` = `CodingPlanSignatureFeatureGate`，偏移 843586：
```js
JJt = "/api/v1/agent/configs";     // 配置 URL（相对 zcode 站点根）
Ylr = 3600 * 1000;                 // 缓存 1 小时
Xlr = 15000;                       // 拉取超时 15 秒
class aPe {
  async fetchFeatureResult() {
    // GET configUrl，带 headers（含 x-api-key），redirect: "manual"
    let s = GJt(await o.json());
    if (s?.code !== 0) return { cacheable: false, enabled: false, failure: "business_code", httpStatus: o.status };
    let a = GJt(s.data);
    if (!a || !Object.prototype.hasOwnProperty.call(a, "codingPlanSignature"))
      return { cacheable: true, enabled: false, httpStatus: o.status };     // ← 服务端没下发 = 关
    return { cacheable: true, enabled: GJt(a.codingPlanSignature)?.enable === true, httpStatus: o.status };
  }
}
```

**(c) 配置来源** —— 偏移 14080223（`oHo` = `createRuntimeAiSdkModelExecutionConfig`）：
```js
function oHo(e = process.env, t = {}) {
  let n = THa(t.network);
  return { defaultHeaders: iHo(e, t),
           codingPlanSignature: xHa(e, t),      // ← 总是给，但为空对象也不报错
           env: e, ... };
}
function xHa(e, t) { return { configUrl: YAe(e, JJt), headers: iHo(e, t) }; }
```
`YAe(e, "/api/v1/agent/configs")` → `${resolveRuntimeZCodeEndpointOrigin(env)}/api/v1/agent/configs`，
默认 origin = `https://zcode.z.ai`（偏移 711343：`jee = "https://zcode.z.ai"`）。

**(d) 签名触发条件** —— `cRs` = `requiresClientRequestSigning`，偏移 3711941：
```js
function cRs({ access: e, baseURL: t }) {
  if (e.type === "zhipu-account" && (e.mode === "start-plan" || e.mode === "off-peak")) return false;  // ← 免费额度不签
  if (e.type === "zhipu-coding-plan-api-key"
      || (e.type === "zhipu-account" && (e.mode === "individual-coding-plan" || e.mode === "team-coding-plan"))
      || kXe(t) !== null) return true;
  try { return rRs.has(new URL(t).hostname.toLowerCase()); } catch { return false; }
}
var rRs = new Set(["api.chatglm.site", "zcode.chatglm.site"]);   // 偏移 3718969
```

**(e) 签名头** —— 偏移 852421 `sendSigned`：
```js
let a = t.headers.get("X-Session-Id")?.trim();
if (!a) throw qx("invalid-config", "Client request signing requires X-Session-Id.");
l.set("X-Client-Ts", u);
l.set("X-Client-Version", this.clientVersion);
l.set("X-Client-Sig", _);
l.set("X-Session-Id", a);
l.set("X-Client-Nonce", f);
l.set("X-App-Id", cur);          // "zcode"
l.set("X-Client-Pow", g);
```
头清单常量（偏移 841774）：`Zzi = ["X-Client-Ts","X-Client-Version","X-Client-Sig","X-Client-Nonce","X-Client-Pow","X-App-Id","X-Client-Sign-Verified"]`

**⇒ 结论 3（决定性的）**：

`cRs` 的第一行就是**排除规则**：
```js
if (e.type === "zhipu-account" && (e.mode === "start-plan" || e.mode === "off-peak")) return false;
```
**`start-plan` 和 `off-peak` —— 也就是免费额度走的两条路 —— 明确不签名。**

我们用的正是免费额度（`start-plan` 模式，captcha 是它的要求）。
**所以签名机制对我们的场景从一开始就不适用。** 它是给
`zhipu-coding-plan-api-key`（付费 API Key）/ `individual-coding-plan` /
`team-coding-plan` 准备的。

这**印证了 AGENTS.md 里第四轮的结论**："缺的不是签名"——
现在有了**代码级证明**，不只是实验证据。

### B4. 那闭源版为什么"看起来能工作"？

因为它**作为 Electron 应用运行时**，有完整的 renderer：
```
ZCode.exe (Electron 主进程)
  ├─ resources/glm/zcode.cjs             ← 我们现在只拿到这一层
  ├─ resources/app.asar (326 MB)         ← renderer bundle + React 组件
  │     └─ packages/ui/src/captcha/*     ← captcha 生产代码在这里
  └─ Chromium renderer                    ← 跑阿里云 SDK、产出 captcha param
```
`zcode.cjs` 通过 `requestClient("interaction/requestProviderRuntimeHeaders")`
把请求**发给** renderer，renderer 跑完 captcha 后回传。

**把 `zcode.cjs` 单独拿出来跑 = 砍掉 renderer = 砍掉 captcha 生产者。**
闭源 agent 会以**完全一样的方式**卡住，只是超时从 20 秒变成 **180 秒**。

---

## C. 迁移工作量

### C1. 补丁规模与文件清单

```
D:\zcode-glm5.3f\zcode-oss-patches\shell-modifications.patch
  ├─ 80,899 字节
  ├─ 新增 1433 行 / 删除 18 行
  ├─ 涉及 4 个已跟踪文件（5 个 hunk 组，另加 1 个全新文件）
  └─ UPSTREAM-HEAD = 29628c9acdb81b703bbd4080c207a0e7ce5e276e (v3.14.3)
```

| 文件 | 性质 |
|---|---|
| `packages/desktop/src/host/zcodeBridgeServer.ts` | **全新文件**，54,836 字节（不在 diff 里，单独存放） |
| `packages/desktop/src/host/index.ts` | 修改（hunk：`+15,6` `+48,6` `+122,6` `+1589,6` `+1853,8` `+1863,6 +682行` `+2895,6`） |
| `packages/desktop/src/main/index.ts` | 修改（`+3,6` `+142,6` `+258,6 +67行` `+868,6` `+1912,7` `+1925,6` `+2044,17`） |
| `packages/services/src/zcode-agent/zcodeAgent.ts` | 修改（`+17,6` `+336,6` `+546,6` `+707,6 +65行`） |
| `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts` | 修改（`+1290,12 +47行`） |
| `packages/services/src/zcode-agent/zcodeAgentService.ts` | 修改（**11 个 hunk**，最大 `+1170,6 +218行`） |

### C2. 补丁的**全部** import（这是判断能否落地的关键）

```ts
// host/index.ts 新增
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAccountRequestAuthService } from "@zcode/services/node";   // ← workspace 包
import { createZCodeBridge, parseMcpServersFromEnv, type ZCodeBridge } from "./zcodeBridgeServer.js";
import { installHeadlessDialogSuppressor } from "./headlessDialogSuppressor.js";

// zcodeBridgeServer.ts 全部 import
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
} from "@zcode/shared";      // ← workspace 包
```

**外部 npm 新增依赖：0 个。** 全部是 `node:*` 内置 + 两个 workspace 包名。

### C3. 补丁对开源版**特有扩展点**的依赖（这是真正的成本）

补丁**不是**一个能独立跑的插件，它**深度寄生在开源版的内部实现**上：

| 依赖的开源版内部实现 | 补丁里的引用位置 | 闭源版有吗 |
|---|---|---|
| `IZCodeAgentService` 服务注册表 | `host/index.ts` `services.getOptional(IZCodeAgentService)` | **无**（服务注册表是 host 侧架构，不在 cjs） |
| `getProviderRuntimeHeadersEmitter(workspace)` | patch 第 1533 行附近 | **无**（闭源对应物是 `ZJo` → `requestClient`，结构不同） |
| `providerRuntimeHeadersEmitters` 懒建表 | patch 注释多处 | **无** |
| `resolveWorkspaceKey(workspace)` 分桶 | patch 注释 + `mintProviderAuthMaterial` | **无**（闭源用 `yl(IGt, t)` 解析 workspace ref） |
| `pendingProviderRuntimeHeaders` Map | `mintProviderAuthMaterial` 直接 `set/delete` | **无** |
| `ZCodeProtocolClient`（伪造 client 的 `respond`） | `mintProviderAuthMaterial` | 闭源有 `requestClient`，但**没有"伪造 client"这个入口** |
| `respondProviderRuntimeHeaders` | 补丁改写 `zcodeAgentService.ts:2712` 的自动应答分支 | **无源码可改** |
| `zcodeAgentProcessManager` 的进程句柄 | patch `+1290,12` | **无** |
| `packages/ui/src/captcha/*` 的 renderer 订阅面 | 桥通过 renderer 拿材料，间接依赖 | **闭源的是 minify 后的 `Xtn`，无源码可挂钩** |
| `screen`/`nativeTheme` 等 Electron API | `packages/desktop/src/main/index.ts` | `zcode.cjs` **零 Electron API** |

**核心改写**（patch 1600–1610 行）——补丁改的是**开源版的自动应答分支**：
```diff
- if (accountRequestAuthService && accountAccess) {
-   // Host 按 Model 固定的 Account Access 自动应答…
+ const requiresRendererInteraction = accountAccess?.mode === "start-plan";
+ if (accountRequestAuthService && accountAccess && !requiresRendererInteraction) {
     void respondAccountRequestAuthWithoutInteraction({ key: pendingKey, pending });
     return;
   }
+ if (requiresRendererInteraction) {
+   // 与闭源同构：请求此时已登记进 pendingProviderRuntimeHeaders…
+   // 双发（与闭源 Wt + u.get(...)?.fire 同构）：
+   //  - session 事件面：让已有会话订阅者（task adapter / 具体 pane）看到；
+   //  - workspace 事件面：captcha 请求可能发生在没有 session 订阅者的会话上
+ }
```

**这段 diff 的前提是"开源版有那段可改的源码"。闭源版没有。**

### C4. 定量结论

| 指标 | 数值 |
|---|---|
| 补丁涉及的源码文件数 | **5**（+1 个新文件 = 6） |
| 其中位于 `packages/` 下的 | **5**（全部） |
| 外部 npm 新增依赖 | **0** |
| 新增行数 | **1433** |
| 依赖的开源版特有扩展点 | **≥10 处**（上表） |

**能否落地？不能。**

理由一句话：**补丁的 1433 行全部是 TypeScript，改的是开源版 monorepo 里
`packages/services` 与 `packages/desktop` 的具体函数体。闭源版根本没有这些文件
—— 它只有一个 14.8 MB 的 minify cjs，没有可 diff 的源码、没有可覆写的方法、
没有可访问的内部 Map/Emitter。这 1433 行一行都落不下去。**

唯一理论上可行的做法是**在运行时打 monkey-patch**（hook `globalThis.fetch`，
或在 14.8 MB minify 代码里定位 `ZJo` 的闭包并替换）。这条路的成本远超收益，
而且**方向是错的** —— 见下面「为什么这条路是错的」。

---

## D. 第三条路：只移植闭源版的某个模块

### D1. 移植 captcha？—— **不存在可移植物**

闭源 `zcode.cjs` 里 captcha 生产代码**为零**（B1 已列 10 处，全部是读/诊断/分类）。
真正生产 captcha 的代码在 `app.asar` 的 renderer bundle 里，
形态是 minify 后的 React 组件（开源版注释里叫 `Xtn`）。

**开源版已经有完整的、可读的等价实现**：
`D:\DSH-WEB\ZCode-official\packages\ui\src\captcha\`（5 个文件，1756 行，
含 `aliyunCaptchaProvider.ts` 1086 行）。
这套代码**就是**从闭源版逆向+重写出来的（开源版作者在注释里写明"闭源里锚点由
React 组件 `Xtn` 渲染（本模块的 `AliyunCaptchaAnchor.tsx`）"）。

**⇒ 移植 captcha 的收益是 0：开源版已经有一份功能等价、可读、可改的实现。**

### D2. 移植签名？—— **对我们的场景不适用**

`cRs` 第一行（偏移 3711941）：
```js
if (e.type === "zhipu-account" && (e.mode === "start-plan" || e.mode === "off-peak")) return false;
```
免费额度（`start-plan`）**明确不签名**。移植签名对 3007/3012 **零影响**。

而且就算要移植，它的装配依赖：
- `crypto.subtle`（Ed25519 / HKDF / AES-GCM / SHA-256）—— Node 18+ 的
  `globalThis.crypto.subtle` **支持 Ed25519**（Node 18.4+ 起，`--experimental` 后转正），
  这一层**可行**；
- 但**凭据来源是个硬门槛**：`Glr(this.apiKey)` 要求 apiKey 形如
  `"<id><分隔符><secret>"`（"must contain one separator"），
  HKDF 派生（`iur`，salt = `Yzi`，info = `Xzi`），再 AES-GCM 解出 PKCS#8 Ed25519 私钥。
  **这套凭据绑定在 `zhipu-coding-plan-api-key` 账户上，免费额度账户没有它。**

⇒ **移植签名：不可行且无意义**（材料来源不存在）。

### D3. 移植 `Standalone Account Provider`？—— **这条路有意思，但方向相反**

这是闭源版里**唯一一处既不需要 renderer 也不需要 captcha** 的 `providerRuntimeHeadersPort`。

`SHo`（偏移 14114021）：
```js
function SHo(e, t) {
  return {
    shouldRefreshBeforeModelRequest() { return true; },
    async refreshBeforeModelRequest(n) {
      n.abortSignal?.throwIfAborted();
      let o = n.providerId.trim(), s = n.accountAccess;
      if (!s || s.mode !== "individual-coding-plan")
        throw new Error(`Standalone Account Provider 请求身份无效: ${o}`);
      let a = (await e.load(Yie(o)))?.trim();               // account identity
      if (!a) throw new Error(`Standalone Account Provider 凭据已经失效: ${o}`);
      let l = (await e.load(t3e({ providerId: o, accountIdentity: a })))?.trim();
      if (!l) throw new Error(`Standalone Account Provider 缺少请求凭据: ${o}`);
      return { headersApplied: true, requestAuth: { apiKey: l } };   // ← 直接给 apiKey，无 captcha
    },
  };
}
```
启用是**剥离子系统**的（`Ykt(e, t)` 偏移 14126501，只有 `t.standalone` 为真时才挂）：
```js
...s ? { providerRuntimeHeadersPort: SHo(s, e) } : {}
```
且它的账户凭据来自本地凭据库（`jM({env})`）+ `readStandaloneCodingPlanCatalog`，
判定条件是 `access.mode === "individual-coding-plan"`。

**但**：
1. 这是 **individual-coding-plan**（付费 Coding Plan），**不是免费额度**；
2. 它**不产生 captcha**，所以对我们现在的 3007/3012 问题**毫无帮助**；
3. 它的 API Key 是**用户自己配置的 Coding Plan Key**，不是免费额度令牌。

⇒ **这条路是"绕开免费额度，改用付费 Coding Plan Key"的技术形态。**
它是一个**产品决策**（要不要付费），不是一个 free 的性能优化。

---

## E. 回到核心问题：换闭源版**能解决 8–28 秒吗**？

### E1. 直接回答

**不能。而且是把一个已知的 20 秒超时换成未知的 180 秒超时。**

### E2. 逐条论证

**① 8–28 秒的来源不是 agent 实现，是 captcha mint 的固有延迟。**

我们的桥现在的时序（AGENTS.md 第三轮已实测）：
```
请求进桥
  → 桥走会话链路 session/create + session/send
  → 壳内 agent 决定要发模型请求
  → 触发 shouldRefreshBeforeModelRequest
  → fire 到 renderer 的 workspace 面
  → renderer 加载/调用阿里云 SDK，跑一次无痕迹验证
  → 回传 {apiKey, headers}
  → 壳内才真正发模型请求
  → 流式返回
```
「mint 事件 → renderer 应答」这一段在**修复后的健康态**是 300–2600 ms（AGENTS.md 第三轮判据）。
8–28 秒是**整个会话链路的端到端**，含：
- `session/create` + `session/send` 的壳内建会话开销（SQLite 落库、上下文装配、工具表注入）
- 模型推理本身（GLM-5.3 首 token 延迟）
- 桥侧的轮询/快照拉取

**换 agent 不改变其中任何一项。** 闭源 `zcode.cjs` 走的是**同一条链**
（同样的 `interaction/requestProviderRuntimeHeaders`、同样的 renderer captcha、
同样的 SQLite 会话存储 —— 它内置了 `require("node:sqlite")`）。

**② 闭源版没有任何"更快"的机制。**

逐项检查闭源版里所有能想到的加速点：

| 潜在加速点 | 闭源版实情 |
|---|---|
| 免 captcha 直发 | **无**（`cRs` 对 start-plan 返回 false 是"不签名"，不是"不做 captcha"） |
| 客户端签名替代验证 | **对 start-plan/off-peak 明确禁用**（`cRs` 第一行） |
| 本地 captcha 生产 | **无**（0 处阿里云 SDK，0 处 `sceneId`） |
| 更短的 mint 超时 | **更长**（180000 vs 20000） |
| 更快的会话链路 | 同一套 `session/create` + SQLite |
| 并行多会话 | 闭源同样有单实例/单会话约束 |

**③ 闭源版的超时更差。**

`BZa = 18e4`。我们现在的 mint 超时是 20 秒（patch 1285 行 `params.timeoutMs ?? 20_000`）。
换成闭源的长链路，**最坏情况从 20 秒变成 180 秒**。
AGENTS.md 里已经记录过"180 秒超时"是开源版的历史痛点
（"壳内工具会真的执行，且历史上是 180 秒超时的主要来源"）。

**④ 真正的瓶颈（如果有）不在 agent，在"整轮不落库中间态"。**

AGENTS.md 已记录：「达到原生 API 速度 ❌ **物理不可能**（壳整轮不落库中间态，实测证伪）」。
换 agent **不改变壳的持久化语义** —— 闭源 cjs 里同样是
`dtt({dbPath: jie(B)})` → `node:sqlite`，同样的整轮落库模型。

**⑤ 而我们真正的收益来源已经被找到了，与 agent 无关。**

AGENTS.md 记录：**同负载 A/B，3 并发 58.4 → 21.2 秒（省 64%）**。
那是**并发调度**的功劳（补丁里的 `zcodeBridgeServer.ts` 队列）。
壳内存 1275 → 949 MB（省 326 MB）是**禁用插件**的功劳，
闸门在 `C:\Users\Administrator\.zcode\cli\config.json` 的 `plugins.enabledPlugins`。

**这两项都与"用哪个 agent 二进制"无关。**

### E3. 换闭源版的**真实代价**

| 项 | 代价 |
|---|---|
| 补丁迁移 | 1433 行 TS **全部作废**，且无源码可重打（C4） |
| 桥迁移 | `zcodeBridgeServer.ts` 依赖的 5 个开源版扩展点全部消失 |
| captcha 依赖 | **不变**，仍需 renderer（且超时 20s → 180s） |
| 签名 | **对免费额度禁用**，白拿 |
| 调试能力 | 从**可读 TypeScript** 变成 **14.8 MB minify**，定位问题成本暴涨 |
| 上游更新 | 闭源版随 ZCode.exe 更新，无版本管理、无 changelog、无 diff |
| 许可/可维护性 | 官方闭源产物，不可 patch、不可提交、不可发布 |

### E4. 那什么情况下才值得换？

只有一种：**我们要用 `individual-coding-plan` / `team-coding-plan` 付费路径**
（`SHo` 那条，D3）。那时：
- `cRs` 会返回 **true** → 走签名 → 可能免掉 captcha
- `SHo` 直接给 apiKey → 完全不需要 renderer

**但那是"改用付费 Coding Plan"，不是"优化免费额度"。**
而且这个能力**不依赖闭源二进制** —— 开源版同样有
`individual-coding-plan` 分支（`cRs` 逻辑在两版里一致），
可以在开源版上直接走。

---

## F. 与已有结论的交叉验证

| AGENTS.md 已有结论 | 本次调查的代码级证据 |
|---|---|
| 「3012 不可绕过……唯一可行路径是走壳内会话链路」 | ✅ 闭源 `ZJo` 同样走 `interaction/requestProviderRuntimeHeaders`，无替代路径 |
| 「缺的不是签名。第三轮『签名是根因』的推测已排除」 | ✅ **升级为代码证明**：`cRs` 对 `start-plan`/`off-peak` 显式 `return false` |
| 「第二轮错误结论：headless 下 captcha 组件没渲染」 | ✅ 闭源 cjs 零 captcha 生产能力，反证 captcha 只在 renderer |
| 「纯 Node 脱离 Electron 未攻克（能启动，`--prompt` 报 Model creation failed）」 | ✅ 根因定位：`ZJo` 等 renderer 材料，180 秒超时 |
| 「达到原生 API 速度物理不可能」 | ✅ 闭源同为 SQLite 整轮落库，换 agent 不改语义 |

---

## G. 未确认项（明确标注）

1. **`app.asar` 里 captcha 组件的具体实现未读。** 326 MB，未解包。
   但开源版 `aliyunCaptchaProvider.ts` 的注释已明确指认其存在（`Xtn`），
   且闭源 cjs 里零 captcha 生产代码这一事实**足以支撑本报告的全部结论**。

2. **闭源 `--prompt` 在纯 Node 下的具体失败点未实跑复现。**
   约束要求"不启停任何进程"，且本报告只需静态证据即可定论
   （`cRs` / `ZJo` / 零 captcha 三处代码即为充分证据）。

3. **`aPe` 拉取的 `/api/v1/agent/configs` 实际返回值未观测。**
   无法确认服务端当前对 `codingPlanSignature.enable` 的下发状态。
   但即便服务端开启，`cRs` 仍会在 `start-plan` 处短路，不影响结论。

4. **`ZCodeProtocolClient.requestClient` 在 `app-server` 模式下的完整实现未逐行读完**
   （偏移 14130473 / 14434250 等 21 处）。已确认的关键事实：
   它把 `interaction/requestProviderRuntimeHeaders` 发往 renderer，
   超时 180 秒，失败码 `-32022`。这已足够支撑 A3/结论 2。

5. **闭源版是否存在未公开的 feature flag 可强制绕过 captcha** ——
   检索了 `cRs` 全部分支与 `signingManager` 全部构造点，
   未发现。**不能 100% 排除**存在其他路径，但**已知路径全部指向 renderer**。

---

## 附：关键偏移量表（供复核）

所有偏移为 `E:\zcoed\ZCode\resources\glm\zcode.cjs` 内的**字符偏移**
（`[System.IO.File]::ReadAllText` 口径，文件长度 14,819,546 字符 / 14,820,819 字节）。

| 偏移 | 内容 |
|---|---|
| 497535 | `Xer(e)` —— app-server/agent-server 判定 |
| 595210 | `cZe(e)` —— `zcode-builtin.json` 缓存路径解析 |
| 711343 | `jee = "https://zcode.z.ai"`、各 endpoint 常量 |
| 768288 | `Ysr` / `fUi` —— providerRuntimeHeaders 协议 schema |
| 784335 | `va = {...}` —— **protocol 方法表（77 个）** |
| 785506 | `workspaceGenerateText: "workspace/generateText"` |
| 787239 | `interactionRequestProviderRuntimeHeaders: "interaction/requestProviderRuntimeHeaders"` |
| 841774 | `Zzi` —— 签名头清单常量 |
| 843586 | `aPe` = `CodingPlanSignatureFeatureGate` |
| 848258 | `n7i` / `r7i` / `cur` / `o7i` / `lur` / `i7i` —— 签名握手规格 |
| 852421 | `sendSigned` —— `X-Client-Sig` 等头的设置点 |
| 890944 | `_Kt` = `buildZCodeSourceHeadersFromContext` —— 来源头 |
| 958239 | `kXe(e)` —— provider family 域名判定 |
| 1069481 | `fQi` —— **`zcode-builtin.json` 外部路径解析** |
| 3986583 | `RFs` —— 脱敏头集合（含 captcha 头） |
| 4013181 | `x4s = "3007"`、`uOe` = `isCaptchaRejection` |
| 4029673 | `J4s = "x-aliyun-captcha-verify-param"`、`mVr` = `readCaptchaVerifyParam` |
| 12726091 | `Pxo` —— captcha 诊断摘要 |
| 14434058 | **`ZJo` = `createProviderRuntimeHeadersPort`（180 秒超时）** |
| 14114021 | **`SHo` = `createStandaloneProviderRuntimeHeadersPort`（无 captcha）** |
| 14126501 | `Ykt` —— `t.standalone` 为真时才挂 `SHo` |
| 14680114 | `runZCodeProtocolAgent`（`NXo`）—— **app-server 主入口** |
| 14685631 | `NXo` 定义 + `GK` bootstrap 导出表 |
| 14755404 | `R2n` —— `--prompt` 无头执行 |
| 14783105 | `_ti` —— TUI 启动（带 `standalone` 分支） |
| 14803016 | `xoc` = `runZCodeProtocolCommand` |
| 14806633 | `case "agent-server": case "app-server":` 分支 |
| 14080223 | `oHo` —— `createRuntimeAiSdkModelExecutionConfig`（装配 `codingPlanSignature`） |
| 3711941 | **`cRs` = `requiresClientRequestSigning`（`start-plan` → false）** |
| 3718969 | `rRs = new Set(["api.chatglm.site", "zcode.chatglm.site"])` |
| 3721146 | `signingManager = new lPe({ isEnabled: ... ?? Promise.resolve(false) })` |
