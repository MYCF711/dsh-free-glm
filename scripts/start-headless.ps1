param(
  [switch]$Stop,
  [switch]$WithTray,
  # 不把 ZCODE_BRIDGE_AUTOSTART 写回 1。
  #
  # ## 为什么需要这个开关（2026-09-27 实测踩过）
  #
  # 插件有「DSH 启动时拉起壳」+「后台保活」两条自动路径。本脚本若同时把
  # `ZCODE_BRIDGE_AUTOSTART` 置 1，**两个启动源就会争抢**：
  #
  #   脚本清场 → 启动实例 A（14:06:03）
  #   插件保活也在这一秒启动实例 B（14:06:04）
  #   → ZCode 有单实例锁，B 抢不到 → **B 静默退出**（日志只有 3 行）
  #   → 而 A 可能因为环境变量不全而不起桥
  #   → 结果：看起来「壳起不来」，其实是两者互斥
  #
  # 排查启动问题时用 `-NoAutostart`，让**只有一个启动源**，才能干净定位。
  [switch]$NoAutostart,
  # 允许指定不同的数据目录 —— 用于「复制新实例做隔离测试」（2026-09-27 新增）。
  #
  # ## 为什么需要
  #
  # ZCode 有单实例锁：同一个数据目录只能跑一个壳。要给新实例做 A/B，
  # 必须换一个数据目录（用 robocopy /E 复制源目录即可），否则新实例
  # 会被锁挡下、25 秒内静默退出。
  #
  # 用法：
  #   robocopy D:\zcode-glm5.3f\_oss_data D:\zcode-glm5.3f\_test_data /E
  #   Remove-Item D:\zcode-glm5.3f\_test_data\.zcode\v2\bridge-port.json
  #   pwsh -File start-headless.ps1 -DataDir D:\zcode-glm5.3f\_test_data -NoAutostart
  #
  # ⚠ 换 DataDir 会连带换掉壳的凭据/设备身份（telemetry-state.json 在
  #   `.zcode\v2\` 下），所以**必须从源目录完整复制**，不要新建空目录。
  [string]$DataDir
)

$ErrorActionPreference = 'Stop'

$Electron = 'D:\DSH-WEB\ZCode-official\node_modules\electron\dist\electron.exe'
$AppDir   = 'D:\DSH-WEB\ZCode-official\packages\desktop'
if (-not $DataDir) { $DataDir = 'D:\zcode-glm5.3f\_oss_data' }
$LogOut   = 'D:\zcode-glm5.3f\_oss_headless.log'
$LogErr   = 'D:\zcode-glm5.3f\_oss_headless.err'
$PortFile = Join-Path $DataDir '.zcode\v2\bridge-port.json'

if ($Stop) {
  Write-Host '停止开源版实例…'
  Get-Process electron -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $Electron } |
    ForEach-Object { Write-Host "  kill pid=$($_.Id)"; Stop-Process -Id $_.Id -Force }
  Start-Sleep -Seconds 2
  Write-Host "剩余 electron: $((Get-Process electron -ErrorAction SilentlyContinue | Measure-Object).Count)"
  exit 0
}

# 先停旧的，避免端口/单实例冲突
Get-Process electron -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $Electron } | Stop-Process -Force
Start-Sleep -Seconds 2

$env:ZCODE_DATA_BASE_DIR      = $DataDir
$env:ZCODE_ENV                = 'production'
$env:ZCODE_BRIDGE             = '1'
$env:ZCODE_BRIDGE_TIMEOUT_MS  = '180000'
$env:ZCODE_QUIET              = '1'
if (-not $WithTray) { $env:ZCODE_HEADLESS = '1' } else { Remove-Item Env:\ZCODE_HEADLESS -ErrorAction SilentlyContinue }
# 桥不注入 MCP（已实测：直连 MCP 能握手但不进工具面，且会让 turn 挂死）。
Remove-Item Env:\ZCODE_BRIDGE_MCP -ErrorAction SilentlyContinue

