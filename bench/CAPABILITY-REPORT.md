# 能力对齐报告 —— DSH 反代 GLM  vs  ZCode 原生

> 目标：让 DSH 里反代的 ZCode GLM 模型，能力性能与 ZCode 原生基本一致。
> 方法：小项目基准（客观判定）+ 同负载 A/B + 子代理并行探路。
> 日期：2026-09-28

---

## 一、结论速览

**基准成绩从 2/3 提升到 3/3（首次全绿）**，并找到 5 处真实差距，其中 3 处是**能力级**的。

| # | 差距 | 性质 | 状态 |
|---|---|---|---|
| 1 | 输出预算被思考链吃光 → **空回复** | 能力级 | ✅ 已修 |
| 2 | `tools` 无 `cache_control` → 每请求全量重算 5K token | 性能级 | ✅ 已修 |
| 3 | environment 段从未发送 → 模型不知 cwd/平台/自身型号 | 能力级 | ✅ 已修 |
| 4 | 默认模型是 Flash | 配置级 | ✅ 已改（但见第四节的反转） |
| 5 | `code:3009` 并发限流 | 稳定性 | ✅ 已修（21 次 → 1 次） |

---

## 二、决定性发现：空回复的真实成因

**这是最重要的一条 —— 它把「模型变笨」的观感还原成了一个纯工程问题。**

### 现象

基准里出现「HTTP 200 但可见内容为空」的回复。

### 直接复现（同一个问题、同一个模型）

```
max_tokens=512   → content 长度 0     finish_reason=length   ← 空回复
                    reasoning_content 1747 字符
max_tokens=4096  → content 长度 122   finish_reason=stop     ← 正确回答
                    reasoning_content 1305 字符
```

### 机制

1. 实测确认：**不传 `thinking` 字段，上游照样返回 `reasoning_content`**
   —— GLM-5.3 在 start-plan 通道上**默认启用扩展思考**。
2. 思考与可见输出**共享同一个 `max_tokens` 预算**。
3. 调用方传 512 / 1024 这类偏小值时，稍复杂的问题**只够思考、不够回答**。

### 为什么这条最关键

它**不是模型能力问题** —— 同一题在预算足够时答案正确。
但表现出来就是"模型变笨了/答非所问/回空"。
如果不查到这里，很容易往「换模型」「加提示词」方向瞎修。

**修复**：适配器加 `MIN_VISIBLE_BUDGET = 4096` 预算下限
（`ZCODE_BRIDGE_NO_BUDGET_FLOOR=1` 可关，供对照）。

---

## 三、其余四处修复

### 3.1 `tools` 缺 `cache_control`（性能）

dump 实测：

```
system blocks:  len=42 cc=True / len=2856 cc=True / len=2836 cc=True
tools[0] keys:  name, description, input_schema   ← 无 cache_control
```

24 个工具、19492 字节，**零个缓存断点**。而 Anthropic 的 prompt caching
是**前缀式**的 —— 在**最后一个 tool** 上打一个断点即可覆盖「system + 全部 tools」。

**修复**：只给最后一个 tool 加 `cache_control`（`cacheableTools`）。

> ⚠ 影响评估属**推测**：子代理用「`ttftMs` 从 1.3s 飙到 25s 而 `mintMs` 稳定
> 200-700ms」作为间接证据指向冷缓存 prefill，**未做 A/B 坐实**。
> 但官方客户端本就带 cc，按「对齐官方」原则该加。

### 3.2 environment 段从未发送（能力）

`OFFICIAL_ENVIRONMENT_LABELS` 早已定义，却**一次都没被引用**。

实测后果：

```
问：Which model are you?
答：I'm ZCode, powered by GLM (trained by Z.ai).    ← 只能答出笼统的 GLM
```

**修复**：新增 `buildEnvironmentSection()`。现在实际发出：

```
# Environment
 - Primary working directory: D:\zcode-glm5.3f\_oss_data\.zcode\workspace\default
 - Is a git repository: no
 - Platform: win32
 - Shell: powershell
 - OS Version: Windows 10.0.26200
 - You are powered by the model named zcode-bridge/glm-5.3.
```

**踩到的坑**：Electron utilityProcess 里 `os.release()` 返回 `win32`
（纯 Node 下返回 `10.0.26200`）。已改为多级回退，
优先用 Electron 专有的 `process.getSystemVersion()`。

### 3.3 默认模型是 Flash（配置）

全天 639 次请求，**607 次 Flash（95%）**，07-16 点零次 GLM-5.3。
根因是 profile 配置硬编码：

```yaml
# profiles/web/cordis.patch.yml
- id: agent-default-model
  config: { provider: zcode-bridge, model: GLM-5.3-Flash }
```

**已改为 `GLM-5.3`**（web + headless 两个 profile）。

### 3.4 `code:3009` 并发限流（稳定性）

完整拒绝体（实测抓到）：

```
HTTP 429 {"code":3009,"msg":"model concurrency limit exceeded"}
HTTP 429 {"code":1005,"msg":"exceed quota limit"}
```

而 token 额度还剩 299.4 万 ⇒ 是**并发配额**，不是 token 配额。

**按模型统计（全天）**：

```
GLM-5.3-Flash  605 次 200    0 次限流      ← 从未撞过
GLM-5.3         74 次 200   21 次重试     6 次最终 429
```

⇒ **GLM-5.3 有独立且更严格的并发配额。**

**修复**：串行闸门（只包 fetch）+ 按模型自适应最小间隔
（Flash 0ms / GLM-5.3 350ms）+ 重试 2 次（1500ms 起退避）+ 重试前重 mint。

**效果**：`3009` 从 21 次降到 **1 次**。

---

