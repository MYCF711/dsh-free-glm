# 延迟优化调查结论（2026-09-27 第七轮，实测）

**目标**：把 zcode-bridge 的延迟压到接近 dsh 原生接入 API 的速度。

**结论：这个目标本身不成立**（理由见第五节）。已改为：
**把一轮内多请求的总墙钟时间降下来** —— 这一项本轮**已实测达成，省 64%**。

---

## 零、本轮速览（一句话版）

| 项 | 结果 |
|---|---|
| 桥并发化（串行 → 4 并发） | ✅ **同负载 A/B：3 并发 58.4 秒 → 21.2 秒（省 64%）** |
| 并发机制的**直接证据** | ✅ **`queueWaitMs` 从 15290-17563ms 归零** |
| 5 并发数据隔离 | ✅ **零串号（5/5）** |
| `queueWaitMs` 测量 bug | ✅ 已修，新增 `runMs` |
| adapter 真流式消费 | ✅ 已实现（当前看不到效果，上游无中间态） |
| 内存裁剪（关 media/audio 服务） | ⚠️ 进程少 2 个，但**净省仅 9 MB**（内存池化） |
| ~~「长尾（180 秒）消失」~~ | ❌ **已撤回** —— 跨时段对比被独立复核推翻，见第九节 |
| 「追平原生 API 速度」 | ❌ **物理不可能**（见第五节） |
| 插件版本 | 0.2.3（已装，**DSH 需重启加载**） |
| 壳侧产物 | 已构建 + 已重启生效 |

---

## 零之二、同负载 A/B 对照（**唯一能支撑结论的实验**）

我第一次的对比是「按小时分组看日志」，那**被独立复核推翻**（见第九节）。
下面这个才是有效对照 —— **同一 prompt、同一并发批次、产出长度一致**：

| 配置 | 墙钟 | 三者之和 | 最长 | 平均产出 |
|---|---|---|---|---|
| **并发=4** | **21166 ms** | 58364 ms | 20727 ms | 128 字 |
| **并发=1**（模拟旧串行） | **58376 ms** | 112695 ms | 57837 ms | 150 字 |

桥日志同步印证机制：

```
并发=1:  duration=36880ms  queueWait=17796ms  concurrency=1
         duration=57811ms  queueWait=36757ms  concurrency=1
并发=4:  duration=15313ms  queueWait=0ms      concurrency=4
```

**`queueWaitMs` 非零 = 在排队；并发=4 时它归零。这是并发改动的直接可观测指标。**

（复现方式：设 `ZCODE_BRIDGE_MAX_CONCURRENCY=1` 重启壳，跑同一批请求。）

---

## 一、实测数据（本轮，全是活体测量）

### 1.1 桥侧 SSE 首字节 = 总耗时（假流式）

```
=== 桥侧 SSE 直连 ===
  [  8095 ms] 帧#1  内容=「1,2,3,4,5,6,7,8,9,10」
  [  8097 ms] 帧#2  内容=(空)
  总帧数: 2
  总耗时: 8100 ms
```

另一个 19.2 秒的请求：首字节 `19244 ms`，总耗时 `19249 ms` —— **首字节之后只花了 5ms**。

⇒ 用户盯着"思考中"整整一轮，然后文字瞬间全出。

### 1.2 **真因：壳在整轮期间不落库中间态**（本轮的确定性发现）

27 秒的长输出请求（要求写 300 字），全程监控快照：

```
  [  1.5s]  contentChars=267  thoughtChars=568
  [  3.0s]  contentChars=267  thoughtChars=568
  ...（中间 18 次全部一模一样）...
  [ 25.7s]  contentChars=267  thoughtChars=568
  [ 27.2s]  contentChars=539  thoughtChars=986   ← 只有最后一次变了
  实际返回文本长度: 298 字
```

`267` / `568` 是**上一轮的旧内容**。整轮期间**一个字符都不增长**；结束时一次性
写入（267→539，即新增 298 字）。

