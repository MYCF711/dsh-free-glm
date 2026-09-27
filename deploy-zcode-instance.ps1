# 一键部署 ZCode 开源版实例（含 HTTP 桥）
#
# 用途：把「ZCode 开源版源码 + 桥补丁」部署到本机，让 dsh-free-glm 插件能工作。
#
# 做的事：
#   1. 从上游 clone ZCode 开源版（走镜像回退，国内网络可用）
#   2. apply 本仓库的桥补丁（新增 zcodeBridgeServer.ts + 三处改动）
#   3. pnpm install（约 2.8GB，耗时较长）
#   4. 构建 desktop 包
#
# 用法：
#   pwsh -File deploy-zcode-instance.ps1                    # 默认装到 D:\DSH-WEB\ZCode-official
#   pwsh -File deploy-zcode-instance.ps1 -Target E:\ZCode   # 自定义位置
#   pwsh -File deploy-zcode-instance.ps1 -SkipInstall       # 已有 node_modules 时跳过装依赖
#
# 前置要求：git、Node.js 22+、pnpm（脚本会自动尝试用 corepack 启用）

[CmdletBinding()]
param(
    [string]$Target = 'D:\DSH-WEB\ZCode-official',
    [string]$Upstream = 'https://github.com/zai-org/ZCode.git',
    [switch]$SkipInstall,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$patchDir = Join-Path $here 'patches'

function Write-Step([string]$text) {
    Write-Host ''
    Write-Host "=== $text ===" -ForegroundColor Cyan
}
function Write-Ok([string]$text)   { Write-Host "  ✓ $text" -ForegroundColor Green }
function Write-Warn2([string]$text) { Write-Host "  ! $text" -ForegroundColor Yellow }

# ── 镜像回退：国内直连 GitHub 常失败，先直连再走加速代理 ──────────────
function Invoke-GitWithMirror {
    param([string[]]$Args)
    $direct = $Args
    Write-Host "  git $($direct -join ' ')"
    & git @direct
    if ($LASTEXITCODE -eq 0) { return $true }

    $mirrored = @()
    for ($i = 0; $i -lt $Args.Count; $i++) {
        $a = $Args[$i]
        if ($a -like 'https://github.com/*') {
            $mirrored += "https://gh-proxy.com/$a"
        } else {
            $mirrored += $a
        }
    }
    Write-Warn2 "直连失败，改用镜像重试"
    Write-Host "  git $($mirrored -join ' ')"
    & git @mirrored
    return ($LASTEXITCODE -eq 0)
}

Write-Step "检查前置工具"
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) { throw 'git 未安装。请先安装 Git for Windows。' }
Write-Ok "git: $($git.Source)"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 未安装。请先安装 Node.js 22 或更高版本。' }
$nodeVersion = (& node --version).Trim()
Write-Ok "node: $nodeVersion"

# pnpm：优先用现成的，否则用 corepack 启用
$pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpmCmd) {
    Write-Warn2 'pnpm 未找到，尝试用 corepack 启用…'
    & corepack enable 2>&1 | Out-Null
    & corepack prepare pnpm@latest --activate 2>&1 | Out-Null
    $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $pnpmCmd) {
        throw 'pnpm 不可用。请手动安装：npm install -g pnpm'
    }
}
Write-Ok "pnpm: $($pnpmCmd.Source)"

# ── 1. 获取源码 ───────────────────────────────────────────────────────
Write-Step "获取 ZCode 开源版源码 → $Target"
if (Test-Path (Join-Path $Target '.git')) {
    Write-Ok "目标已是 git 仓库，跳过 clone（如需重装请先手动删除该目录）"
    Push-Location $Target
    try {
        & git fetch --depth 1 origin main 2>&1 | Out-Null
    } finally {
        Pop-Location
    }
} else {
    if (Test-Path $Target) {
        throw "目标目录已存在但不是 git 仓库：$Target`n请先删除它，或换 -Target。"
    }
    $parent = Split-Path $Target -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $ok = Invoke-GitWithMirror @('clone', '--depth', '1', $Upstream, $Target)
    if (-not $ok) { throw "clone 失败。请检查网络，或手动 clone 到 $Target 后重跑本脚本。" }
    Write-Ok "clone 完成"
}

