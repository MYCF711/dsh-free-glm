# dsh-free-glm

**在 DSH（DeepSeek Harness）里免费用 GLM-5.3 —— 装完即用，无需 API Key。**

把 ZCode 的**免费额度通道**（`account:bigmodel-start-plan`）接进 DSH，作为一个普通模型
provider 使用。支持**对话**与**工具调用**。

```
DSH ──▶ 本插件 ──▶ 本机 HTTP 桥 ──▶ ZCode 实例的会话链路 ──▶ zcode.z.ai
        (provider)   (loopback)      (createTask/sendPrompt)   (免费额度)
```

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

### 步骤 1：部署 ZCode 开源版实例（含桥）

```powershell
git clone https://github.com/MYCF711/dsh-free-glm.git
cd dsh-free-glm
pwsh -File deploy-zcode-instance.ps1
```

这个脚本做四件事：clone 上游 ZCode 开源版 → 应用桥补丁 → 装依赖（约 2.8GB）
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

```powershell
# 从本仓库的 Release 下载 tgz，然后：
dsh plugin --profile <你的profile> add .\dsh-zcode-bridge-0.2.0.tgz
```

或者直接指向本地文件：

```powershell
dsh plugin --profile web add file:D:/dsh-free-glm/dsh-zcode-bridge-0.2.0.tgz
```

> **注意**：`dsh plugin add` 装**同一版本号**的 tgz 时 pnpm 会命中缓存装回旧产物。
> 换了新版本先 bump 版本号。

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
| 0.2.0 | 工具调用（提示词桥接）+ 空回复明确报错 + provider 显示修复 |
| 0.1.x | 基础对话链路 |

---

## 许可

MIT。本项目**不含** ZCode 的任何源码，只包含针对它的补丁与本机桥实现。
使用前请自行确认符合 ZCode 的服务条款。