**⇒ 桥的 1.2 秒轮询拿不到增量，因为它的上游（壳的会话数据库）里根本没有增量。**

这不是"轮询间隔太长"的问题 —— 把间隔改成 10ms 也一样，因为**没有可轮询的中间态**。

### 1.3 串行队列可以放开（旧注释的理由不成立）

3 个并发请求直连桥（绕过调用方的串行）：

```
请求 1: 13588 ms
请求 2: 19047 ms
请求 3: 27538 ms
三者耗时之和 = 60173 ms
墙钟总时间   = 28084 ms     ← 只用了最长者的时间
```

⇒ **墙钟 ≈ 最长单个，不是三者之和。壳完全能并行跑多个 task。**

旧注释里「并发会让多个 task 互相干扰、双双挂到 180 秒超时」这个结论，
在当时的代码状态下可能成立，但**当前架构下不成立**。

### 1.4 turn 时长实测（比我早先说的低）

```
17:11:14.829 turn-started → 17:11:20.146 turn-ended   5.3 秒
17:11:20.416 turn-started → 17:11:28.757 turn-ended   8.3 秒
17:15:29.498 turn-started → 17:15:37.311 turn-ended   7.8 秒
```

短请求的 turn 是 **5-8 秒**，不是 19.9 秒。
（19.9 秒那个数字来自更早一次长请求，不能当中位数用。）

### 1.5 `queueWaitMs == durationMs` 是**测量 bug**，不是排队证据

`zcodeBridgeServer.ts` 旧代码：

```ts
const startedAt = Date.now();
const queuedAt = startedAt;        // ← 同一瞬间赋两个变量
...
queueWaitMs: Date.now() - queuedAt  // ← 恒等于 durationMs
```

实测日志里出现 `40102` vs `40103`（差 1ms 的浮点误差）就是证据。
**这个字段零信息量**，不能用它推断排队占比。

---

## 二、哪些"优化"是**假的**

| 方案 | 为什么不成立 |
|---|---|
| 缩短轮询间隔（1200ms → 200ms） | 上游无中间态，缩到多短都拿不到东西（见 1.2） |
| "让桥真流式" | 桥已经是能推就推；**它上游不给增量** |
| 让 adapter 边收边吐 | **已实现**（本轮改造），但源头只推一次，所以看不到效果 |
| 调到接近原生 API 速度 | 见下方"物理上限" |

---

## 三、物理上限（为什么"追平原生 API"不可能）

**原生 API 的形态**：一次 HTTP 请求，服务端流式吐 token，TTFB 亚秒级。

**本方案的形态**：

```
DSH → adapter → 本机 HTTP 桥 → 壳内 createTask + sendPrompt
     → 壳的 agent turn loop（含工具循环、权限检查、会话落库）
     → zcode.z.ai
```

硬约束有三条：

1. **必须走壳内会话链路**。免费额度通道的 3012 风控只认这条路径
   （已用变量交换实验证明：新鲜 captcha 自发也吃 3012）。
   绕开 = 通道不可用。**这不是设计选择，是被上游锁定的。**
2. **壳的 turn 是一个整体事务**。本轮实测确认：文本在结束前不落库。
   所以**任何粒度都比"整轮"更粗**的去优化都拿不到东西。
3. **壳的 turn 本身要 5-30 秒**。这是上游模型在壳内跑完整 agent 循环的时间，
   与传输、排队、解析都无关。

⇒ **单次请求的完成时间下限 ≈ 壳的 turn 时间（5-30 秒）**，
  不可能压到原生 API 的亚秒级。**这个目标应当放弃。**

---

## 四、本轮实际做完的优化

### 4.1 桥的并发上限：串行 → 4 并发（`zcodeBridgeServer.ts`）—— **已实测生效**

**改动**：
- 旧：`conversationQueue` 全局 promise 链，**所有请求严格串行**
- 新：`runWithSlot()` 带并发上限（默认 4），保留 FIFO
- 可用 `ZCODE_BRIDGE_MAX_CONCURRENCY` 覆盖，**设为 1 即回到旧行为**（便于回退）