# ── 2. apply 桥补丁 ───────────────────────────────────────────────────
Write-Step "应用桥补丁"
Push-Location $Target
try {
    # 2a. 新增文件：整份拷贝（上游没有这个文件，不涉及冲突）
    $bridgeSrc = Join-Path $patchDir 'zcodeBridgeServer.ts'
    $bridgeDst = Join-Path $Target 'packages\desktop\src\host\zcodeBridgeServer.ts'
    if (-not (Test-Path $bridgeSrc)) { throw "补丁文件缺失：$bridgeSrc" }
    Copy-Item $bridgeSrc $bridgeDst -Force
    Write-Ok "已放入 zcodeBridgeServer.ts"

    # 2b. 已跟踪文件的改动：用 git apply
    #
    # --3way 让 git 在上下文轻微漂移时仍能应用（上游更新后常见）。
    # 失败时不静默 —— 必须让用户知道补丁没打上，否则插件会神秘地不工作。
    $patchFile = Join-Path $patchDir 'shell-modifications.patch'
    & git apply --3way --whitespace=nowarn $patchFile 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) {
        Write-Warn2 "git apply --3way 失败，尝试 --reject 逐块应用…"
        & git apply --reject --whitespace=nowarn $patchFile 2>&1 | ForEach-Object { Write-Host "  $_" }
        Write-Warn2 '有 .rej 文件产生 = 部分改动没打上。请检查并手动合并。'
    } else {
        Write-Ok '三处已跟踪文件的改动已应用'
    }
} finally {
    Pop-Location
}

# ── 3. 装依赖 ─────────────────────────────────────────────────────────
if ($SkipInstall) {
    Write-Step '跳过安装依赖（-SkipInstall）'
} else {
    Write-Step '安装依赖（约 2.8GB，请耐心等待）'
    Push-Location $Target
    try {
        & $pnpmCmd.Source install
        if ($LASTEXITCODE -ne 0) { throw 'pnpm install 失败' }
        Write-Ok '依赖安装完成'
    } finally {
        Pop-Location
    }
}

# ── 4. 构建 ───────────────────────────────────────────────────────────
if ($SkipBuild) {
    Write-Step '跳过构建（-SkipBuild）'
} else {
    Write-Step '构建 services（项目引用）'
    Push-Location $Target
    try {
        & $pnpmCmd.Source exec tsc -b packages/services/tsconfig.json
        if ($LASTEXITCODE -ne 0) { throw 'services 构建失败' }
        Write-Ok 'services 构建完成'

        Write-Step '构建 desktop'
        Push-Location (Join-Path $Target 'packages\desktop')
        try {
            & $pnpmCmd.Source run build:no-runtime-assets
            if ($LASTEXITCODE -ne 0) { throw 'desktop 构建失败' }
            Write-Ok 'desktop 构建完成'
        } finally {
            Pop-Location
        }
    } finally {
        Pop-Location
    }
}

Write-Step '完成'
Write-Host @"

ZCode 开源版已部署到：
  $Target

下一步：
  1. 确认「壳」能被插件找到。插件按下列候选自动探测：
       <各盘符>\DSH-WEB\ZCode-official
       <各盘符>\ZCode-official
       <各盘符>\code\ZCode-official
     若你的安装位置不在其中，设置环境变量指定：
       [Environment]::SetEnvironmentVariable('ZCODE_BRIDGE_APP_DIR',
         '$Target\packages\desktop', 'User')
       [Environment]::SetEnvironmentVariable('ZCODE_BRIDGE_ELECTRON_PATH',
         '$Target\node_modules\electron\dist\electron.exe', 'User')
  2. 重启 DSH —— 插件会自动拉起壳（无头静默），桥就绪后模型设置页出现 provider。
  3. 首次启动壳需要几秒；期间模型分组可能暂时为空，属正常。

"@ -ForegroundColor Gray
