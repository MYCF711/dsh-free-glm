# 交接文件（2026-09-27 18:30）

> 给压缩上下文后的我，或下一个接手者。**先读这份，再动手。**

---

## 一、目标与状态

**原目标**：用子代理探路，完成延迟优化达到 DSH 原生 API 速度，并优化壳内存。

**实际达成**：

| 子目标 | 状态 | 实测证据 |
|---|---|---|
| 延迟优化 | ✅ **部分达成** | 同负载 A/B：3 并发 **58.4 秒 → 21.2 秒**（省 64%） |
| **达到原生 API 速度** | ❌ **物理不可能** | 见 §三，已用实测证伪 |
| **壳内存优化** | ✅ **大幅达成** | **1275 → 949 MB（省 326 MB）** |

**插件版本**：0.2.3（已装到 web profile，**DSH 未重启**）

---

## 二、立刻要做的第一件事

### 2.1 重启 DSH（否则跑的还是旧代码）

```powershell
# 验证判据：DSH 启动时间 vs 插件文件修改时间
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'dsh.*--profile web' } |
  Select-Object ProcessId,CreationDate
```

DSH 启动时间**早于**插件落盘时间 = 正在跑旧代码。

### 2.2 桥（壳）当前是否活着

```powershell
$b = Get-Content 'D:\zcode-glm5.3f\_oss_data\.zcode\v2\bridge-port.json' -Raw | ConvertFrom-Json
Invoke-RestMethod "http://127.0.0.1:$($b.port)/health"
```

**不活就重启**：
```powershell
pwsh -File D:\zcode-glm5.3f\scripts\start-headless.ps1 -NoAutostart
```
⚠ **必须带 `-NoAutostart`** —— 否则插件保活会同时拉壳，两个启动源抢单实例锁。

---

## 三、已确定的事实（不要重复验证）

### 3.1 延迟：为什么追不上原生 API（**已证伪，别再试**）

**证据一：壳在整轮期间不落库中间态。**

27 秒的请求，21 次快照：

```
[ 1.5s] contentChars=267   ← 旧内容
[ 3.0s] contentChars=267
...（中间 16 次完全相同）...
[27.2s] contentChars=539   ← 只有最后一次跳变
```

⇒ **token 级流式无源可流**。把轮询间隔改成 10ms 也一样。

**证据二：每轮必须走壳内完整 agent turn。** 固有开销 5-25 秒。

**证据三：上游最快就是 8.5 秒。**

### 3.2 延迟：真的降了的部分

桥的并发上限默认 4（`ZCODE_BRIDGE_MAX_CONCURRENCY` 可覆盖，设 1 回退串行）。

| 配置 | 墙钟 |
|---|---|
| 并发=4 | **21166 ms** |
| 并发=1 | **58376 ms** |

机制证据：`queueWaitMs` 从 15290-17563ms **归零**。

### 3.3 内存：怎么省的（**这是本轮最大成果**）

**闸门在 `C:\Users\Administrator\.zcode\cli\config.json`**（我创建的）：

```json
{"plugins":{"enabledPlugins":{
  "browser-use@zcode-plugins-official": false,
  "computer-use@zcode-plugins-official": false,
  "documents@zcode-plugins-official": false,
  "pdf@zcode-plugins-official": false,
  "presentations@zcode-plugins-official": false,
  "spreadsheets@zcode-plugins-official": false,
  "skill-creator@zcode-plugins-official": false,
  "plugin-creator@zcode-plugins-official": false,
  "zcode-guide@zcode-plugins-official": false,
  "image-search@zcode-plugins-official": false,
  "restore-legacy-sessions@zcode-plugins-official": false
}}}
```

**机制（代码事实）**：

```js
function resolveBuiltInNodeReplMcpServers(e){
  let t = plugins.find(id === "browser-use@..." && enabled);
  let n = plugins.find(id === "computer-use@..." && enabled);
  if (!t && !n) return {};     // ← 两个都关 = node_repl 不注入 = 插件宿主不 spawn
  ...
}
```

实测：**插件宿主进程（148 MB）消失，工作集 1275 → 949 MB**（5 次采样中位）。

⚠ **回滚**：删掉那个 config.json 即可（原状态就是不存在）。
⚠ **副作用**：它是**用户级**配置，会影响官方闭源版 ZCode（推断，未实测）。

### 3.4 内存：已排除的方向（**别再碰**）

