# JetHub：`listModels()` 非阻塞化 —— 结构性性能缺陷修复

## 缺陷

**用户症状**：「装了 JetHub 后，会话框右下角的模型选择器要加载很久才出来。」

**根因**：`listModels()` 是 DSH 模型选择器的 **UI 热路径**，而 11 个适配器在里面
**同步 `await` 网络**。DSH 逐个 provider 收集目录，这些 await **串行叠加** ⇒
首帧耗时 = 所有 provider 的网络往返之和。

实测的阻塞点（修复前）：

| 适配器 | 阻塞点 |
|---|---|
| `antigravity-adapter` | `await this.ensureRemoteModels()` |
| `antigravity-local-adapter` | `await this.ensureModelConfigs()` + `await this.probeChannels()` |
| `buddy-adapter` | `await this.ensureRemoteModels()` |
| `llm-adapter`(codearts) | `await this.ensureRemoteModels()` |
| `lobsterai-adapter` | `await this.ensureRemoteModels()` |
| `trae-adapter` | `await this.ensureRemoteModels()` |
| `zcode-adapter` / `raccoon` / `loomy` / `cline` | `await this.loadModels()` / `ensureRemoteModels()` |
| 全部 provider | `await providerCatalogVisible(...)`（凭据解析） |

已排除的原因（未重复验证）：模型表 93 条读取 4ms、`providerCatalogVisible`
账号门控 6ms、死网关探活 19ms。

## 修法

新增共享部件 **`src/catalog-refresh.ts`**（`CatalogRefresh<T>`），把
「缓存 / 并发去重 / 变化广播 / 失败冷却」收敛成一份实现：

1. **`listModels()` 只读缓存**（纯内存、同步）并 `start()` 触发后台刷新；
2. 拉取落地且**与上次播报的不同**时，`onCatalogChanged` → 广播
   `llm/adapters-updated` → 选择器重读；
3. **`resolveModel()` / `stream()` 仍等**（需要准确元数据，不是首帧热路径）；
4. 门控同步化：`providerCatalogVisibleSync` + `AccountPool.catalogVisibleSync`；
5. 非热路径加 `whenCatalogReady()`（`model.list` / `model.setAllDisabled` 先等目录）。

### 实现过程中实测发现并修掉的三个连带缺陷

1. **`CatalogRefresh.start()` 的竞态死锁**：`this.loading = this.run()` 与
   `run()` 内 `finally` 清理的顺序竞态 —— `fetch()` 同步抛错时 `loading`
   永远非 `undefined`，`settled()` 的 `while` **死循环**。实测把「跑一次测试」
   变成「无限挂起」。修法：先存本地变量再挂清理钩子。
2. **失败重试风暴**：拉取失败时缓存仍为空，热路径会**每次调用都重试一次
   网络** —— 比修复前更糟。加 30 秒失败冷却（`FAILURE_COOLDOWN_MS`）。
3. **`model.setAllDisabled` 漏模型**：据兜底表写黑名单会漏掉**远端独有**的
   模型，用户看到「关了全部却还有几个亮着」。

## 文件清单

**新增**
- `src/catalog-refresh.ts` — 共享的非阻塞目录加载器
- `tests/unit/catalog-refresh.spec.ts` — 契约 + 死锁回归（19 条）
- `tests/unit/listmodels-nonblocking.spec.ts` — 跨 11 个适配器的行为证明（12 条）

**修改（src）**
- `account-pool.ts` — `catalogVisibleSync` / `providerCatalogVisibleSync` /
  `onVisibilityChanged`
- `index.ts` — 注入 `onCatalogChanged`（15 处）与 `pool.onVisibilityChanged`
- `jet-hub-rpc.ts` — 导出 `broadcastCatalogChanged`；`ModelCatalogSource`
  加 `whenCatalogReady?`；`model.list` / `model.setAllDisabled` 先等目录