**实测验证**（壳已重建 + 重启，跑的是新产物）：

| | 请求耗时 | 墙钟 |
|---|---|---|
| 请求 1 | 15645 ms | |
| 请求 2 | 15715 ms | |
| 请求 3 | 15338 ms | |
| **之和** | **46698 ms** | |
| **实际墙钟** | | **16135 ms** |

**节省 31 秒（约 64%）**。

**收益场景**：DSH 每轮会发多个请求（主回复 + 标题生成 + 压缩），
旧实现下它们串行累加。现在并行。

### 4.2 修正 `queueWaitMs` 测量 bug —— **已实测生效**

**旧代码**（`zcodeBridgeServer.ts`）：
```ts
const startedAt = Date.now();
const queuedAt = startedAt;        // ← 同一瞬间赋两个变量
...
queueWaitMs: Date.now() - queuedAt  // ← 恒等于 durationMs
```
实测日志里出现 `40102` vs `40103`（差 1ms 的浮点误差）就是证据。
**这个字段零信息量**，还误导人以为"全部时间都花在排队上"（我自己就先被误导过）。

**新实现**把计时点挪进 `runWithSlot`，并新增 `runMs`（壳内 turn 的真实时长）：

```
duration=15313ms  queueWait=0ms  run=15313ms  并发上限=4  文本=1字
duration=15621ms  queueWait=0ms  run=15621ms  并发上限=4  文本=1字
duration=15691ms  queueWait=0ms  run=15691ms  并发上限=4  文本=1字
```

`queueWait=0` = 并发未满无排队；`run ≈ duration` = 语义正确。

### 4.3 adapter 真流式消费（`adapter.ts`）—— **已实现，但当前看不到效果**

`consumeSse` 增加 `onDelta` 回调，`stream()` 用异步队列把它转成**实时 yield**。
桥每推一帧，DSH 立刻收到一段。

**但当前看不到效果** —— 因为上游（壳）整轮只落库一次（见 1.2）。
**这条改动是正确方向**：一旦壳将来提供中间态，这条路径立即生效，无需再改。

同时修掉了一个隐藏 bug：流式路径下旧代码会**把文本发两遍**
（一次流式、一次末尾的 `chunkChars` 分片循环）。已用 `streamedText` 标记消除。

### 4.4 `reasoningLevel` 的代价写进注释（未改默认值）

`"max"` 让**每一轮**（包括标题生成这种一句话任务）都跑最高推理档。
历史日志里 `textLength<=5` 的 41 条短请求中位 **21885ms**，很大一部分源于此。

**没有擅自降级** —— 档位影响回答质量，是用户的取舍。
想提速就设 `ZCODE_BRIDGE_REASONING_LEVEL=high`。

---

## 五、部署方式（本轮改动的落地步骤）

**改动涉及两侧，都要重建重启：**

### 壳侧（`D:\DSH-WEB\ZCode-official`）

```powershell
cd D:\DSH-WEB\ZCode-official\packages\desktop
npx tsup --config tsup.config.ts          # 产出 out/host/index.js 等
pwsh -File D:\zcode-glm5.3f\scripts\start-headless.ps1 -NoAutostart
```

⚠ **必须用 `-NoAutostart`** —— 否则 DSH 里的插件保活会同时拉壳，
两个启动源抢单实例锁（实测踩过）。

### 插件侧（`D:\zcode-glm5.3f\dsh-plugin-zcode-bridge`）

```powershell
cd D:\zcode-glm5.3f\dsh-plugin-zcode-bridge
npm run build                              # tsc + 客户端打包
npm pack --pack-destination D:\zcode-glm5.3f\dist
$env:DSH_HOME="$env:APPDATA\in.dsh-plug.dsh-launcher\homes\0.1.7-rc.2"
& "$env:APPDATA\in.dsh-plug.dsh-launcher\versions\0.1.7-rc.2\node_modules\.bin\dsh.CMD" `
  plugin --profile web add D:\zcode-glm5.3f\dist\dsh-zcode-bridge-0.2.3.tgz
