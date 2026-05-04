param(
  [int]$Requests = 10,
  [int]$Concurrency = 2,
  [string]$Model = "claude-gpt-5-3-codex",
  [string]$GatewayUrl = "http://127.0.0.1:4000",
  [string]$OpenAiBaseUrl = "http://127.0.0.1:10531/v1"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Token = "my-secret-gateway-token"

function Add-Result([System.Collections.Generic.List[object]]$Results, [string]$Name, [bool]$Pass, [double]$Ms, [string]$Detail) {
  $Results.Add([pscustomobject]@{
    name = $Name
    pass = $Pass
    ms = [Math]::Round($Ms, 1)
    detail = $Detail
  })
}

function Measure-Step([scriptblock]$Step) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $value = & $Step
  $sw.Stop()
  return @{ value = $value; ms = $sw.Elapsed.TotalMilliseconds }
}

function Invoke-GatewayMessage([string]$Text, [bool]$Stream = $false) {
  $body = @{
    model = $Model
    max_tokens = 128
    stream = $Stream
    messages = @(@{ role = "user"; content = $Text })
  } | ConvertTo-Json -Depth 20

  Invoke-RestMethod -Method Post -Uri "$GatewayUrl/v1/messages" -Headers @{ Authorization = "Bearer $Token" } -ContentType "application/json" -Body $body -TimeoutSec 90
}

Set-Location $ProjectRoot

$results = [System.Collections.Generic.List[object]]::new()

try {
  $step = Measure-Step { Invoke-RestMethod -Uri "$OpenAiBaseUrl/models" -TimeoutSec 20 }
  Add-Result $results "openai-oauth models" $true $step.ms "reachable"
} catch {
  Add-Result $results "openai-oauth models" $false 0 $_.Exception.Message
}

try {
  $step = Measure-Step { Invoke-RestMethod -Uri "$GatewayUrl/v1/models" -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 20 }
  $ids = $step.value.data.id -join ", "
  $expected = @("claude-gpt-5-5", "claude-gpt-5-4", "claude-gpt-5-3-codex")
  $pass = @($step.value.data.id | Where-Object { $_ -in $expected }).Count -eq 3
  Add-Result $results "gateway models" $pass $step.ms $ids
} catch {
  Add-Result $results "gateway models" $false 0 $_.Exception.Message
}

try {
  $body = @{ model = $Model; messages = @(@{ role = "user"; content = "hello" }) } | ConvertTo-Json -Depth 20
  $step = Measure-Step {
    Invoke-RestMethod -Method Post -Uri "$GatewayUrl/v1/messages/count_tokens" -Headers @{ Authorization = "Bearer $Token" } -ContentType "application/json" -Body $body -TimeoutSec 20
  }
  Add-Result $results "count_tokens" ($step.value.input_tokens -ge 1) $step.ms "input_tokens=$($step.value.input_tokens)"
} catch {
  Add-Result $results "count_tokens" $false 0 $_.Exception.Message
}

try {
  $step = Measure-Step { Invoke-GatewayMessage "Reply with exactly: gateway-ok" $false }
  $text = ($step.value.content | Where-Object type -eq "text" | Select-Object -First 1).text
  Add-Result $results "gateway message" ([bool]$text) $step.ms $text
} catch {
  Add-Result $results "gateway message" $false 0 $_.Exception.Message
}

try {
  $body = @{ model = $Model; max_tokens = 128; stream = $true; messages = @(@{ role = "user"; content = "Reply with exactly: stream-ok" }) } | ConvertTo-Json -Depth 20
  $step = Measure-Step {
    $tempBody = [System.IO.Path]::GetTempFileName()
    [System.IO.File]::WriteAllText($tempBody, $body, [System.Text.UTF8Encoding]::new($false))
    try {
      curl.exe -s -N -X POST "$GatewayUrl/v1/messages" -H "Authorization: Bearer $Token" -H "Content-Type: application/json" --data-binary "@$tempBody"
    } finally {
      Remove-Item $tempBody -ErrorAction SilentlyContinue
    }
  }
  $streamText = $step.value -join "`n"
  Add-Result $results "gateway streaming" ($streamText -match "message_stop") $step.ms "sse bytes=$($streamText.Length)"
} catch {
  Add-Result $results "gateway streaming" $false 0 $_.Exception.Message
}