| 方向 | 为什么不行 |
|---|---|
| `--disable-features` 关 media 服务 | **无效**。开关传进去了，进程照样起。原因：它控制「功能」不控制「进程生命周期」 |
| 任何关 media 服务的做法 | **上限只有 7.4 MB** —— `video_capture` 的 104 MB 里**私有只有 7.4 MB**，其余是共享页 |
| `--enable-low-end-device-mode` | **省 95 MB，但弄坏 captcha**（实测请求 122735ms 返回空文本）。已保留为默认关闭的 `ZCODE_LOW_MEMORY=1` 实验开关 |
| agent 环境变量禁插件 | **不存在**（搜过 `ZCODE_DISABLE_PLUGIN` 等，都没有） |

### 3.5 3012：**不可绕过**（已用变量交换实验证明）

```
抢在桥之前用【新鲜 captcha】自己直发上游
  → 3012 转移到抢发方，桥反而拿到 3007
⇒ 3012 跟随「新鲜材料」移动，不跟随发送者、不跟随头集合
```

**已逐项排除**：补 11 个来源头 / 补 6 个会话头 / **25 个头逐字段对齐** /
5 组 body 变体 / 补客户端签名 —— **全部仍 3012**。

**唯一可行路径：走壳内会话链路。** 这也正是本项目的做法。

---

## 四、当前未完成的事

### 4.1 【等你】Gitee 建仓

- Gitee 用户 `MYCF711` **存在**，仓库 `dsh-free-glm` **不存在**
- 本机**无 Gitee token**
- 你选了「提供 token，我来建」—— **token 还没给我**
- 拿到后执行：`POST https://gitee.com/api/v5/user/repos` 建仓 → `git remote add gitee ...` → push

### 4.2 【等你】Jet Hub PR

- **PR 说明已写好**：`D:\zcode-glm5.3f\JET-HUB-PR-DRAFT.md`
- **关键发现**：Jet Hub 本地已有 `feat/zcode-provider` 分支实现了一个 zcode provider，
  但它走「自己解 captcha + 直连上游」，**它自己的文档 `docs/zcode-405-root-cause.md` 自陈
  「未定位到根因，已排除 13 个维度」**，实测**真实 Chromium 产的 captcha 仍 3012**
- 我的 PR 定位是**「已知路线不通，这是实测可行的替代」**，不是「再加一个 provider」
- **未 push**：还没建远程分支

### 4.3 【未攻克】纯 Node 路径 —— **最有价值的方向**

**实测：`zcode.cjs` 是完整 CLI，纯 Node 24 能启动它。**

```powershell
node D:\DSH-WEB\ZCode-official\apps\zcode-cli\packages\cli\dist\zcode.cjs --version
# → 0.16.9  (exit 0)

node ...zcode.cjs doctor
# → version: 0.16.9 / node: v24.20.0 / exit 0
```

**但 `--prompt` 失败**：
```powershell
node ...zcode.cjs --prompt "只回答两个字：正常" --cwd D:\zcode-glm5.3f
# → Error: Model creation failed (traceId: ...)   exit 1
```

**日志里没有记录**，说明它用了不同的数据目录、配置未正确传递。

⇒ **如果这条路走通，可以彻底扔掉 Electron 外壳（省约 338 MB：renderer 212 + gpu 68 + network 58）。**

**下一步建议**：查 `Model creation failed` 在 `zcode.cjs` 里的抛出点，
看它缺什么（凭据？provider 配置？还是必须有个 host 提供 provider config）。

### 4.4 【未做】日志字段补充

建议给 `bridge.chat.completed` 加 `wasEmptyReply` / `upstreamHttpStatus`。
现在只能从 `textLength` 反推，且 **180.1s 与 209.5s 都出现过**，说明
`textLength=0` 与超时**不是同一件事**，无法区分「模型真空回复」与「超时截断」。

---

## 五、我犯过的错（**别再犯**）

### 5.1 用「跨时段日志对比」证明优化效果 —— **被判据推翻**

我曾得出「长尾（180 秒）消失」，**独立复核用数据推翻**：

- `mean/p50` 比值不稳定 —— 13 时内部一段**串行**负载 p50=15075，
  与 17 时的 15621 几乎相同；13 时那条差距**全部来自一条** 180 秒空回复
- 两类负载不可比（并发到达率 0/38 vs 9/18）
- 长尾主类目 `textLength=0` 在 17 时**零样本** —— **「没观测到」≠「已消除」**

**判据原则（务必遵守）**：
1. **同负载 A/B > 跨时段对比**
2. **优先用直指机制的指标**（如 `queueWaitMs` 比 `durationMs` 好）
3. **分层比较**（至少按 `textLength` 分层）
4. **「没观测到」≠「已消除」**

### 5.2 「进程消失」看一次就下结论 —— **那是偶然**

我曾看到 media 服务进程消失，就认为 `disable-features` 生效了。
**下次启动它又回来了** —— 服务是懒启动的。
**任何进程级观测必须多次复查。**

### 5.3 凭记忆写特性名

