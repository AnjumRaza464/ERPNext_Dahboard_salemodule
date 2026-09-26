# Starts the FastAPI sales backend (port 8010) and the Next.js frontend (port 3000)
# in two separate PowerShell windows. Run from anywhere:  powershell -File E:\Dash_final\start.ps1
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path "$root\backend\.venv\Scripts\python.exe")) {
  Write-Host "Creating backend virtualenv..." -ForegroundColor Cyan
  python -m venv "$root\backend\.venv"
  & "$root\backend\.venv\Scripts\python.exe" -m pip install -q -r "$root\backend\requirements.txt"
}
if (-not (Test-Path "$root\backend\.env")) {
  Write-Host "backend\.env missing - copy backend\.env.example and fill in the ERPNext API key/secret." -ForegroundColor Yellow
  exit 1
}
if (-not (Test-Path "$root\frontend\node_modules")) {
  Write-Host "Installing frontend dependencies..." -ForegroundColor Cyan
  Push-Location "$root\frontend"; npm install; Pop-Location
}

Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root\backend'; .\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8010"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root\frontend'; npm run dev"

Write-Host "Backend:  http://localhost:8010/docs" -ForegroundColor Green
Write-Host "Frontend: http://localhost:3000" -ForegroundColor Green
