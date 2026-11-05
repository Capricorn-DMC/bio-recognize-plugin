# BioRecognize - One-Command Setup

param(
    [int]$Port = 8765,
    [switch]$Test
)

$scriptDir = $PSScriptRoot
$serverScript = Join-Path $scriptDir "server.js"

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  BioRecognize Setup" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Check Node.js
Write-Host "[1/2] Checking Node.js..." -ForegroundColor Yellow
$nodeVersion = node --version 2>&1
if ($nodeVersion) {
    Write-Host "  Node.js: $nodeVersion" -ForegroundColor Green
} else {
    Write-Host "  ERROR: Node.js not found!" -ForegroundColor Red
    Write-Host "  Please install from: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

# Check if server is already running
Write-Host "`n[2/2] Starting backend server..." -ForegroundColor Yellow
Write-Host "  URL: http://localhost:$Port" -ForegroundColor Cyan

if (Test-Path $serverScript) {
    Write-Host "  Server script found" -ForegroundColor Green
    Write-Host "`n  Starting server in background..." -ForegroundColor Gray
    
    # Start server
    $process = Start-Process -FilePath "node" -ArgumentList "server.js --port=$Port" -WorkingDirectory $scriptDir -PassThru -WindowStyle Normal
    
    Write-Host "  PID: $($process.Id)" -ForegroundColor Green
    Write-Host "`n  Server running at: http://localhost:$Port`n" -ForegroundColor Green
    
    # Test connection
    Start-Sleep -Seconds 1
    $health = curl.exe -s "http://localhost:$Port/health" 2>$null
    if ($health) {
        Write-Host "  Health check: $health" -ForegroundColor Green
    }
    
    Write-Host "`n========================================" -ForegroundColor Green
    Write-Host "  Server Ready!" -ForegroundColor Green
    Write-Host "========================================`n" -ForegroundColor Green
    
    Write-Host "Next steps:" -ForegroundColor White
    Write-Host "  1. Test: cd $scriptDir; node test_server.js" -ForegroundColor Cyan
    Write-Host "  2. Use DSH tools: biometric_face_detect, biometric_combine, etc." -ForegroundColor Cyan
    Write-Host "  3. Stop server: Stop-Process -Id $process.Id`n" -ForegroundColor Cyan
    
    if ($Test) {
        Write-Host "Running tests..." -ForegroundColor Yellow
        node test_server.js
    }
} else {
    Write-Host "  ERROR: server.js not found!" -ForegroundColor Red
    exit 1
}
