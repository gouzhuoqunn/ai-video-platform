param(
  [Parameter(Mandatory = $true)]
  [string]$HostName,

  [Parameter(Mandatory = $true)]
  [string]$UserName
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$workerEnv = Join-Path $projectRoot ".secrets\gpu-worker.env"

if (-not (Test-Path -LiteralPath $workerEnv)) {
  throw "Missing .secrets/gpu-worker.env. Create the limited gpu_worker account before uploading worker credentials."
}

Write-Host "Dry-run upload plan for $UserName@$HostName"
Write-Host "Will upload only: .secrets/gpu-worker.env -> /workspace/gpu-worker.env"
Write-Host "Will upload worker code directory: gpu-worker -> /workspace/app/gpu-worker"
Write-Host "Will upload Clore helper shell scripts -> /workspace/app/scripts/clore"
Write-Host "Will not upload local app env files, Clore API key files, SSH private keys, logs, model weights, or user media."
Write-Host "Remote commands to run after intentional order creation:"
Write-Host "  bash /workspace/app/scripts/clore/bootstrap-worker.sh"
Write-Host "  bash /workspace/app/scripts/clore/start-worker.sh"
Write-Host "No network command is executed by this script in this preparation phase."
