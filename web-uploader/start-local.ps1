$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $appDir

$port = if ($env:PORT) { $env:PORT } else { "8090" }
$localHost = if ($env:LOCAL_HOST) { $env:LOCAL_HOST } else { "127.0.0.1" }
$viewerUrl = "http://$localHost`:$port/viewer"
$venvPython = Join-Path $appDir ".venv\Scripts\python.exe"

function Test-PythonModules {
  param([string]$PythonCommand)
  try {
    & $PythonCommand -c "import importlib.util,sys;mods=['numpy','laspy','pyproj','lazrs'];missing=[m for m in mods if importlib.util.find_spec(m) is None];sys.exit(0 if not missing else 1)" *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

if (-not (Test-Path "node_modules") -or (-not (Test-Path $venvPython) -and -not (Test-PythonModules "python"))) {
  Write-Host "[setup] local runtime not ready, running setup-local.ps1 ..."
  & powershell -ExecutionPolicy Bypass -File (Join-Path $appDir "setup-local.ps1")
}

$runtimePython = if ((Test-Path $venvPython) -and (Test-PythonModules $venvPython)) { $venvPython } else { "python" }

$env:PYTHON_BIN = $runtimePython
$env:PYTHON3_BIN = "python"
$env:PORT = $port

$openBrowserJob = Start-Job -ScriptBlock {
  param($url)
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $url -Method Get -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        Start-Process $url
        return
      }
    } catch {
    }
    Start-Sleep -Milliseconds 500
  }
} -ArgumentList $viewerUrl

Write-Host "[start] launching local server on port $port ..."
try {
  node server.js
} finally {
  Stop-Job $openBrowserJob -ErrorAction SilentlyContinue | Out-Null
  Remove-Job $openBrowserJob -Force -ErrorAction SilentlyContinue | Out-Null
}
