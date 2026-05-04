param(
  [switch]$NoClaude,
  [switch]$Restart,
  [int]$OpenAiOauthPort = 10531,
  [int]$GatewayPort = 4000,
  [string]$Model = "claude-gpt-5-3-codex"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$OpenAiBaseUrl = "http://127.0.0.1:$OpenAiOauthPort/v1"
$GatewayUrl = "http://127.0.0.1:$GatewayPort"

function Get-ListenerPid([int]$Port) {
  $connection = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($connection) { return $connection.OwningProcess }
  return $null
}

function Stop-Listener([int]$Port) {
  $pid = Get-ListenerPid $Port
  if ($pid) {
    Stop-Process -Id $pid -Force
    Start-Sleep -Milliseconds 500
  }
}

function Wait-Http([string]$Url, [int]$Seconds = 30) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    try {
      Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 | Out-Null
      return
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $deadline)
  throw "Timed out waiting for $Url"
}

function Wait-Port([int]$Port, [int]$Seconds = 30) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    if (Get-ListenerPid $Port) { return }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw "Timed out waiting for 127.0.0.1:$Port"
}

Set-Location $ProjectRoot

if ($Restart) {
  Stop-Listener $GatewayPort
  Stop-Listener $OpenAiOauthPort
}

if (-not (Get-ListenerPid $OpenAiOauthPort)) {
  Start-Process -FilePath "npx.cmd" -ArgumentList "openai-oauth" -WorkingDirectory $ProjectRoot -WindowStyle Hidden
}
Wait-Http "$OpenAiBaseUrl/models"

if (-not (Get-ListenerPid $GatewayPort)) {
  Start-Process -FilePath "node" -ArgumentList "src/server.js" -WorkingDirectory $ProjectRoot -WindowStyle Hidden
}
Wait-Port $GatewayPort

$env:ANTHROPIC_BASE_URL = $GatewayUrl
$env:ANTHROPIC_AUTH_TOKEN = "my-secret-gateway-token"
$env:ANTHROPIC_MODEL = $Model
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

$models = Invoke-RestMethod -Uri "$GatewayUrl/v1/models" -Headers @{ Authorization = "Bearer $env:ANTHROPIC_AUTH_TOKEN" }

Write-Host "Project: $ProjectRoot"
Write-Host "openai-oauth: $OpenAiBaseUrl"
Write-Host "gateway: $GatewayUrl"
Write-Host "model: $Model"
Write-Host "models: $($models.data.id -join ', ')"
Write-Host ""

if (-not $NoClaude) {
  claude --model $Model
}
