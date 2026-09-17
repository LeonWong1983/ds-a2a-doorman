# A2A inbound probe: sends one authenticated SendMessage to a dsh-a2a server
# and prints the resulting task/status JSON.
#
# Usage:
#   pwsh -File scripts/probe-a2a.ps1 -Key <bearer-token> [-Text 'hi'] [-Path /agents/standard/] [-BaseUrl http://127.0.0.1:8899]
#
# The bearer token can also come from the A2A_TOKEN environment variable.
param(
  [string]$Path = '/agents/standard/',
  [string]$Text = 'A2A doorman smoke probe. Reply with exactly: probe-ok',
  [string]$ContextId = ('doorman-' + (Get-Date -Format 'HHmmss')),
  [string]$Key = $env:A2A_TOKEN,
  [string]$BaseUrl = 'http://127.0.0.1:8899',
  [int]$TimeoutSec = 320
)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Key)) {
  Write-Error 'No bearer token. Pass -Key <token> or set the A2A_TOKEN environment variable.'
  exit 2
}
$uri = "$BaseUrl$Path"
# Nested params.message is the shape the dsh-a2a server validates; a flat
# params:{messageId,parts} payload is rejected with JSON-RPC -32602.
$body = @{
  jsonrpc = '2.0'; id = 1; method = 'SendMessage'
  params  = @{ message = @{ role = 'user'; messageId = 'm1'; parts = @(@{ kind = 'text'; text = $Text }); contextId = $ContextId } }
} | ConvertTo-Json -Depth 8
Write-Host "POST $uri  ctx=$ContextId"
try {
  # SendMessage is a synchronous long-poll: it returns when the target session
  # has answered (up to the relay deadline), so keep the client timeout high.
  $r = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method POST -Headers @{ Authorization = "Bearer $Key" } -ContentType 'application/json' -Body $body -TimeoutSec $TimeoutSec
  Write-Host "HTTP $($r.StatusCode)"
  Write-Output $r.Content
} catch {
  $resp = $_.Exception.Response
  if ($resp) { Write-Host "HTTP $([int]$resp.StatusCode)"; Write-Output $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult() }
  else { Write-Error $_.Exception.Message }
}
