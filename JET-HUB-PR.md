# PR 说明：zcode-session（会话链路版 ZCode provider）

> 目标仓库：`zhengwuji/Jet-Hub`
> 状态：**待提交**（本地已准备好补丁与文档，未 push）
> 日期：2026-09-27

---

## 零、先说清楚：这与现有 `feat/zcode-provider` 分支**不是同一件事**

Jet Hub 本地工作区已有一个 `feat/zcode-provider` 分支（`a45e5e2`），
它实现了 `src/zcode-adapter.ts`（812 行）+ `src/zcode.ts`（519 行），
走的是「**自己解阿里云 captcha + 直连 `zcode.z.ai`**」。

**该分支的 `docs/zcode-405-root-cause.md` 自陈：**

```
# ZCode 405/3012 根因定位报告
> 状态：未定位到根因。已排除 13 个维度，全部证伪。

## 证据 B —— 真实 Chromium 产的 param 仍然 3012：
=== 真实浏览器 captcha → chat ===
{"code":3012,"msg":"request has been blocked due to unusual activity."}
[HTTP 405]
```

**⇒ 那条路线在作者自己手里就没能跑通。** 本 PR 提供一条**实测可用**的替代路径。

---

## 一、根因：3012 的判据不在 captcha 材料里

现有分支的假设是「captcha 不够真 → 3012」，因此投入在**提升 captcha 质量**上
（`solver.js` 64 KB、happy-dom 假浏览器、真实 Chromium 对照）。

**我的实测推翻这个假设。决定性实验是「变量交换」：**

```
抢在桥之前，用【新鲜 captcha】自己直发上游
  → 3012 转移到了抢发方
  → 桥反而拿到 3007（材料被抢先消费）
```

**⇒ 3012 跟随「新鲜材料」移动，不跟随发送者、不跟随头集合。**

也就是说判据是**服务端的「会话注册状态」**，客户端无法预置。

### 已逐项排除（全部实测）

| 路线 | 结果 |
|---|---|
| 补 11 个来源头（UA / Referer / X-Title / X-Device-Mid 等） | 仍 3012 |
| 补 6 个会话头（x-session-id / x-query-id / x-zcode-trace-id 等） | 仍 3012 |
| **头集合逐字段对齐（25 个，与真实会话请求完全一致）** | **仍 3012** |
| 补 body 形状（5 组变体） | 全 3012 |
| 换鉴权形式（Bearer / x-api-key / 两者 / +anthropic-beta） | 全 3007，与 3012 无关 |
| 补客户端签名（`X-Client-Sig` / `X-Client-Pow`） | 开源版**本来就不带**；闭源版那套由服务端 feature gate 控制（`isEnabled: async () => false`） |
| **抢新鲜 captcha 自己直发** | **3012**（决定性反证） |

**这与现有分支的结论一致** —— 它也排除了 13 个维度。**差别在于：我找到了可行路径。**

---

## 二、可行路径：走壳内会话链路

**核心思路：不自己发请求，而是让 ZCode 实例自己发。**

```
DSH ──▶ 本插件 ──▶ 本机 HTTP 桥 ──▶ ZCode 实例的会话链路 ──▶ zcode.z.ai
        (provider)   (loopback)      (createTask/sendPrompt)   (免费额度)
```

桥跑在 ZCode 实例（Electron）里，通过实例自己的 `createTask` + `sendPrompt`
驱动对话。**captcha 与风控由实例自己处理** —— 因为那本来就是它的正常工作方式。

### 实测结果

| 项 | 状态 |
|---|---|
| 对话 | ✅ 跑通（8-25 秒，中位 15-25 秒） |
| **工具调用** | ✅ **跑通**（`tool_call` + `tool_result` 成对，模型给出真实执行结果） |
| captcha | ✅ 不再需要自己解（实例内部产出） |
| 3012 | ✅ 不再出现（走的就是官方路径） |

### 工具调用的实现