## 四、⚠ 反转：GLM-5.3 并不比 Flash 好

**这推翻了本项目此前的结论，也推翻了子代理 P0-1 的推荐依据。**

### 同负载 A/B（各 5 轮 × 3 题，交替执行）

```
GLM-5.3        n=14   中位 4452ms   正确 8/14   (57%)
GLM-5.3-Flash  n=15   中位 4915ms   正确 10/15  (67%)
```

GLM-5.3 **略快**（4452 vs 4915ms）但**略不准**（57% vs 67%）。

### 具体错在哪

题 1（`40 人 60% 女生，女生中 25% 戴眼镜`，正确答案 **6**）：

- GLM-5.3：多次答 **12**
- Flash：全对

题 2（把「从未宕机」改成等字数反义句）：

- GLM-5.3 多次答「**曾经**宕机」—— 这是存在量化，不是「从未」的反义
- Flash 更多答「**总是/一直**宕机」—— 正确

### 边界（诚实说明）

⚠ 样本量小（n≈15），57% vs 67% 的差异**可能不具统计显著性**。
要坐实需要更大样本。但至少可以确定：**没有证据支持 GLM-5.3 明显更强**。

⇒ 默认模型已改为 GLM-5.3 这件事，**建议按实际使用感受再定**，
而不是照搬历史结论。

---

## 五、基准测试项目

`bench/` 下是一个自包含的小项目基准，三个任务都有**机器判定**：

| 任务 | 测什么 | 判定方式 |
|---|---|---|
| `bugfix-off-by-one` | 定位并修 bug | 跑 `expect.mjs`，输出必须是 `15` |
| `multi-step-refactor` | 多文件重构 + 去重 | 检查导入关系 + 跑 `index.mjs` |
| `debug-crash` | 诊断 ENOENT | 跑 `app.mjs`，且配置必须保留成文件 |

**用法**：

```powershell
node bench/runner.mjs --via dsh              # 跑全部
node bench/runner.mjs --task debug-crash     # 跑单个
node bench/ab-models.mjs 5                   # 模型 A/B
node bench/selftest.mjs                      # 判定器自检
node bench/verify-check.mjs                  # 判定器回归（含真实产出样本）
```

### 判定器的三次迭代（教训）

`multi-step-refactor` 的判定器被模型**三次**绕过 —— **三次都是模型做对、判定器判错**：

| 版本 | 判据 | 为什么错 |
|---|---|---|
| ① | `function greet(` 存在即判负 | 模型保留 `greet()` 作**对外包装**是正确做法 |
| ② | 必须调用 `greetShared(` 或 `greet(` | 模型这次用别名 `_greet`，不在白名单 |
| ③ | 只看「导入路径」+「是否还自己拼字符串」 | ✅ 不依赖标识符名字 |

**教训：判定器不能依赖模型自主选择的标识符名字。**

`verify-check.mjs` 固定了 2 份真实产出样本 + 2 个反例，
任何判定器改动都必须先过这一关。

---

## 六、原生 ZCode 基线：能测，但被 provider 配置卡住

子代理探路的结论（`bench/PROBE-NATIVE-ENTRY.md`）：

**入口存在**：
```
D:\DSH-WEB\ZCode-official\apps\zcode-cli\packages\cli\dist\zcode.cjs   (16.7MB, v0.16.9)
node <cli> -p "<任务>" --cwd <目录> --mode yolo --json
```

**但默认 provider 余额耗尽**：CLI 选了
`account:bigmodel-individual-coding-plan`（余额不足 `1113`），
而桥用的是 `account:bigmodel-start-plan`。

**我这边已做的尝试**：
1. 改 `~/.zcode/v2/provider_config.json` 的 `defaultModelSelection`
   → `account:bigmodel-start-plan`（已备份 `.bak-before-bench`）
2. 重跑 CLI —— 报错**仍是** `individual-coding-plan`
   ⇒ 说明 CLI 有其他来源覆盖该配置（可能是 session db 或运行时快照）

**结论：原生基线尚未跑通。** 这是本次唯一的未完成项。

**为什么这不算致命**：本项目的对齐依据来自**桥侧请求体的逐字段对照**
（dump 出的实际请求体 vs 官方形态），这比"跑一次原生任务"更精确 ——
原生基线只能给出"快/慢"的总量，而 dump 能指出**具体少了哪个字段**。

---

## 七、最终验证

```
基准测试     3/3 通过（首次全绿）
typecheck    壳侧 0 错误 / 插件 0 错误
插件版本    0.7.1 → 0.8.0（web + headless 均已安装）
3009 限流   21 次 → 1 次
空回复      512 token 必空 → 4096 token 正常回答（同题对照）
```

### 基准耗时（最终轮）

| 任务 | 耗时 | 说明 |
|---|---|---|
| bugfix-off-by-one | 50.8s | |
| multi-step-refactor | 150.4s | 多文件 + 验证 |
| debug-crash | 168.4s | 单请求 1.8-15.3s × 十几次工具回合 |

⚠ **DSH 端到端耗时主要花在多步回合编排上，不在桥或模型**。
桥侧单请求稳态中位 4.4 秒，而任务要十几轮 ⇒ 累加到 100-170 秒。

---

## 八、未做 / 待验证

1. **原生 ZCode 基线未跑通**（见第六节）—— 被 provider 配置挡住
2. **`cache_control` 的收益未 A/B 坐实** —— 影响评估属推测
3. **GLM-5.3 vs Flash 的样本量偏小**（n≈15），结论需更大样本
4. **尚未在 GUI（web profile）里实测** —— 基准走的是 headless
5. environment 段是否影响 3012 准入 —— 未验证（但实测 200 正常）