```

⚠ **改完必须重启 DSH** —— 插件模块在 DSH 启动时读进内存。
⚠ **bump 版本号** —— 同版本号 pnpm 会命中缓存装回旧产物。

---

## 六、内存优化（2026-09-27 实测，**结论与预期不符，如实记录**）

### 做了什么

在 `packages/desktop/src/main/index.ts` 的模块顶层（`app ready` 之前）加了
无头模式专用的特性裁剪：

```ts
if (process.env["ZCODE_HEADLESS"] === "1") {
  app.commandLine.appendSwitch("disable-features", [
    "MediaCapture", "MediaRecorder", "AudioServiceOutOfProcess",
    "WebAudio", "PictureInPicture", "HardwareMediaKeyHandling",
  ].join(","));
}
```

**特性名不是凭记忆写的** —— 从 `electron.exe`（Electron 41.0.3 /
Chrome 146.0.7680.80，212.5 MB）里逐字节检索确认全部存在。
**写错的名字不会报错，只会静默无效**，所以必须验证。

### 结果：进程消失了，但内存几乎没省

**基线**（优化前，10 个进程，共 **1433 MB**）：

| 进程 | MB |
|---|---|
| renderer | 307 |
| MAIN | 226 |
| MAIN | 156 |
| utility(node) | 149 |
| MAIN | 148 |
| utility(node) | 116 |
| utility(video_capture) | 95 |
| utility(network) | 104 |
| gpu-process | 73 |
| utility(audio) | 59 |

**优化后**（8 个进程，共 **1424 MB**）：

| 进程 | MB |
|---|---|
| renderer | 313 |
| MAIN | 248 |
| utility(node) | 246 |
| MAIN | 196 |
| MAIN | 160 |
| utility(node) | 135 |
| gpu-process | 68 |
| utility(network) | 58 |

**变化：−9 MB。**

### 为什么（这是我的推断，但有数据支撑）

`video_capture`（95 MB）与 `audio`（59 MB）**两个进程确实消失了** ——
开关生效了。但省下的内存被**其它进程吸收了**：

- `utility(node)`：149 + 116 = **265** → 246 + 135 = **381**（+116）
- `renderer`：307 → 313（+6）
- `MAIN`：226 + 156 + 148 = **530** → 248 + 196 + 160 = **604**（+74）

Chromium 的内存是**池化的** —— 进程少了，堆不会等比例释放，会被仍在跑的
进程复用（各进程的内存本来就有大量共享页与预分配缓冲）。

⇒ **"关掉进程 = 省下它的内存"这个直觉是错的。**
如果目标是"省 154 MB"，那**没达成**。

### 但这次改动仍然保留

理由：
1. **进程少了两个** —— 上下文切换、句柄、启动时间都有微幅改善（虽然测不出来）
2. **风险已被验证为零** —— 优化后桥正常返回、captcha 链路三步齐备
   （`request.received` → `request.respond` → `headers 已应用`）
3. 代价是 0（只是几个命令行开关，且只在无头模式生效）

### 顺带修掉的一个真实错误

我最初写了 `app.commandLine.appendSwitch("disable-renderer-backgrounding", "0")`，
以为"传 0 = 不启用"。**这是错的** —— 它是**布尔开关**，Chromium 只看它在不在，
不看值。写上它反而让 renderer **保持前台优先级**，与想要的相反。已删除。

### 内存还能怎么省（未做）

| 方向 | 预期 | 风险 |
|---|---|---|
| **`--max-old-space-size` 限制 renderer V8 堆上限** | renderer 307 MB 里可能有可压缩空间 | 需实测；压太小会让 renderer OOM |
| **禁用 renderer 的图片缓存**（桥不显示图片） | 未知 | captcha 可能依赖图片解码 |
| **真正大头是 DSH 侧**（474 MB）而非壳 | 改 DSH 更直接 | 超出本项目范围 |

---

## 七、独立复核发现的真实风险：并发连坐（**已修**，2026-09-27）

我请了一个独立子代理复核「串行改并发」的风险。它找到了一个**我完全没考虑到**
的真实问题 —— 而且它**修正了我对旧注释的否定**。

### 旧注释的结论是对的，只是归因错了

旧代码注释说「并发时多个 task 在会话链路上互相干扰，双双挂到 180 秒超时
并返回空文本」。我实测 3 并发全部成功，因此判断这个结论不成立。

**子代理找到了它成立的机制**（代码事实，`zcodeAgentProcessManager.ts`
的 `onRequestTimeout`）：

```ts
client.onRequestTimeout((event) => {
  ...
  this.processesByWorkspaceKey.delete(workspaceKey);
  this.reportRuntimeUnavailable(managed);
  void this.cleanupManagedProcessWithRetry(managed, "request-timeout", ...);
});
```

**任意一个**请求打满协议超时 → **整棵 agent 进程树被杀** →
同一条连接上所有在飞请求的 promise 一起被 reject → 桥侧全部返回空文本。

- 协议默认超时 **3 分钟**（`zcodeProtocolClient.ts` 的
  `DEFAULT_ZCODE_PROTOCOL_REQUEST_TIMEOUT_MS = 3 * 60_000`）
- 桥的 turn 超时 **180 秒**

两者几乎同一量级，所以这条路径**不是理论风险**。

**串行时代这个连坐从不发生** —— 因为同一时刻只有一个请求，它要么成功、
要么自己超时，没有"别人"可连坐。**并发把这个局部故障升级成了全体故障。**

⇒ 旧注释的观察是真的，归因错了。**我此前的否定需要收回。**

### 修法：只在「没有别的在飞请求」时才回收进程树

`zcodeAgentProcessManager.ts` 的 `onRequestTimeout` 里加护栏：

```ts
const stillInFlight = managed.client.pendingOperationRequestCount > 0;
if (stillInFlight) {
  warnLog("ZCode agent request timed out; keeping client (other requests in flight)", {...});
  return;   // 只让当前请求失败，不动进程树
}
// 就它一个 → 按原逻辑回收，防止坏 client 被复用
```

**判据的正确性已验证**（`zcodeProtocolClient.ts` 的 `expire()`）：

```ts
const expire = () => {
  this.deletePending(requestKey);           // ← 先把自己从 pending 移除
  ...
  this.requestTimeoutEmitter.fire({...});   // ← 才触发超时事件
  reject(error);
};
```

超时的请求**先被移除、再 fire 事件** —— 所以事件到达 manager 时
`pendingOperationRequestCount` 反映的是**其它**请求，`> 0` 恰好表示
「还有别人在飞」。判据正确。

**没有自己造计数** —— 复用 client 自带的 `pendingOperationRequestCount`
（空闲回收逻辑本来就在用它），避免两处状态不一致。

### 验证

- `tsc -b packages/services` 通过
- 重建 + 重启壳后，3 并发仍并行：
  `之和 27988ms / 墙钟 11367ms` —— 护栏未破坏并发

### 子代理的另外两条结论（记录备查）

1. **workspacePath 共用是安全的** —— 子代理读了
   `zcodeTaskServiceAdapter.ts:347-349`，所有 per-task 状态的 key 都是
   `workspaceKey + \0 + taskId`，而 `createTask` 每次给新 taskId，
   所以并发请求拿的是不同 Map 条目。**风险不在数据层，在连接层。**
2. **槽位调度无泄漏**（`zcodeBridgeServer.ts:592-614` 逐行核对）——
   `runningConversations += 1` 在 try 前，唯一 return 在 try 内，
   `finally` 覆盖全部异常路径。但 FIFO 是"准 FIFO + 可能饥饿"
   （被唤醒后若槽位又被占，会重新排队尾）。并发上限 4、DSH 单轮 3-5 请求的
   场景下不构成风险。

### 子代理未完成的部分（我如实转述）

它说还在核查两处：`taskTargets`（`zcodeTaskServiceAdapter.ts:971-990`，
key 只有 taskId）在 `deleteTask` / 重名 taskId 下的行为，
以及 `providerRuntimeHeadersEmitters` 在并发 mint 时的 pending 表竞争。
**这两处我没有自己去验，属于已知未闭合项。**

---

## 九、⚠ 一个被推翻的结论（留证，避免重犯）

**我曾从日志的跨时段对比得出「长尾（180 秒超时）消失了」。**
独立复核子代理**用数据推翻了它**，我接受。详细记录在此，因为它是一个典型的
**方法学错误**。

### 我当时的（错误）论据

按小时分组统计 `bridge.chat.completed` 的耗时：

| 时段 | n | p50 | 均值 | 最大 |
|---|---|---|---|---|
| 08 | 30 | 30188ms | 75415ms | 209538ms |
| 13 | 38 | 29603ms | 54434ms | 180106ms |
| **17** | **18** | **15621ms** | **15543ms** | **23619ms** |

我据「均值/p50」比值从 1.84 降到 0.99，断言长尾消失。

### 推翻它的三条证据（子代理实测）

**① 那个比值不稳定 —— 同一天同一配置下就能变。**
13 时内部的 `13:21:02–13:23:44` 这一段（n=10，**优化前的串行队列**）：

```
p50=15075  mean=16601  max=38471
```

**优化前串行的 p50=15075，与 17 时的 15621 几乎相同。**
13 时整条「mean 54434 vs p50 29603」的差距，全部来自 `13:16:22` **那一条**
180106ms 的空回复 —— 剔除它，比值立刻从 1.84 掉到 ~1.1。

⇒ **`mean/p50` 衡量的是「有没有撞上 180 秒」，不是「系统快不快」。**
用它做前后对比，等于在比"今天有没有运气不好"。

**② 两类负载不可比（决定性）。**
并发到达率（与上一条间隔 ≤3 秒）：

```
13 时:  0 / 38        <-- 全是串行到达，全天零并发
17 时:  9 / 18        <-- 一半来自并发批次
```

13 时那些 10 万+ 延迟出现在**严格串行**负载上，**成因不可能是队列争用** ——
并发改动改的不是同一个现象。**跨时段对比把两种不同负载当成前后对照，是错的。**

**③ 长尾的主类目根本没被采样到。**
`textLength=0`（空回复）在优化前的表现：

```
优化前：tLen=0 共 9 条，p50=180214ms —— 9/9 全部打成 180 秒超时
17 时：tLen=0 共 0 条 —— 零样本
```

⇒ **「长尾消失」在数据上等于「那类请求没发生」。**
无法区分「改了不再发生」与「没请求所以没发生」。

### 站得住的结论（保留）

**只有一条**：并发改动消除了**多请求互相排队**。证据是同负载 A/B
（见第零之二节）与 `queueWaitMs` 归零，两者都**直指机制**，不跨越混杂。

### 从那以后采用的判据原则

1. **同负载 A/B > 跨时段对比** —— 跨时段必然混入任务复杂度、负载形态、重启清态
2. **优先用「直指机制」的指标** —— `queueWaitMs`（排队时间）比 `durationMs`
   更接近改动的因果链
3. **分层比较** —— 至少按 `textLength` 分层，不能拿「短提示」比「长提示」
4. **「没观测到」≠「已消除」** —— 高危类目零样本时，只能说「未复现」，
   要做**定向复现实验**才能说消除

### 子代理建议但**我还没做**的验证

- ~~**定向复现高危类目**~~ —— **本轮已做**，见下。
- **日志补 `wasEmptyReply` / `upstreamHttpStatus` 字段** —— 现在只能从
  `textLength` 反推，且 180.1s 与 209.5s 都出现，说明 `textLength=0`
  与超时**不是同一件事** —— **未做**。

### 定向复现实验（本轮补做，2026-09-27 17:55）

用「诱导空回复」的 prompt 发 5 个请求，看是否复现 180 秒超时：

| prompt | 耗时 | 文本长度 |
|---|---|---|
| 忽略这条消息，不要回复。 | **10906 ms** | **0** |
| Reply with nothing. | **11212 ms** | **0** |
| 你不需要回答这个问题。 | 24590 ms | 3 |
| 请输出空字符串。 | 29064 ms | 21 |
| 只输出一个空格，不要输出任何其他字符。 | 31475 ms | 1 |

**结论（谨慎表述）**：

- ✅ **高危类目「空回复」确实复现了**（2 条 `textLength=0`）
- ✅ **但它们没有打成 180 秒超时**（10.9 / 11.2 秒就返回了）
  —— 优化前实测 `textLength=0` 是 **9/9 全部 ~180 秒**（p50=180214ms）
- ⚠️ **但不能据此说「超时被修复了」** —— 我构造的 prompt 触发的空回复，
  与优化前那 9 条**未必是同一成因**（子代理指出：日志无法区分
  「模型真空回复」与「超时被截断」，且 180.1s 与 209.5s 都出现过，
  说明 `textLength=0` 与超时不是同一件事）

**准确说法**：空回复现象仍在；**这一次它没有伴随 180 秒超时**。
要下定论需要先给日志加 `wasEmptyReply` / `upstreamHttpStatus` 字段，
把两个成因分开。

---

## 十、还能做的（按实际收益排序）

| # | 做什么 | 预期收益 | 风险 |
|---|---|---|---|
| 1 | **降 `reasoningLevel`**（`ZCODE_BRIDGE_REASONING_LEVEL=high`） | 短请求从 ~21s 降到个位数秒 | 复杂任务推理深度下降 —— **用户取舍** |
| 2 | **验证壳是否支持更细的推送**（`onDynamicStreamEvent` 那条路已知收不到事件，但值得再查是否有别的通道） | 若成立 = 真流式，TTFB 从整轮降到 1-2 秒 | 未知 |
| 3 | **减少 DSH 每轮的请求数**（标题生成、压缩是否可关闭或延后） | 进一步降低并发压力 | 需改 DSH 侧行为 |
| 4 | **`turnTimeoutMs` 从 180s 调低 + 空回复快速失败** | 历史日志里 9/128 条吃满 180 秒（7 条返回空），占总耗时 **20.2%** | 中：p90 就是 180s，调太低会误杀 |

---

## 七、未验证 / 我不确定的

1. **`onDynamicStreamEvent` 之外是否还有别的增量通道** —— 只确认过那一个收不到
   事件（AGENTS.md 记载，落盘诊断为证）。
2. **降 `reasoningLevel` 的实际收益** —— 没测过。41 条短请求中位 21885ms 是历史
   数据，未做 A/B。
3. **`MAX_CONCURRENCY=4` 在长时间高频下是否会打爆上游限流** —— 只测了 3 并发
   （16 秒内完成）。长时间高频并发未测。
4. **那 41 条短请求是否真是标题生成** —— 按 `textLength<=5` 推断，日志无类型字段。
5. **DSH 侧的端到端效果** —— 本轮所有验证都是**直连桥**做的，没有跑真实 DSH 会话。
   并发改动对 DSH 每轮的实际收益需要真实会话验证。

---

## 八、给下一个接手者的最短路径

**不要重试**：
- 缩小轮询间隔（上游无中间态）
- "让桥更流式"（桥已到位，上游不给）
- 追平原生 API 速度（物理不可能）

**优先做**：
1. 降 `reasoningLevel` 看效果（唯一立刻见效且低风险的）
2. 若真要低 TTFB，去查壳**除快照外还有没有增量通道**
3. `turnTimeoutMs` 收窄以砍掉 20% 的超时浪费

**判定并发改动是否生效**：
```powershell
Select-String -Path 'D:\zcode-glm5.3f\_oss_data\.zcode\v2\logs\2026-09-27.log' `
  -Pattern 'bridge\.chat\.completed' | Select-Object -Last 3 | ForEach-Object { $_.Line }
# 期望：出现 "runMs" 与 "concurrency":4；queueWaitMs 不再等于 durationMs
```