桥把 DSH 的工具表渲染成提示词注入，模型按约定输出 ```json 围栏；
桥解析后翻成 OpenAI 兼容的 `tool_calls` 形状回给 DSH。
实测模型真的调用并拿到真实结果（例：用 `glob` 找到真实文件路径）。

**⚠ 一个已踩的坑**：桥的 preamble 原本写「不要调用任何工具」，
导致模型连调用方给的工具协议也拒绝（回答「按本次桥接模式的约束，我不能调用工具」）。
**修法**：把「你自己的内置工具」与「调用方给你的工具协议」**显式分开**，
并明确后者不受前者限制。

---

## 三、PR 包含什么

| 内容 | 说明 |
|---|---|
| `dsh-zcode-bridge` 插件源码 | DSH 侧 provider（TypeScript） |
| 壳侧补丁（`shell-modifications.patch`，80 KB） | 给 ZCode 开源版加 HTTP 桥 + 并发调度 + 一致性修复 |
| 一键部署脚本 | 克隆开源版 + 打补丁 + 构建 |
| `LIMITATIONS.md` | **已知缺点清单**（80+ 行，每条标「实测」或「推测」） |
| `LATENCY-FINDINGS.md` | 延迟与内存的完整实测报告 |

### 我建议 PR 这样拆分（审阅成本考虑）

1. **`src/zcode-session-adapter.ts`** —— DSH 侧 provider，纯 TypeScript，
   与现有 provider 同构（独立一套，不改动既有文件）
2. **`docs/agents/zcode-session.md`** —— 分册文档（符合本仓库的 AGENTS.md 约定）
3. **壳侧补丁单独一份** —— 它改动的是 **ZCode 开源版**（另一个仓库），
   不是 Jet Hub 的代码。**这一份可能更适合做成文档而不是代码**

---

## 四、必须写明的缺点（否则会误导用户）

摘自 `LIMITATIONS.md`：

| 项 | 实测 |
|---|---|
| **速度** | **8-180 秒**（中位 15-25 秒）。**不可能追上原生 API** |
| **内存** | 常驻约 **950 MB**（Electron 实例；已做插件裁剪省 263 MB） |
| **稳定性** | 上游改风控即失效；captcha 坏了整体不可用 |
| **部署** | 需克隆并构建 ZCode 开源版（10-40 分钟） |
| 首次启动 | 约 30 秒后才在模型列表出现 |

**为什么速度追不上（实测，非推测）**：

壳在整轮期间**不落库中间态**。27 秒的请求实测 21 次快照：

```
[ 1.5s] contentChars=267   ← 旧内容
...（中间 16 次完全相同）...
[27.2s] contentChars=539   ← 只有最后一次跳变
```

⇒ **token 级流式无源可流**。把轮询间隔改成 10ms 也一样。

---

## 五、这份方案是否适合 Jet Hub

**坦白说，需要维护者判断。** 与既有 provider 的形态差异：

| | Jet Hub 既有 provider | 本方案 |
|---|---|---|
| 形态 | 纯 HTTP 适配（读凭据 → 发请求） | 需要一个**常驻的 Electron 实例** |
| 依赖 | 网络 + 凭据 | 还要 ZCode 开源版已部署并构建 |
| 内存 | 几 MB | 约 950 MB |

**如果 Jet Hub 的定位是「轻量凭据网关」，本方案可能偏重。**
但它解决的是一个**现有分支自陈未能解决的问题**，且是唯一实测可行的路径。

**由维护者决定取舍。**

---

## 六、备选：只提文档

如果完整方案不适合入库，**另一条路是只提 `docs/`**：

把「3012 根因已定位 + 会话链路是唯一可行路径 + 已排除的 13+N 个维度」
作为一份排查记录合并进去。这对后续任何想再试直连的人都有价值 ——
**可以避免重复我已经走过的两百多次实验。**

---

## 七、验证方式（供审阅者复核）

```powershell
# 1) 部署（10-40 分钟）
git clone https://github.com/MYCF711/dsh-free-glm.git
cd dsh-free-glm
pwsh -File deploy-zcode-instance.ps1

# 2) 装插件
dsh plugin --profile web add file:./dsh-zcode-bridge-0.2.3.tgz

# 3) 重启 DSH，等约 30 秒

# 4) 验证工具调用（关键判据）
$env:DSH_HOME="$env:APPDATA\in.dsh-plug.dsh-launcher\homes\0.1.7-rc.2"
dsh --profile web --json "用 glob 工具查找 D:\ 下的所有 .ps1 文件"
# 期望输出含：
#   {"type":"tool_call",...}
#   {"type":"tool_result","status":"completed",...}
```

**判据**：`tool_call` 与 `tool_result` **成对出现**、且模型回答里的数字
**来自真实工具执行**（不是文档记忆）。

---

## 八、来源

- 完整仓库：https://github.com/MYCF711/dsh-free-glm
- 已知缺点：`LIMITATIONS.md`
- 延迟/内存实测：`LATENCY-FINDINGS.md`
- 3012 排查全过程：`dev-history` 分支