# ── DSH 插件的保活/自启配置 ────────────────────────────────────────────
# 插件读这几个变量来决定「壳挂了要不要拉回来」「DSH 起来时壳不在要不要自启」。
# 写进用户环境变量，这样 DSH 进程（无论谁启动的）都能看到。
#
# ⚠ ZCODE_DATA_BASE_DIR 必须一并写进用户环境变量，这不是可选项：
#   - 壳（ZCode 实例）按这个变量决定**写**发现文件的位置；
#   - DSH 里的插件按同一个变量决定**读**发现文件的位置。
#   只在脚本进程内设 $env:（旧做法）时，DSH 进程读不到它 → 插件退回
#   homedir()（C:\Users\Administrator\.zcode）→ 与壳写的路径对不上 → 
#   插件永远认为"桥不可用" → provider 分组被隐藏 → 用户看不到 zcode-bridge。
[Environment]::SetEnvironmentVariable('ZCODE_BRIDGE_ELECTRON_PATH', $Electron, 'User')
[Environment]::SetEnvironmentVariable('ZCODE_BRIDGE_APP_DIR', $AppDir, 'User')
[Environment]::SetEnvironmentVariable('ZCODE_DATA_BASE_DIR', $DataDir, 'User')
$env:ZCODE_BRIDGE_ELECTRON_PATH = $Electron
$env:ZCODE_BRIDGE_APP_DIR       = $AppDir
$env:ZCODE_DATA_BASE_DIR        = $DataDir
if ($NoAutostart) {
  # 让插件不要自动拉起壳 —— 排查启动问题时保证「只有一个启动源」。
  [Environment]::SetEnvironmentVariable('ZCODE_BRIDGE_AUTOSTART', '0', 'User')
  $env:ZCODE_BRIDGE_AUTOSTART = '0'
  Write-Host '  ZCODE_BRIDGE_AUTOSTART     = 0（-NoAutostart：插件不会自动拉起壳）'
} else {
  [Environment]::SetEnvironmentVariable('ZCODE_BRIDGE_AUTOSTART', '1', 'User')
  $env:ZCODE_BRIDGE_AUTOSTART = '1'
  Write-Host '  ZCODE_BRIDGE_AUTOSTART     = 1'
}
Write-Host '已写入保活配置（用户环境变量）：'
Write-Host "  ZCODE_BRIDGE_ELECTRON_PATH = $Electron"
Write-Host "  ZCODE_BRIDGE_APP_DIR       = $AppDir"
Write-Host "  ZCODE_DATA_BASE_DIR        = $DataDir"
Write-Host '  ZCODE_BRIDGE_AUTOSTART     = 1'

# ⚠ 这里**不要**删发现文件。
#   旧版本写作 Remove-Item $PortFile，理由是"避免就绪判定读到上一次的端口"。
#   但脚本启动前已经把所有 electron 杀干净了（见上面），端口天然是新的；
#   而删文件会制造一个危险窗口：若随后实例启动失败，文件就再也回不来，
#   插件将永久认为桥不可用。就绪判定应靠比对 instanceId/port，不靠删文件。

Start-Process -FilePath $Electron `
  -ArgumentList '.' `
  -WorkingDirectory $AppDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput $LogOut `
  -RedirectStandardError  $LogErr

Write-Host '启动中，等待桥就绪…'
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  if (Test-Path $PortFile) {
    try {
      $raw = Get-Content $PortFile -Raw
      $b = $raw | ConvertFrom-Json
      if ($b.port) {
        # 裸 TcpClient 探测端口：Test-NetConnection 每次要 3-8 秒，会把启动拖成分钟级。
        $ok = $false
        try {
          $client = New-Object System.Net.Sockets.TcpClient
          $async = $client.BeginConnect('127.0.0.1', $b.port, $null, $null)
          if ($async.AsyncWaitHandle.WaitOne(1500)) { $ok = $client.Connected }
          $client.Close()
        } catch { }
        if ($ok) {
          Write-Host ''
          Write-Host '✓ 桥已就绪'
          Write-Host "  port  = $($b.port)"
          Write-Host "  token = $($b.token)"
          Write-Host "  models= $($b.models -join ', ')"
          Write-Host "  provider = $($b.defaultProviderId)"
          Write-Host ''
          Write-Host "  调用: POST http://127.0.0.1:$($b.port)/v1/chat/completions"
          Write-Host "  Authorization: Bearer $($b.token)"
          Write-Host ''
          if (-not $WithTray) {
            $vis = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle }
            if ($vis) { Write-Host "  ⚠ 仍有可见窗口: $($vis.MainWindowTitle -join ', ')" }
            else { Write-Host '  ✓ 无可见窗口（不进桌面/任务栏/Alt-Tab）' }
          }
          Write-Host "  停止: pwsh -File $PSCommandPath -Stop"
          exit 0
        }
      }
    } catch { }
  }
}

