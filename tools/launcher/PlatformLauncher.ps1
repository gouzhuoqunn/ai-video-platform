param([ValidateSet("gui","start","stop","open","restart","status")][string]$Action = "gui")

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$StateRoot = Join-Path $ProjectRoot ".secrets\launcher"
$StatePath = Join-Path $StateRoot "state.json"
$LogPath = Join-Path $StateRoot "platform.log"
$Url = "http://127.0.0.1:3000"

function Ensure-StateRoot { New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null }
function Write-Log([string]$Message) {
  Ensure-StateRoot
  Add-Content -Path $LogPath -Value ("[{0}] {1}" -f (Get-Date -Format s), $Message)
  if ((Get-Item $LogPath).Length -gt 2MB) { Move-Item -Force $LogPath "$LogPath.1"; New-Item -ItemType File -Force $LogPath | Out-Null }
}
function Read-State { if (Test-Path $StatePath) { try { return Get-Content -Raw $StatePath | ConvertFrom-Json } catch { return $null } }; return $null }
function Save-State($State) { Ensure-StateRoot; $State | ConvertTo-Json | Set-Content -Encoding utf8 $StatePath }
function Node-Status {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  return [pscustomobject]@{ Node = [bool]$node; Npm = [bool]$npm }
}
function Find-ProjectServer {
  $state = Read-State
  if ($state -and $state.pid) {
    $proc = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
    if ($proc) { return $proc }
  }
  return $null
}
function Wait-Ready([int]$TimeoutSeconds = 90) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try { $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3; if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return $true } } catch { }
    Start-Sleep -Milliseconds 800
  }
  return $false
}
function Test-LocalServer {
  try { $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2; return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500 } catch { return $false }
}
function Open-LocalPage { try { Start-Process $Url | Out-Null } catch { Write-Log "browser open skipped: $($_.Exception.Message)" } }
function Start-Platform {
  $status = Node-Status
  if (-not $status.Node -or -not $status.Npm) { Write-Log "Node/npm unavailable"; return "Node/npm unavailable" }
  $existing = Find-ProjectServer
  if ($existing) { Open-LocalPage; return "Platform already running (PID $($existing.Id))" }
  if (Test-LocalServer) { Open-LocalPage; return "Existing local server detected; no duplicate started" }
  Ensure-StateRoot
  if (-not (Test-Path (Join-Path $ProjectRoot ".secrets\local-lab.env"))) {
    Write-Log "local-lab.env missing; running local setup only"
    & npm.cmd run local-lab:setup *>> $LogPath
    if ($LASTEXITCODE -ne 0) { return "Local setup failed; see .secrets/launcher/platform.log" }
  }
  $process = Start-Process -FilePath "npm.cmd" -ArgumentList "run","dev:local" -WorkingDirectory $ProjectRoot -RedirectStandardOutput $LogPath -RedirectStandardError ("$LogPath.err") -PassThru -WindowStyle Hidden
  $runnerLog = Join-Path $StateRoot "gpu-session-runner.log"
  $runner = Start-Process -FilePath "npm.cmd" -ArgumentList "run","gpu:session-runner:start" -WorkingDirectory $ProjectRoot -RedirectStandardOutput $runnerLog -RedirectStandardError ("$runnerLog.err") -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 500
  $ownedPids = @([int]$process.Id, [int]$runner.Id) + @((Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($ProjectRoot) -and ($_.CommandLine -match "next.*dev|dev:local|gpu-session-runner") } | ForEach-Object { [int]$_.ProcessId }))
  Save-State ([pscustomobject]@{ pid = $process.Id; pids = @($ownedPids | Select-Object -Unique); startedAt = (Get-Date).ToString("o"); project = $ProjectRoot; url = $Url })
  Write-Log "started npm dev:local pid=$($process.Id), gpu session runner pid=$($runner.Id)"
  if (Wait-Ready) { Open-LocalPage; return "Platform started (PID $($process.Id))" }
  return "Platform is starting; local health check is still pending"
}
function Stop-Platform {
  $state = Read-State
  if (-not $state -or -not $state.pid) { return "No launcher-owned process recorded" }
  $proc = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
  $candidatePids = @($state.pids) + @($state.pid)
  if ($proc) {
    $all = Get-CimInstance Win32_Process
    $descendants = New-Object System.Collections.Generic.List[int]
    $frontier = @([int]$proc.Id)
    while ($frontier.Count -gt 0) {
      $next = @($all | Where-Object { $frontier -contains $_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId })
      $new = @($next | Where-Object { -not $descendants.Contains($_) })
      foreach ($id in $new) { $descendants.Add($id) }
      $frontier = $new
    }
    foreach ($id in ($descendants | Sort-Object -Descending)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }
  foreach ($id in ($candidatePids | Select-Object -Unique)) { Stop-Process -Id ([int]$id) -Force -ErrorAction SilentlyContinue }
  Remove-Item -Force -ErrorAction SilentlyContinue $StatePath
  return "Platform stopped"
}
function Get-StatusText {
  $status = Node-Status; $proc = Find-ProjectServer
  return "Node=$($status.Node) / npm=$($status.Npm) / server=$([bool]$proc) / URL=$Url" + ($(if($proc){" / PID=$($proc.Id)"}else{""}))
}
function Show-Gui {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $form = New-Object Windows.Forms.Form; $form.Text = "AI Image Video Platform"; $form.Size = New-Object Drawing.Size(560,310); $form.StartPosition = "CenterScreen"
  $statusBox = New-Object Windows.Forms.TextBox; $statusBox.Multiline = $true; $statusBox.ReadOnly = $true; $statusBox.ScrollBars = "Vertical"; $statusBox.SetBounds(18,18,508,120); $form.Controls.Add($statusBox)
  $set = { param($text) $statusBox.Text = "$(Get-Date -Format 'HH:mm:ss')  $text`r`n$(Get-StatusText)" }
  $buttons = @(@("Start", { & $set (Start-Platform) }), @("Stop", { & $set (Stop-Platform) }), @("Open Web", { Start-Process $Url; & $set "Local web opened" }), @("Restart", { & $set (Stop-Platform); & $set (Start-Platform) }), @("Status", { & $set "$(Get-StatusText)" }))
  for($i=0;$i -lt $buttons.Count;$i++){ $button=New-Object Windows.Forms.Button; $button.Text=$buttons[$i][0]; $button.SetBounds(18 + (($i % 3) * 170), 160 + ([math]::Floor($i/3) * 48), 150, 34); $handler=$buttons[$i][1]; $button.Add_Click($handler); $form.Controls.Add($button) }
  & $set "Launcher ready"; [void]$form.ShowDialog()
}

switch ($Action) { "start" { Start-Platform } "stop" { Stop-Platform } "open" { Open-LocalPage; "Web opened" } "restart" { Stop-Platform | Out-Null; Start-Platform } "status" { Get-StatusText } default { Show-Gui } }
