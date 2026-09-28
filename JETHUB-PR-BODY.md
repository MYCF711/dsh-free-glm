# feat(zcode): 新增 ZCode (智谱) provider —— 借本机实例的免费额度通道

## 这是什么

第十个 provider，但与前面九个**形态完全不同**：

```
其它 provider:  读凭据 → 直发远端
zcode:          请求发给「本机 ZCode 实例的 HTTP 桥」→ 由实例代发上游
```

桥的发现方式是一个 JSON 文件：

```
<dataBaseDir>/.zcode/v2/bridge-port.json
{ "port": 53297, "token": "<48位hex>", "models": ["GLM-5.3", ...] }
```

这样做的理由是 **captcha 与 3012 风控由实例自己处理** ——
那本来就是它的正常工作方式，不需要我们复刻。

## 为什么值得并入 Jet Hub

ZCode 提供**免费额度**（智谱 z.ai 的 Start Plan，每日刷新）。
本实现已在本机实测跑通多轮对话与工具调用，
且在故障发生前通过了 3/3 的项目制基准测试。

⚠ 但它有明确的代价，见下方「必须写明的缺点」。

## 新增文件（4 个）

| 文件 | 职责 |
|---|---|
| `src/zcode.ts` | 桥的发现（多候选目录探测 + 扫描兜底）、凭据形态 |
| `src/zcode-product.ts` | 产品配置 + 兜底模型表 |
| `src/zcode-auth.ts` | 探活 / 读凭据 / 拉模型目录 |
| `src/zcode-adapter.ts` | LLM 适配器（复用 `openai-compat.ts`） |

另加一个验证脚本 `scripts/verify-zcode-against-bridge.mjs`（对着真桥跑）。

## 两个关键设计决定

### 1. 端口**每次请求都重读文件**，不缓存

实测同一台机器上桥端口先后是 `53297` → `58640` → `62019` → `60713` ——
**每次重启都变**。缓存端口的表现是「实例重启后所有请求失败」，
而错误是「连接被拒绝」，看起来像「ZCode 没跑」，排查方向会被完全带偏。

### 2. 发现文件探测必须**扫描兜底**，不能只信环境变量

**这是开发过程中真实踩到的坑**，值得单独说：

第一版只查「环境变量 + 用户主目录」，对着运行中的桥跑验证脚本时**找不到它**：

```
✗ 找到桥的发现文件
  ZCODE_DATA_BASE_DIR = (空)      ← launcher 的环境块里没有它
  桥实际在             D:\zcode-glm5.3f\_oss_data\.zcode\v2\bridge-port.json
```

第三类候选全部落空 —— 因为本机把数据目录放在**自定义路径**
（`<项目目录>\_oss_data`），既不在环境变量、也不在主目录下。

而失败形态很糟：**provider 静默没有模型**，用户完全不知道原因。

修法：加第 ④ 类候选（按盘符扫顶层目录，检查
`<dir>\_oss_data\.zcode\v2\bridge-port.json`），范围刻意收紧
（只下两级、跳过系统目录、候选去重）。
实测候选 2 → **130 个**，精确命中 1 个。

这正是 `AGENTS.md` 记过的那条：
> 靠「文件实际在哪」这个事实做候选探测，比靠「进程记得什么」可靠

## 遵守「新增 provider 完整清单」

AGENTS.md 列的 10 项逐条落实：

- [x] 1. `src/zcode-product.ts` — 产品配置（单产品）
- [x] 2. `src/index.ts` — `new ZcodeAuth(ctx)`、`registerZcodeLlm(...)`
- [x] 3. `src/index.ts` — `registerProviderSettings` 加 `'llm-zcode'`
- [x] 4. `src/index.ts` — `refreshAllCredentials()` 与**两个** `ctx.effect` 清理块
- [x] 5. `src/index.ts` — `modelAdapters` 映射
- [x] 6. `src/index.ts` — `registerJetHubRpc(...)` 实参
- [x] 7. `src/jet-hub-rpc.ts` — 函数签名（两处）
- [x] 8. `src/jet-hub-rpc.ts` — `account.refresh` 的 switch 分支
- [x] 9. `plugin-src/client/jet-hub.js` — `PROVIDERS` 面板项
- [x] 10. `plugin-src/client/credits-capabilities.js` — 能力表

第 9/10 项由 `tests/unit/plugin.spec.ts` 锁死，已通过。

## ⚠ 同时修了测试里的**位置参数错位**

`registerJetHubRpc` 用**位置参数**。我把 `zcode` 插在 `raccoon` 与
`modelAdapters` 之间 ⇒ 测试里所有调用的实参**整体错位**。