`disable-features` 的特性名我**从 electron.exe 二进制里逐字节检索确认过**才对。
**写错名字不会报错，只会静默无效** —— 比不写更糟。

### 5.4 PowerShell 的 `$Matches` 会被覆盖

```powershell
# 错误：后一个 -match 覆盖了前一个的 $Matches
if ($l -match '^\[([\d\-: .]+)\]' -and $l -match '"durationMs":(\d+)') { $ts = $Matches[1] }
#                                                                              ^^^^^^^ 这是 durationMs！

# 正确：先存进变量
if ($l -notmatch '^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})') { continue }
$ts = $Matches[1]
```

### 5.5 `AppendSwitch` 的布尔开关传值 = 反效果

`disable-renderer-backgrounding` 是**布尔开关**，Chromium **只看它在不在，不看值**。
我写过 `appendSwitch("disable-renderer-backgrounding", "0")`，
以为传 0 就是不启用 —— **实际是启用**，与想要的相反。已删除。

### 5.6 `snapshot-oss-patches.ps1` 漏文件不报错

`$tracked` 清单**漏文件时不报错**，只是安静地少收集一个。
**判据是核对补丁字节数是否变化**（实测踩过：字节数一个都没变）。

---

## 六、关键路径与命令

```
工作区（可写）        D:\zcode-glm5.3f
插件源码              D:\zcode-glm5.3f\dsh-plugin-zcode-bridge
壳源码                D:\DSH-WEB\ZCode-official
壳数据目录            D:\zcode-glm5.3f\_oss_data
壳日志                D:\zcode-glm5.3f\_oss_data\.zcode\v2\logs\<日期>.log
插件禁用配置          C:\Users\Administrator\.zcode\cli\config.json
发布仓库（GitHub）    D:\dsh-free-glm
Jet Hub 上游          D:\DSH-WEB\Jet-Hub-upstream
```

### 常用命令

```powershell
# 启动壳（必须 -NoAutostart）
pwsh -File D:\zcode-glm5.3f\scripts\start-headless.ps1 -NoAutostart
# 停止壳
pwsh -File D:\zcode-glm5.3f\scripts\start-headless.ps1 -Stop

# 改壳源码后重建（tsup）
cd D:\DSH-WEB\ZCode-official\packages\desktop
npx tsup --config tsup.config.ts

# 改插件后构建 + 装
cd D:\zcode-glm5.3f\dsh-plugin-zcode-bridge
npm run build
npm pack --pack-destination D:\zcode-glm5.3f\dist
$env:DSH_HOME="$env:APPDATA\in.dsh-plug.dsh-launcher\homes\0.1.7-rc.2"
& "$env:APPDATA\in.dsh-plug.dsh-launcher\versions\0.1.7-rc.2\node_modules\.bin\dsh.CMD" `
  plugin --profile web add D:\zcode-glm5.3f\dist\dsh-zcode-bridge-0.2.3.tgz

# 更新壳侧补丁快照（改完壳源码必跑）
pwsh -File D:\zcode-glm5.3f\scripts\snapshot-oss-patches.ps1

# 端到端验证（真实 DSH 会话 + 工具调用）
$env:DSH_HOME="$env:APPDATA\in.dsh-plug.dsh-launcher\homes\0.1.7-rc.2"
$env:ZCODE_DATA_BASE_DIR='D:\zcode-glm5.3f\_oss_data'
& "$env:APPDATA\in.dsh-plug.dsh-launcher\versions\0.1.7-rc.2\node_modules\.bin\dsh.CMD" `
  --profile zcbtest2 --json "用 glob 工具查找 D:\dsh-free-glm 下的 .ps1 文件"
# 期望：tool_call 与 tool_result 成对出现
```

---

## 七、文档索引

| 文件 | 内容 |
|---|---|
| `D:\zcode-glm5.3f\HANDOFF-CURRENT.md` | **本文件** |
| `D:\zcode-glm5.3f\LATENCY-FINDINGS.md` | 延迟/内存完整实测报告（含被推翻结论的留证） |
| `D:\dsh-free-glm\LIMITATIONS.md` | 已知缺点清单 |
| `D:\zcode-glm5.3f\JET-HUB-PR-DRAFT.md` | Jet Hub PR 说明（待提交） |
| `D:\dsh-free-glm\AGENTS.md` | （在仓库里）开发历史与坑列表 |
| `D:\zcode-glm5.3f\AGENTS.md` | DSH 会话自动读取的指令文件 |

---

## 八、一句话

**能用的部分都能用了（对话 + 工具调用，实测跑通）；延迟降了 64%；
内存省了 326 MB；剩下的两个大项（追平原生 API、纯 Node 脱离 Electron）
前者已证伪、后者未攻克。**
