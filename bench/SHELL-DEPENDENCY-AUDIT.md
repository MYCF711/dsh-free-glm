# 壳依赖审计 —— 还需要开源 ZCode 壳吗？

> 起因：用户指出「captcha 可以用别的浏览器，chromium 可以，electron 应该也行，
> 不一定非要过开源 zcode」。
> 本文逐条核实**每个依赖是否真的需要壳**。

---

## 一、结论先说

**⭐ 2026-09-28 实测：整条链路可以完全脱离 ZCode 壳。**

```
最小 Electron（自造，零 ZCode 代码）产出 captcha
        +  纯 HTTP 直打上游
        ↓
HTTP 200   {"model":"glm-5.3-flash", "content":[...]}   3180ms
```

| 依赖 | 真的需要壳吗 | 替代方案 | 难度 |
|---|---|---|---|
| **captcha**（`mintAuthMaterial`） | ❌ **不需要** | 任意 **Electron** | 中（已验证可行） |
| 登录（`startLogin`） | ❌ **不需要** | 已走纯 HTTP（`/oauth/cli-login`） | 已完成 |
| 会话链路（`runConversation`） | ❌ **不需要** | fast path 已绕开它 | 已完成 |
| `dataBaseDir` | ❌ | 自己定 | 极易 |
| `generateWorkspaceText` | ⚠ 低价值 | 可自造或省略 | 易 |
| `mcpServers` / `sessionPing` / `testModelConnectivity` | ❌ 诊断用 | 删掉即可 | 易 |
| `openUrl` | ❌ | 自己调系统 API | 易 |
| `reasoningLevel` | ❌ | 常量 | 极易 |

**⇒ 壳剩下的唯一实质作用是 captcha。而出 captcha 只需要「一个 Electron 进程」。**

---

## 二、captcha 为什么不需要壳（**已实测确证**）

### 2.0 ★★★ 决定性对照实验（2026-09-28 本机实跑）

**同一个脚本、同一个页面（`http://127.0.0.1:8899/builder.html`）、同一网络**，
只换浏览器：

| 环境 | UA 关键片段 | 结果 |
|---|---|---|
| ZCode 实例 | `ZCodeDev/41.0.3` Chrome/146 **Electron/41** | ✅ `ok=true`，param 280 字符 |
| **最小 Electron**（`bench/probe-electron-standalone.mjs`，**零 ZCode 代码**） | `minielectron/1.0.0` Chrome/146 **Electron/41** | ✅ **`ok=true`**，param 280 字符 |
| headless Edge 154 | **`HeadlessChrome`** Edg/154 | ❌ `verifyCode: F001` |

**⇒ 判据是「Electron 内核」，不是「ZCode 这个具体应用」。**
headless Edge 失败的原因是它是 **HeadlessChrome**（无头模式），
而非内核不同。

### 2.1 收尾验证：param 真的被上游接受

拿到 param 不等于上游接受。把三样拼起来**绕开桥**直打上游：

```
独立产出的 captcha param（来自最小 Electron）
      + 官方身份块 system（纯字符串，解 3012）
      + 有效 JWT
      ↓
POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
      ↓
HTTP 200   3180ms
{"id":"msg_...","model":"glm-5.3-flash",
 "content":[{"type":"thinking",...},{"type":"text",...}]}
```

**⇒ 脱壳路径完全打通。** 脚本：`bench/probe-standalone-upstream.mjs`

### 2.2 桥源码自己的说法

`zcodeBridgeServer.ts` 第 23 行：

> captcha 只能在**渲染进程**里跑（需 DOM + `o.alicdn.com` 的 SDK），
> 而请求由 host 发出。

**关键**：它要求的是「**有 DOM 的渲染进程**」+「阿里云 SDK」，
**不是**「ZCode 的渲染进程」。这两个是不同的约束，
前面几轮把它们混为一谈了 —— 本节的实测正是纠正这一点。

### 2.3 旁证：captcha 模块本身与 Electron 无关

`CAPTCHA-PORT-VERDICT.md` 实测统计（偏移 4,153,000–4,174,700）：

```
ipcRenderer = 0      require( = 0      webContents = 0
process.    = 0      Electron = 0      __electron  = 0
document.   = 15     window.  = 13     localStorage = 3
```

