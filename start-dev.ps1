# InkBloom 本地开发启动脚本
# 用法：
#   .\start-dev.ps1          # 启动 go server (8080) + ai-service (8100)
#   .\start-dev.ps1 -Build   # 先重新编译 go server 再启动
#   .\start-dev.ps1 -Stop    # 停止两个服务
#
# JWT 密钥固化在 packages/server/.env（不入库）：首次运行自动生成 64 位 hex，
# 之后每次重启复用同一密钥，登录态不会因重启失效。
param(
    [switch]$Build,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$ServerDir = Join-Path $Root 'packages\server'
$AiDir = Join-Path $Root 'packages\ai-service'
$LogDir = Join-Path $Root 'logs'
$GoPort = 8080
$AiPort = 8100

function Get-PortPid([int]$Port) {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return $c.OwningProcess }
    return $null
}

if ($Stop) {
    foreach ($port in @($GoPort, $AiPort)) {
        $pid2 = Get-PortPid $port
        if ($pid2) {
            Stop-Process -Id $pid2 -Force
            Write-Host "stopped: port $port (pid $pid2)"
        } else {
            Write-Host "port $port not listening"
        }
    }
    exit 0
}

# ── JWT 密钥：读取/生成 packages/server/.env（固化，重启不失效） ──────────
$EnvFile = Join-Path $ServerDir '.env'
$secret = $null
if (Test-Path $EnvFile) {
    $line = Select-String -Path $EnvFile -Pattern '^INKBLOOM_JWT_SECRET=(.+)$' | Select-Object -First 1
    if ($line) { $secret = $line.Matches[0].Groups[1].Value.Trim() }
}
if (-not $secret) {
    $secret = -join (1..64 | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
    $content = if (Test-Path $EnvFile) { Get-Content $EnvFile -Raw } else { '' }
    $content = "INKBLOOM_JWT_SECRET=$secret`n" + $content
    Set-Content -Path $EnvFile -Value $content -Encoding UTF8
    Write-Host "generated new JWT secret -> $EnvFile"
} else {
    Write-Host "JWT secret loaded from $EnvFile (persisted, login sessions survive restarts)"
}
$env:INKBLOOM_JWT_SECRET = $secret

# ── 端口占用检查 ────────────────────────────────────────────────────────
foreach ($port in @($GoPort, $AiPort)) {
    if (Get-PortPid $port) {
        Write-Error "port $port 已被占用：先运行 .\start-dev.ps1 -Stop 再启动"
        exit 1
    }
}

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

# ── go server（可选先编译） ─────────────────────────────────────────────
$exe = Join-Path $ServerDir 'inkbloom-server.exe'
if ($Build -or -not (Test-Path $exe)) {
    Write-Host 'building go server...'
    Push-Location $ServerDir
    go build -o inkbloom-server.exe ./cmd/server
    if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error 'go build failed'; exit 1 }
    Pop-Location
}
Start-Process -FilePath $exe -WorkingDirectory $ServerDir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir 'go-server.log') `
    -RedirectStandardError (Join-Path $LogDir 'go-server.err.log')
Write-Host 'go server starting (port 8080, logs\go-server.log)'

# ── ai-service（uvicorn；python 取 PATH 中的解释器） ────────────────────
Start-Process -FilePath 'python' `
    -ArgumentList '-m','uvicorn','app.main:app','--host','127.0.0.1','--port',"$AiPort" `
    -WorkingDirectory $AiDir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir 'ai-service.log') `
    -RedirectStandardError (Join-Path $LogDir 'ai-service.err.log')
Write-Host 'ai-service starting (port 8100, logs\ai-service.log)'

# ── 健康检查 ────────────────────────────────────────────────────────────
function Wait-Healthy([string]$Url, [string]$Name) {
    foreach ($i in 1..20) {
        Start-Sleep -Milliseconds 800
        try {
            $r = Invoke-RestMethod -Uri $Url -TimeoutSec 3
            Write-Host "$Name healthy: $($r | ConvertTo-Json -Compress)"
            return $true
        } catch { }
    }
    Write-Warning "$Name health check timed out (see logs\)"
    return $false
}
Wait-Healthy "http://127.0.0.1:$AiPort/health" 'ai-service' | Out-Null
Wait-Healthy "http://127.0.0.1:$GoPort/health" 'go server' | Out-Null
Write-Host "`nInkBloom dev services ready.  go:8080  ai:8100"