try {
  $step = Measure-Step { claude mcp list }
  Add-Result $results "mcp filesystem" (($step.value -join "`n") -match "filesystem.*Connected") $step.ms (($step.value -join " ") -replace "\s+", " ")
} catch {
  Add-Result $results "mcp filesystem" $false 0 $_.Exception.Message
}

try {
  $env:ANTHROPIC_BASE_URL = $GatewayUrl
  $env:ANTHROPIC_AUTH_TOKEN = $Token
  $env:ANTHROPIC_MODEL = $Model
  Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
  $step = Measure-Step { claude -p "Use the filesystem MCP server to list allowed directories; answer with one short OK sentence." --model $Model --output-format text --permission-mode bypassPermissions }
  Add-Result $results "claude cli + mcp" (($step.value -join "`n") -match "OK|available|directory") $step.ms (($step.value -join " ") -replace "\s+", " ")
} catch {
  Add-Result $results "claude cli + mcp" $false 0 $_.Exception.Message
}

$loadSw = [System.Diagnostics.Stopwatch]::StartNew()
$jobs = @()
for ($i = 1; $i -le $Requests; $i++) {
  while (@($jobs | Where-Object State -eq "Running").Count -ge $Concurrency) {
    Start-Sleep -Milliseconds 100
    $finished = @($jobs | Where-Object { $_.State -ne "Running" -and -not $_.HasMoreData })
    $jobs = @($jobs | Where-Object { $_ -notin $finished })
  }
  $jobs += Start-Job -ArgumentList $GatewayUrl, $Token, $Model -ScriptBlock {
    param($GatewayUrl, $Token, $Model)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
      $body = @{
        model = $Model
        max_tokens = 64
        stream = $false
        messages = @(@{ role = "user"; content = "Reply with one word: ok" })
      } | ConvertTo-Json -Depth 20
      $response = Invoke-RestMethod -Method Post -Uri "$GatewayUrl/v1/messages" -Headers @{ Authorization = "Bearer $Token" } -ContentType "application/json" -Body $body -TimeoutSec 90
      $text = ($response.content | Where-Object type -eq "text" | Select-Object -First 1).text
      $ok = [bool]$text
      $detail = $text
    } catch {
      $ok = $false
      $detail = $_.Exception.Message
    } finally {
      $sw.Stop()
    }
    [pscustomobject]@{ ok = $ok; ms = $sw.Elapsed.TotalMilliseconds; detail = $detail }
  }
}

Wait-Job -Job $jobs | Out-Null
$loadItems = @($jobs | Receive-Job)
$jobs | Remove-Job
$loadSw.Stop()

$successes = @($loadItems | Where-Object ok).Count
$failures = $loadItems.Count - $successes
$latencies = @($loadItems | ForEach-Object ms | Sort-Object)
$avg = if ($latencies.Count) { ($latencies | Measure-Object -Average).Average } else { 0 }
$p95Index = if ($latencies.Count) { [Math]::Min($latencies.Count - 1, [Math]::Ceiling($latencies.Count * 0.95) - 1) } else { 0 }
$p95 = if ($latencies.Count) { $latencies[$p95Index] } else { 0 }
Add-Result $results "load test" ($failures -eq 0) $loadSw.Elapsed.TotalMilliseconds "requests=$Requests concurrency=$Concurrency success=$successes failure=$failures avg_ms=$([Math]::Round($avg,1)) p95_ms=$([Math]::Round($p95,1))"

$summary = [pscustomobject]@{
  timestamp = (Get-Date).ToString("s")
  project = "$ProjectRoot"
  model = $Model
  gateway = $GatewayUrl
  openai_oauth = $OpenAiBaseUrl
  requests = $Requests
  concurrency = $Concurrency
  results = $results
  passed = @($results | Where-Object pass).Count
  failed = @($results | Where-Object { -not $_.pass }).Count
}

$summary | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $ProjectRoot "latest-test-report.json") -Encoding utf8

$results | Format-Table -AutoSize
Write-Host ""
Write-Host "Passed: $($summary.passed), Failed: $($summary.failed)"
Write-Host "Report: $(Join-Path $ProjectRoot 'latest-test-report.json')"

if ($summary.failed -gt 0) {
  exit 1
}