**⇒ 零 Electron 特有 API，零 Node API，纯标准 Web API。**

同一文档还实测确认：**开源版磁盘上根本没有 captcha 代码**
（整个 `assets/` 与源码树 `captcha = 0`、`Aliyun = 0`、`initAliyunCaptcha = 0`）。

⇒ 现在能跑，靠的是 `scripts/oss-inject-captcha-real.mjs` **动态注入**官方 SDK。
**这与「壳自带 captcha」是两回事** —— 也解释了为什么注入到别的 Electron 里同样能跑。

### 2.4 需要照做的三个手法（Zai-Proxy 的做法，本项目已验证等效）

`aliyun-captcha-research.md` 第 258-262 行记录：

1. 加载 `https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`
2. 建三个 DOM 容器（`container` / `element` / `button`，全部 `height:0;width:0`）
3. `window.AliyunCaptchaConfig = { region:'cn', prefix:'no8xfe' }`
   → `initAliyunCaptcha({ SceneId:'11xygtvd', ... })`
   → `getInstance: inst => inst.startTracelessVerification()`
   → `success: param => ...`

**本项目的 `bench/probe-captcha-standalone.mjs` 就是这个流程的最小实现。**

### 2.5 关键约束（必须照做，否则必失败）

| 约束 | 来源 | 后果 |
|---|---|---|
| token **短命**（38-45s） | 研究文档第 230 行 | 必须预热池 + 自动重取 |
| token **不可复用** | 第 230 行 | 复用 → `3007` |
| **数据中心 IP 会被额外标记**（F015） | 第 229 行 | 本机是家宽，风险低 |
| **必须 Electron（非 HeadlessChrome）** | ★ 本机实测 | Edge 无头 → `F001` |

第 249 行还有一个重要澄清：

> **TRACELESS 无感验证本质上是设备信誉问题，不是识别问题。**

⇒ 这解释了为什么**打码平台帮不上忙**（它们处理滑块/点选，
TRACELESS 没有可外包的"识别任务"）。

---

## 三、当前架构里壳还做了什么

从 `deps.*` 统计（`zcodeBridgeServer.ts`）：

```
deps.mintAuthMaterial          15 次   ← 唯一实质依赖（captcha）
deps.dataBaseDir                9 次   ← 路径，可自定
deps.startLogin                 3 次   ← 已可走纯 HTTP
deps.generateWorkspaceText      2 次   ← 低价值
deps.mcpServers                 2 次   ← 诊断
deps.openUrl                    2 次   ← 可自调
deps.resolveAuthMaterial        2 次   ← 与 mint 同类
deps.sessionPing                2 次   ← 诊断
deps.testModelConnectivity      2 次   ← 诊断
deps.getLatestAuthMaterial      1 次   ← 旁路，可替代
deps.runConversation            1 次   ← fast path 已绕开
```

**只有 `mintAuthMaterial` 是硬依赖。** 其余都是路径、诊断、或已完成替代。

---

## 四、脱壳方案的形态（**关键环节已验证**）

```
┌─────────────────────────────────────────┐
│ DSH（或任何 OpenAI 兼容客户端）           │
└──────────────┬──────────────────────────┘
               │ HTTP
┌──────────────▼──────────────────────────┐
│ 纯 Node 网关（无业务逻辑依赖）             │
│  · 转协议 OpenAI ↔ Anthropic             │
│  · 直发 zcode.z.ai 上游  ✅ 已实测 200     │
│  · 注入官方身份块 system  ✅ 已实测        │
└──────────────┬──────────────────────────┘
               │ 需要 captcha 头时
┌──────────────▼──────────────────────────┐
│ 常驻**最小 Electron**（非 ZCode）          │
│  · 一个窗口 + CDP  ✅ 已实测可跑           │
│  · 注入 AliyunCaptcha.js                 │
│  · initAliyunCaptcha + 无感验证           │
│  · 产出 param → 预热池（TTL 38-45s）       │
└─────────────────────────────────────────┘
```

**已验证的三个关键环节**：