**TypeScript 不会报错**（各服务类型结构上兼容），失效形式是
`modelAdapters` 变成 `undefined` —— 表现为「关闭的模型退化成裸 id」，
正好是 `jet-hub-rpc.spec.ts` 那条回归要守的性质。

已在测试里补齐占位实参并写明注释
（与 AGENTS.md 的「Loomy provider：位置参数注意点」同一条）。

## 能力表登记为全 false

`balance: false, dailyCheckin: false` —— ZCode 不是「积分账户」模型，
而是**每日刷新的订阅额度**（`/diagnostics/billing` 返回
`{totalUnits, usedUnits, remainingUnits, period:'daily'}`）。
额度按日自动刷新，**不存在「领取」这个动作**，也没有 claim 端点。
给它加签到按钮会是一个点了没反应的假按钮。

## 兜底模型表只放两个（实测依据）

服务端 `/v1/models` 列出 4 个（`GLM-5-Turbo` / `GLM-5.2` /
`GLM-5.3` / `GLM-5.3-Flash`），但**前两个在 Start Plan 下返回空响应**
（同样三题 0/3 正确，而 GLM-5.3 是 3/3）。列一个用不了的模型比不列更糟。

`fetchModels()` 用兜底表的 id 集合当白名单，**有意复用那份实测结论**。

两个模型都列出来（不替用户选）。同负载 A/B 实测：

| 模型 | 中位延迟 | 正确率 | 并发限流 |
|---|---|---|---|
| GLM-5.3 | 4452ms | 8/14 (57%) | 撞过 21 次 3009 |
| GLM-5.3-Flash | 4915ms | 10/15 (67%) | **0 次** |

GLM-5.3 略快但略不准、且并发配额严得多。样本量偏小（n≈15），故不排名。

## 必须写明的缺点

| 项 | 实测 |
|---|---|
| **依赖本机实例** | 需要 ZCode 实例在跑；没跑时模型列表为空（符合预期） |
| **端口会变** | 每次重启都变 —— 已用「每次重读文件」处理 |
| **不可续期** | 没有 refresh 端点；凭据是「本机桥是否活着」 |
| **不支持图片** | 桥未实现图片通道，适配器**显式拒绝**（比静默丢图好） |
| **单请求长尾** | 1.3–33 秒，中位约 4–6 秒；超时设 240s |
| **上游风控** | 实例侧的风控策略变化会影响可用性 |

## 验证

```
typecheck                 0 错误
build:all                 成功（host tsc + client esbuild）
单元测试                   2662 通过 / 2 失败
  · 两个失败在改动前就存在（已用 git stash 跑基线确认）：
    loomy-docs 依赖一个不入库的协议文档；raccoon-auth 测试超时
plugin.spec               52 项通过（面板一致性 + 能力矩阵等集）
jet-hub-rpc.spec          77 项通过
credits-capabilities      通过
scripts/verify-zcode-against-bridge.mjs   对着真桥全绿
```

### 端到端验证脚本（对着真桥）

```
✓ 发现文件探测（端口 53297、token 48 字符）
✓ /health 探活
✓ /v1/models 目录，且与兜底表有交集
✓ chat/completions 协议形状（OpenAI SSE + [DONE]）
```

它当场抓出了上面那个「只信环境变量找不到桥」的 bug ——
这正是「单元测试全 mock + typecheck 通过」**不能替代**的：
本 provider 的核心风险恰在运行期。

脚本还区分两种「有 SSE 帧、无 content」：

| 原因 | 特征 | 归谁 |
|---|---|---|
| 代码有问题 | `usage` 缺失/异常 | 本 PR |
| 实例侧 mint 失败（captcha 降级） | `total_tokens: 0` + `finish_reason: stop` | 运行环境 |

避免把环境问题误记成代码缺陷。

## ⚠ 一个与环境有关的诚实说明

开发末期本机 captcha 被上游**降级为人工滑块**
（我在调试中密集请求导致设备信誉下降），
此后桥对所有请求返回 `total_tokens: 0` 的空回复。

**因此「完整多轮对话」的实测是在此之前完成的**；
故障期间只验证到「协议形状正确」这一层（脚本里已单独注明）。
恢复需要人工在 ZCode 窗口里拖一次滑块 —— 与代码无关。

## 与既有 `feat/zcode-session-provider` 分支的关系

我的 fork 上已有一个同名主题的旧分支，走的是
「自己解阿里云 captcha + 直连 `zcode.z.ai`」。**本 PR 是不同的实现**：

| | 旧分支 | 本 PR |
|---|---|---|
| 形态 | 直连远端（自己解 captcha） | 借本机实例的桥 |
| captcha | 自己解 | **实例自己处理** |
| 额外依赖 | 网络 + 凭据 | 还要 ZCode 实例在跑 |

两者 provider id 相同，需二选一。**由维护者判断取舍。**
