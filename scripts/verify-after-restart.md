# 重启后验证脚本 —— zcode-bridge 0.3.4 快速路径

**用途**：DSH 重启后跑这一个脚本，确认快速路径已在 GUI 里生效。

## 背景（为什么需要它）

插件是**普通目录**，但 DSH 进程在**启动时**把模块读进内存 ——
**改完文件不重启，跑的还是旧代码**。

判据：**DSH 启动时间早于插件文件修改时间 = 正在跑旧代码**。

实测证据（2026-09-27）：
```
端口 57108 由 pid=25448 监听
  pid=25448 启动 17:06:44        ← GUI 背后的实例
  插件文件改于 22:5x             ← 晚于启动时间
⇒ 跑的是旧版 0.3.2
```

## 一键验证

```powershell
$env:DSH_HOME = "$env:APPDATA\in.dsh-plug.dsh-launcher\homes\0.1.7-rc.2"

# 1) 插件版本（应为 0.3.4）
"插件版本: " + (Get-Content "$env:DSH_HOME\profiles\web\node_modules\dsh-zcode-bridge\package.json" -Raw | ConvertFrom-Json).version

# 2) DSH 启动时间 vs 插件文件修改时间
$inst = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'dsh.*--profile web' } |
  Sort-Object CreationDate | Select-Object -First 1
"DSH 启动: $($inst.CreationDate)"
"插件文件: $((Get-Item "$env:DSH_HOME\profiles\web\node_modules\dsh-zcode-bridge\lib\adapter.js").LastWriteTime)"
if ($inst.CreationDate -gt (Get-Item "$env:DSH_HOME\profiles\web\node_modules\dsh-zcode-bridge\lib\adapter.js").LastWriteTime) {
  "  ✓ DSH 已加载新代码"
} else {
  "  ✗ DSH 跑的还是旧代码 —— 需要重启"
}

# 3) 桥健康
$b = Get-Content 'D:\zcode-glm5.3f\_oss_data\.zcode\v2\bridge-port.json' -Raw | ConvertFrom-Json
try { "桥: ok=" + (Invoke-RestMethod "http://127.0.0.1:$($b.port)/health" -TimeoutSec 5).ok }
catch { "桥: 不可达" }
```

## 真实会话验证（用 headless，不影响 GUI）

```powershell
$env:ZCODE_DATA_BASE_DIR = 'D:\zcode-glm5.3f\_oss_data'
& "$env:APPDATA\in.dsh-plug.dsh-launcher\versions\0.1.7-rc.2\node_modules\.bin\dsh.CMD" `
  --profile headless --json `
  "用 glob 工具列出 D:\zcode-glm5.3f\dsh-plugins 里的 tgz，告诉我最新的版本号"
```

**期望输出**：

```json
{"type":"tool_call","tool":"glob","input":{"path":"...","pattern":"*.tgz"}}
{"type":"tool_result","status":"completed","result":"..."}
{"type":"text","text":"最新的版本号是 0.3.4..."}
{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}
```

## 判断快速路径是否生效（看壳日志）

```powershell
$log = Get-ChildItem 'D:\zcode-glm5.3f\_oss_data\.zcode\v2\logs' -Filter '*.log' |
  Sort-Object LastWriteTime -Desc | Select-Object -First 1
Get-Content $log.FullName -Tail 60 | Where-Object { $_ -match 'fast_path|mint requested' } |
  Select-Object -Last 6
```

- **看到 `bridge.fast_path.stream_completed`** → 走的是快速路径（1.2-7.3 秒/步）✅
- **只看到 `bridge.chat.completed`** → 走的是会话链路（8-28 秒/步），即快速路径没生效

## 若快速路径失效（上游收紧白名单）

设环境变量即可回落，**功能不丢**：

```powershell
$env:ZCODE_BRIDGE_NO_PROBE = '1'   # 强制走会话链路
```

## 两个仓库

- https://github.com/MYCF711/dsh-free-glm
- https://gitee.com/MYCF711/dsh-free-glm

插件 tgz 在仓库内 `releases/dsh-zcode-bridge-0.3.4.tgz`。
安装：`dsh plugin --profile web add "file:$PWD/releases/dsh-zcode-bridge-0.3.4.tgz"`
