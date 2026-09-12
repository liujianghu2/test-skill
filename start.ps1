# Skill Lab 一键启动（Windows PowerShell）
#
# 作用：不需要预装 Node.js —— 本脚本会在项目内自动下载一份便携版 Node 运行时，
#       然后启动 Skill Lab 并打开浏览器。
#
# 用法：右键「使用 PowerShell 运行」，或在 PowerShell 里执行：
#       powershell -ExecutionPolicy Bypass -File .\start.ps1
#
# 可选参数：
#   -Port 5178      指定端口
#   -NoOpen         不自动打开浏览器
#   -Open           自动打开浏览器（双击 .bat 时传入）
#   -Rebuild        忽略已下载的运行时，重新下载

param(
    [int]$Port = 5177,
    [switch]$NoOpen,
    [switch]$Rebuild,
    [switch]$Open
)

# 中文输出需要 UTF-8 控制台，否则在 GBK 代码页下会乱码
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch { /* 忽略 */ }

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeDir = Join-Path $root '.runtime'
$nodeDir = Join-Path $runtimeDir 'node'
$nodeExe = Join-Path $nodeDir 'node.exe'
# -Open（.bat 双击时传入）与「默认打开浏览器」等价
if ($Open) { $NoOpen = $false }

function Write-Step($msg) { Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "  Skill Lab 启动器" -ForegroundColor White
Write-Host "  ────────────────────────────────────────────"

function Get-UsableNode {
    # 1) 项目内自带的便携运行时
    if (Test-Path $nodeExe) { return $nodeExe }
    # 2) 系统已安装的 Node（要求 >= 18.17，因为用到了内置 fetch）
    $sys = Get-Command node -ErrorAction SilentlyContinue
    if ($sys) {
        try {
            $ver = (& node -v) -replace '^v', ''
            $major = [int]($ver.Split('.')[0])
            $minor = [int]($ver.Split('.')[1])
            if ($major -gt 18 -or ($major -eq 18 -and $minor -ge 17)) { return $sys.Source }
            Write-Warn2 "系统 Node 版本过低（v$ver），将下载便携运行时"
        } catch { Write-Warn2 "无法识别系统 Node，将下载便携运行时" }
    }
    return $null
}

function Install-PortableNode {
    Write-Step "未找到可用的 Node.js，正在下载便携版运行时（约 30MB，仅首次）…"
    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

    # 选择架构
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $indexUrl = 'https://nodejs.org/dist/index.json'

    Write-Step "查询最新 LTS 版本…"
    $index = Invoke-RestMethod -Uri $indexUrl -TimeoutSec 60
    $lts = $index | Where-Object { $_.lts -ne $false } | Select-Object -First 1
    if (-not $lts) { throw '无法获取 Node.js 版本列表，请检查网络。' }
    $ver = $lts.version
    Write-Step "目标版本：$ver ($arch)"

    $zipName = "node-$ver-win-$arch.zip"
    $url = "https://nodejs.org/dist/$ver/$zipName"
    $zipPath = Join-Path $runtimeDir $zipName

    if (-not (Test-Path $zipPath)) {
        Write-Step "下载 $url"
        # 大文件下载：优先用 curl.exe（Windows 10+ 自带），失败退回 Invoke-WebRequest
        $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
        if ($curl) {
            & $curl.Source -L --fail --silent --show-error -o $zipPath $url
            if ($LASTEXITCODE -ne 0) { throw "下载失败（curl 退出码 $LASTEXITCODE）" }
        } else {
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $url -OutFile $zipPath -TimeoutSec 600
        }
    } else {
        Write-Step "已存在安装包，跳过下载"
    }

    Write-Step "解压…"
    $extractDir = Join-Path $runtimeDir 'extract'
    if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

    $inner = Get-ChildItem -Path $extractDir -Directory | Select-Object -First 1
    if (-not $inner) { throw '解压后没有找到 Node 目录。' }
    if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
    Move-Item -Path $inner.FullName -Destination $nodeDir
    Remove-Item -Recurse -Force $extractDir -ErrorAction SilentlyContinue
    Remove-Item -Force $zipPath -ErrorAction SilentlyContinue

    if (-not (Test-Path $nodeExe)) { throw '便携运行时就绪但找不到 node.exe。' }
    Write-Ok "便携运行时已安装：$nodeExe"
}

try {
    if ($Rebuild -and (Test-Path $runtimeDir)) {
        Write-Step "按 -Rebuild 清理旧运行时…"
        Remove-Item -Recurse -Force $runtimeDir -ErrorAction SilentlyContinue
    }

    $node = Get-UsableNode
    if (-not $node) {
        Install-PortableNode
        $node = $nodeExe
    } else {
        $where = if ($node -eq $nodeExe) { '项目内置运行时' } else { '系统 Node' }
        Write-Ok "使用 $where：$node（$(& $node -v)）"
    }

    $entry = Join-Path $root 'bin\skill-lab.mjs'
    if (-not (Test-Path $entry)) { throw "找不到入口文件：$entry" }

    $dataDir = Join-Path $root 'data'
    Write-Host "  ────────────────────────────────────────────"
    Write-Host "  界面地址   http://127.0.0.1:$Port"
    Write-Host "  数据目录   $dataDir"
    Write-Host "  关闭窗口即停止服务" -ForegroundColor DarkGray
    Write-Host "  ────────────────────────────────────────────"
    Write-Host ""

    $nodeArgs = @($entry, '--port', "$Port")
    if (-not $NoOpen) { $nodeArgs += '--open' }
    & $node @nodeArgs
} catch {
    Write-Host ""
    Write-Err "启动失败：$($_.Exception.Message)"
    Write-Host ""
    Write-Host "  排查建议：" -ForegroundColor Yellow
    Write-Host "   1) 确认能访问 https://nodejs.org （公司网络/代理可能拦截）"
    Write-Host "   2) 手动安装 Node.js 18.17+ 后重试：https://nodejs.org/"
    Write-Host "   3) 若已手动安装，确认在 PATH 中：node -v"
    Write-Host ""
    if (-not $NoOpen) { Read-Host "按回车退出" }
    exit 1
}
