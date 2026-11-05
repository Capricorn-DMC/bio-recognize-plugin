# BioRecognize Quick Start
# Automated setup with Python installation

param(
    [int]$Port = 8765,
    [switch]$DownloadModels,
    [switch]$SkipServer
)

$scriptDir = $PSScriptRoot
$setupScript = Join-Path $scriptDir "setup.ps1"

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  BioRecognize Quick Start" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Run setup
Write-Host "Running automated setup..." -ForegroundColor Yellow
& $setupScript -InstallDir $scriptDir -DownloadModels:$DownloadModels

if ($LASTEXITCODE -ne 0) {
    Write-Host "`nSetup failed. Check errors above." -ForegroundColor Red
    exit 1
}

if (-not $SkipServer) {
    Write-Host "`n========================================" -ForegroundColor Green
    Write-Host "  Starting Server..." -ForegroundColor Green
    Write-Host "========================================`n" -ForegroundColor Green
    
    $venvPython = Join-Path $scriptDir ".venv\Scripts\python.exe"
    if (Test-Path $venvPython) {
        Write-Host "Backend URL: http://localhost:$Port" -ForegroundColor Cyan
        Write-Host "Press Ctrl+C to stop`n" -ForegroundColor Gray
        Set-Location $scriptDir
        & $venvPython backend_server.py --port $Port
    } else {
        Write-Host "Virtual environment not found. Run setup first." -ForegroundColor Red
    }
} else {
    Write-Host "`n========================================" -ForegroundColor Green
    Write-Host "  Setup Complete!" -ForegroundColor Green
    Write-Host "========================================`n" -ForegroundColor Green
    
    Write-Host "Next steps:" -ForegroundColor White
    Write-Host "  1. Start server: .\start.ps1" -ForegroundColor Cyan
    Write-Host "  2. Test: .\test.ps1" -ForegroundColor Cyan
    Write-Host "  3. DSH tools are ready to use" -ForegroundColor Cyan
    Write-Host "`n" -ForegroundColor Gray
}
