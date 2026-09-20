<#
.SYNOPSIS
    启动本地平台。默认只启动 API 和控制台；legacy 模式额外启动旧 Agent 服务。
.PARAMETER Target
    all（默认）| api（后端）| web（前端）
#>
[CmdletBinding()]
param([ValidateSet('all', 'api', 'web')][string]$Target = 'all')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$children = New-Object System.Collections.Generic.List[System.Diagnostics.Process]

function Write-Step {
    param([string]$Message, [string]$Color = 'Cyan')
    Write-Host "[dev] $Message" -ForegroundColor $Color
}

function Import-DotEnv {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    Get-Content -LiteralPath $Path -Encoding UTF8 | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { return }
        $separator = $line.IndexOf('=')
        if ($separator -lt 1) { return }
        $key = $line.Substring(0, $separator).Trim()
        $value = $line.Substring($separator + 1).Trim()
        if ($value.Length -ge 2) {
            $first = $value[0]
            $last = $value[-1]
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        [Environment]::SetEnvironmentVariable($key, $value, 'Process')
    }
    return $true
}

function New-SessionSecret {
    $bytes = New-Object byte[] 48
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [System.BitConverter]::ToString($bytes).Replace('-', '').ToLower()
}

function Initialize-LocalEnv {
    param([string]$EnvFile, [string]$ExampleFile)
    if (Test-Path -LiteralPath $EnvFile) {
        Import-DotEnv -Path $EnvFile | Out-Null
        Write-Step '已加载 .env' 'DarkGray'
        return
    }
    if (-not (Test-Path -LiteralPath $ExampleFile)) { throw '缺少 .env 与 .env.example' }
    $content = Get-Content -LiteralPath $ExampleFile -Raw -Encoding UTF8
    $secret = New-SessionSecret
    $authSecret = New-SessionSecret
    $content = [regex]::Replace($content, '(?m)^BAIRUI_SESSION_SECRET=.*$', "BAIRUI_SESSION_SECRET=$secret")
    $content = [regex]::Replace($content, '(?m)^BETTER_AUTH_SECRET=.*$', "BETTER_AUTH_SECRET=$authSecret")
    Set-Content -LiteralPath $EnvFile -Value $content -NoNewline -Encoding utf8
    Import-DotEnv -Path $EnvFile | Out-Null
    Write-Step '已生成 .env 和独立随机密钥；请检查数据库连接配置' 'Yellow'
}

function Install-DepsIfMissing {
    param([string]$Directory, [string]$Name)
    if (Test-Path -LiteralPath (Join-Path $Directory 'node_modules')) { return }
    Write-Step "$Name 缺少依赖，正在安装 npm install ..." 'Yellow'
    & npm install --prefix $Directory
    if ($LASTEXITCODE -ne 0) { throw "$Name 依赖安装失败" }
}

function Start-NodeService {
    param([string]$Name, [string]$WorkDir, [string[]]$Arguments, [string]$Port)
    [Environment]::SetEnvironmentVariable('PORT', $Port, 'Process')
    Write-Step "启动 $Name"
    $process = Start-Process -FilePath 'node' -ArgumentList $Arguments         -WorkingDirectory $WorkDir -PassThru -WindowStyle Hidden
    [void]$children.Add($process)
}

function Assert-ServicePortsAvailable {
    param([object[]]$Services)
    $listeners = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.State -eq 'Listen' })
    $conflicts = @(foreach ($candidate in $Services) {
        if (-not $candidate.listenPort) { continue }
        foreach ($listener in $listeners) {
            if ($listener.LocalPort -eq [int]$candidate.listenPort) {
                '{0}: 端口 {1}，PID {2}' -f $candidate.name, $candidate.listenPort, $listener.OwningProcess
            }
        }
    })
    if ($conflicts.Count) {
        throw ('端口已被占用，尚未启动新服务：' + ($conflicts -join '；') + '。请在原开发终端按 Ctrl+C 停止旧服务后重试；脚本不会自动结束占用进程。')
    }
}

Set-Location -LiteralPath $root
Initialize-LocalEnv -EnvFile (Join-Path $root '.env') -ExampleFile (Join-Path $root '.env.example')
$serviceJson = & node (Join-Path $PSScriptRoot 'dev-services.mjs') $Target
if ($LASTEXITCODE -ne 0) { throw '启动配置检查失败，请检查平台模式、认证和数据库配置' }
# PowerShell 5.1 返回整个 JSON 数组，不能再用 @() 包成嵌套数组。
$services = $serviceJson | ConvertFrom-Json
Write-Step ("本次启动：" + (($services | ForEach-Object { $_.name }) -join ', '))
Assert-ServicePortsAvailable -Services $services

try {
    foreach ($service in $services) {
        $directory = Join-Path $root $service.directory
        Install-DepsIfMissing -Directory $directory -Name $service.name
        Start-NodeService -Name $service.name -WorkDir $directory -Arguments @($service.entry) -Port $service.port
    }
    if ($Target -in @('all', 'api')) {
        $apiPort = if ($env:PLATFORM_API_PORT) { $env:PLATFORM_API_PORT } else { '8080' }
        $health = $null
        for ($attempt = 0; $attempt -lt 10; $attempt++) {
            Start-Sleep -Seconds 2
            if ($children | Where-Object { $_.HasExited }) { throw '服务启动时退出，请检查后端配置' }
            try {
                $health = Invoke-RestMethod -Uri "http://127.0.0.1:$apiPort/healthz" -TimeoutSec 5
                break
            } catch {
                if ($attempt -eq 9) { throw '健康检查未通过，服务启动失败' }
            }
        }
        Write-Step ("数据库状态：" + $health.database) 'Green'
    }
    if ($Target -ne 'api') { Write-Step '访问 http://127.0.0.1:5173' 'Green' }
    Write-Step '服务已就绪，按 Ctrl+C 停止全部服务。' 'Green'
    while (@($children | Where-Object { -not $_.HasExited }).Count -eq $children.Count) { Start-Sleep -Seconds 1 }
    Write-Step '服务退出，正在停止其余服务' 'Yellow'
} finally {
    foreach ($process in $children) {
        if ($process.HasExited) { continue }
        & taskkill /PID $process.Id /T /F 2>$null | Out-Null
    }
    Write-Step '已停止全部服务' 'DarkGray'
}
