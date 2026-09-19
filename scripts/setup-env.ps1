<#
.SYNOPSIS
    从 .env.example 生成本地 .env（不进 git），并随机生成会话密钥。

.PARAMETER DatabaseUrl
    可选，覆盖数据库连接串。

.PARAMETER Force
    已存在 .env 时覆盖重建。

.EXAMPLE
    npm run setup:env
    npm run setup:env -Force
#>
[CmdletBinding()]
param(
    [string]$DatabaseUrl,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
$exampleFile = Join-Path $root '.env.example'

if (-not (Test-Path -LiteralPath $exampleFile)) {
    throw "找不到模板 $exampleFile"
}

if ((Test-Path -LiteralPath $envFile) -and -not $Force) {
    Write-Host "[setup] .env 已存在，未改动。重建请执行：npm run setup:env -Force" -ForegroundColor Yellow
    exit 0
}

$content = Get-Content -LiteralPath $exampleFile -Raw -Encoding UTF8

$bytes = New-Object byte[] 48
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$secret = [System.BitConverter]::ToString($bytes).Replace('-', '').ToLower()
$content = [regex]::Replace($content, '(?m)^BAIRUI_SESSION_SECRET=.*$', "BAIRUI_SESSION_SECRET=$secret")

[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$authSecret = [System.BitConverter]::ToString($bytes).Replace('-', '').ToLower()
$content = [regex]::Replace($content, '(?m)^BETTER_AUTH_SECRET=.*$', "BETTER_AUTH_SECRET=$authSecret")

if ($DatabaseUrl) {
    $content = [regex]::Replace($content, '(?m)^DATABASE_URL=.*$', [System.Text.RegularExpressions.MatchEvaluator]{ param($match) "DATABASE_URL=$DatabaseUrl" })
}

Set-Content -LiteralPath $envFile -Value $content -NoNewline -Encoding utf8

Write-Host "[setup] 已生成 .env：$(Split-Path -Leaf $envFile)" -ForegroundColor Green
Write-Host '[setup] 会话与认证密钥已独立随机生成；.env 已被 .gitignore 忽略，不要提交。' -ForegroundColor DarkGray
Write-Host '[setup] 接下来执行：npm run dev' -ForegroundColor Cyan