- `llm-adapter.ts`、`buddy-adapter.ts`、`lobsterai-adapter.ts`、
  `trae-adapter.ts`、`zcode-adapter.ts`、`raccoon-adapter.ts`、
  `loomy-adapter.ts`、`cline-adapter.ts`、`qoder-adapter.ts`、
  `antigravity-adapter.ts`、`antigravity-local-adapter.ts` — 各适配器接入

**修改（tests）** — 8 个既有 spec 的目录类用例改为先 `whenCatalogReady()` 预热
（`listModels` 不再同步返回远端目录，这是非阻塞化的必然后果）。

**修改（docs）**
- `docs/agents/catalog-gating.md` — 新增「`listModels()` 必须非阻塞」章节；
  修正「必须 await」那条已过时的断言

## 验证结果

| 项 | 基线 | 修复后 |
|---|---|---|
| 类型检查 | ✅ | ✅ |
| 单元测试 | 2 failed \| 2662 passed (2669) | 2 failed \| **2682 passed** (2689) |
| 失败集合 | `loomy-docs`（缺未入库文档）+ `raccoon-auth`（偶发竞态） | **完全相同** |
| 套件耗时 | 61.84s | 61.75s（无退化） |

**关键行为证明**（`tests/unit/listmodels-nonblocking.spec.ts`）：把 11 个适配器的
远端拉取换成**永不 settle** 的 Promise，断言 `listModels()` 仍在 50ms 内返回。
修复前该断言会**超时**（不是变慢，是永不返回）。**已做反向验证**：给任一适配器
加回 `await`，对应用例立即从 0ms 变成 5 秒超时失败。

另附本地验证脚本 `scripts/probe-listmodels-nonblocking.mts`（**不入补丁**，
与 AGENTS.md「只读排查脚本不入库」的约定一致）—— 它输出 11 个适配器逐个的
耗时，全部 0.1–0.3ms。

## 风险与未验证项

- ⚠ **首帧目录可能短暂显示兜底表**：冷启动时 `listModels()` 返回静态兜底表，
  后台拉取落地后经 `llm/adapters-updated` 广播替换。这是「首帧不等网络」的
  必然代价，也是本次修复的**设计意图**。需要真实 DSH 环境确认广播确实触发
  选择器重读（代码路径与既有黑名单广播同源，但未做端到端实测）。
- ⚠ **`DSH_HIDE_MODELS_WITHOUT_ACCOUNT` 门控在冷启动首帧保守放行**：首次
  `listModels` 可能短暂显示「无账号」的 provider 分组，后台算完后经
  `onVisibilityChanged` 广播纠正。同样未做真实 GUI 端到端验证。
- ⚠ **`antigravity-local` 的 `probeChannelsSync`** 在缓存过期时返回**上次已知
  值**并后台刷新。冷启动无缓存时返回 `undefined`，此时走静态兜底表 ——
  在「IDE 跑着但首次探测尚未完成」的窗口里会短暂显示兜底表而非本地目录。
- ⚠ **未跑 e2e**：`pnpm test:e2e:*` 均需真实凭据/额度，本次未执行。
- ⚠ **`scripts/probe-listmodels-nonblocking.mts` 未入库**：补丁不含它；
  其判据已由 `tests/unit/listmodels-nonblocking.spec.ts` 完整承接。

## 应用方式

```bash
git checkout -b fix/listmodels-nonblocking feat/zcode-provider
git apply listmodels-nonblocking.diff
# 或
git am 0001-perf-catalog-listModels.patch
```

基线分支：`feat/zcode-provider`（提交 `20e3c08`）

⚠ **注意**：当前工作区的默认分支是 `feat/zcode-gitee`（**不含** antigravity，
是 gitee 侧的删减变体）。本修复基于**完整分支** `feat/zcode-provider`，
因为缺陷清单里的 11 个适配器（含 `antigravity` / `antigravity-local`）只在该
分支上存在。
