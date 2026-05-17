$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $appDir

$venvPython = Join-Path $appDir ".venv\Scripts\python.exe"
$needsFreshVenv = $false
$pythonForDeps = $venvPython

Write-Host "[1/3] Installing Node dependencies..."
if (Test-Path "node_modules") {
  Write-Host "Node modules already present, skipping npm install."
} else {
  npm install
}

Write-Host "[2/3] Preparing Python virtual environment..."
if (-not (Test-Path $venvPython)) {
  $needsFreshVenv = $true
} else {
  try {
    & $venvPython -m pip --version *> $null
  } catch {
    $needsFreshVenv = $true
  }
  if ($LASTEXITCODE -ne 0) {
    $needsFreshVenv = $true
  }
}

if ($needsFreshVenv) {
  if (Test-Path ".venv") {
    Remove-Item ".venv" -Recurse -Force
  }
  python -m venv .venv
}

try {
  & $venvPython -m pip --version *> $null
  if ($LASTEXITCODE -ne 0) {
    $pythonForDeps = "python"
  }
} catch {
  $pythonForDeps = "python"
}

if ($pythonForDeps -eq "python") {
  Write-Host "Windows venv pip is unavailable, falling back to system python."
}

& $pythonForDeps -m pip install --upgrade pip
& $pythonForDeps -m pip install -r requirements-export.txt

Write-Host "[3/3] Verifying local runtime..."
& $pythonForDeps -c "import importlib.util,sys;mods=['numpy','laspy','pyproj','lazrs','scipy','matplotlib','reportlab','PIL','CSF'];missing=[m for m in mods if importlib.util.find_spec(m) is None];sys.exit(('Missing Python modules: ' + ', '.join(missing)) if missing else 0)"
if ($LASTEXITCODE -ne 0) {
  throw "Python runtime verification failed."
}

node --check server.js | Out-Null
Write-Host "Node runtime OK"
Write-Host ""
Write-Host "Local setup completed."
Write-Host ""
Write-Host "Start the local server with:"
Write-Host "  npm run start:local"
Write-Host ""
Write-Host "Open:"
Write-Host "  http://localhost:8090"
Write-Host "  http://localhost:8090/viewer"