| 环节 | 状态 | 证据 |
|---|---|---|
| 最小 Electron 产出 captcha | ✅ | `bench/probe-electron-standalone.mjs` → `ok=true` |
| 独立 param 被上游接受 | ✅ | `bench/probe-standalone-upstream.mjs` → **HTTP 200** |
| 纯 HTTP 直打上游 | ✅ | 同上，3180ms |

**唯一未验证的**：**常驻化 + 预热池**的工程稳定性
（单次能过 ≠ 长期稳定，需要跑一段时间观察）。

### 收益

| 项 | 现在（ZCode 全壳） | 脱壳后（最小 Electron） |
|---|---|---|
| 代码依赖 | 需要 ZCode 开源版**源码 + 构建** | 只需 Electron 二进制 |
| 启动 | 完整 App 初始化 | 一个空窗口 |
| 内存 | ZCode 多进程 | Electron 最小进程集 |
| 调试 | 桥跑在 utilityProcess，难单测 | 纯 Node + 独立 Electron |
| 升级风险 | 跟随 ZCode 版本 | 自主可控 |

### 代价与风险

1. ~~captcha 通过率未在本机验证~~ → **已验证通过**（见上表）
2. **需要维护一个常驻 Electron** —— 资源开销仍在（但远小于 ZCode 全壳）
3. **上游风控可能演化** —— 判据从 Edge→Electron 的差异已经证明它**会看环境**，
   未来可能更严
4. ~~3012 准入~~ → 已解决（纯字符串构造身份块）
5. **工程化未做** —— 预热池、失效重取、异常恢复都还没写

---

## 五、验证历程（已完成的实验记录）

**✅ 第一步已完成：captcha 能脱离 ZCode 生产。**

| 实验 | 脚本 | 结果 |
|---|---|---|
| 1. ZCode 实例出 param（基线） | `probe-captcha-standalone.mjs 9229` | ✅ 280 字符 |
| 2. headless Edge 出 param | `probe-captcha-standalone.mjs 9444` | ❌ `F001` |
| 3. **最小 Electron 出 param** | `probe-electron-standalone.mjs` | ✅ **280 字符** |
| 4. **该 param 直打上游** | `probe-standalone-upstream.mjs` | ✅ **HTTP 200** |

**实验 2 vs 3 是决定性的**：同一脚本、同一页面、同一网络，
唯一差别是 **Edge 无头 vs Electron** —— 一个失败一个成功。
⇒ 判据是浏览器身份，且 **Electron 满足要求**。

**下一步（若要做工程化）**：
- 把 `probe-electron-standalone.mjs` 的 App 做成常驻服务
- 加预热池（TTL 38-45s，参考 Zai-Proxy 的 3 个 token 缓冲）
- 桥的 `mintAuthMaterial` 改为调用该服务

---

## 六、诚实边界

### 已由**本机实测**确证（不再是二手证据）

- ✅ 最小 Electron（零 ZCode 代码）能产出 captcha —— `ok=true`，param 280 字符
- ✅ 该 param 被上游接受 —— 直打上游 **HTTP 200**，3180ms
- ✅ 判据是 Electron 内核，不是 ZCode —— Edge 无头失败 / Electron 成功的对照
- ✅ captcha 模块本身零 Electron API、零 Node API（`CAPTCHA-PORT-VERDICT.md` 统计）

### 仍是**推测或二手证据**

- 「headless Edge 失败是因为无头模式」—— 属**推测**。
  本实验只证明「Edge 无头失败、Electron 成功」，
  **没有单独测「有头 Edge 是否成功」**。
  分辨两者需要再做一个「有头 Edge」实验。
  （不过对脱壳而言不重要 —— 反正 Electron 已经能过。）
- 「上游会不会随时间演化风控」——无证据，只能是风险提示

### 明确未做

- **常驻化与预热池**：单次成功 ≠ 长时间稳定。没跑过持续验证。
- **并发下的表现**：没测多个 captcha 同时请求。
- **失败重试路径**：`3007`/`F001` 时的恢复逻辑没实现。

### 对现有架构的影响

**当前架构（ZCode 壳）仍然可用且稳定**（605 次 Flash 请求零限流）。
脱壳是**「可以做」**，不是**「必须做」** ——
它的价值在于减少依赖与提升可维护性，不是解决当前故障。
