# BioRecognize - Test Script
# Tests all biometric tools via the backend API

param(
    [string]$BaseUrl = "http://127.0.0.1:8765",
    [string]$ImagePath = "",
    [string]$AudioPath = ""
)

$ErrorActionPreference = "Stop"

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  BioRecognize Test Script" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Helper function for HTTP requests
function Invoke-BioRequest {
    param(
        [string]$Method,
        [string]$Endpoint,
        [object]$Body = $null
    )
    
    $url = "$BaseUrl$Endpoint"
    $headers = @{ "Content-Type" = "application/json" }
    
    try {
        if ($Method -eq "GET") {
            $response = Invoke-RestMethod -Uri $url -Method GET -Headers $headers
        } else {
            $response = Invoke-RestMethod -Uri $url -Method POST -Headers $headers -Body ($Body | ConvertTo-Json -Depth 10)
        }
        return @{ Success = $true; Data = $response }
    } catch {
        return @{ Success = $false; Error = $_.Exception.Message }
    }
}

# Test 1: Health Check
Write-Host "[Test 1] Health Check" -ForegroundColor Yellow
$result = Invoke-BioRequest -Method GET -Endpoint "/health"
if ($result.Success) {
    Write-Host "  Status: $($result.Data.status)" -ForegroundColor Green
} else {
    Write-Host "  Error: $($result.Error)" -ForegroundColor Red
    Write-Host "  Make sure the backend server is running on $BaseUrl" -ForegroundColor Red
    exit 1
}

# Test 2: User Management
Write-Host "`n[Test 2] User Management" -ForegroundColor Yellow

# List users
$result = Invoke-BioRequest -Method GET -Endpoint "/users"
if ($result.Success) {
    Write-Host "  Current users: $($result.Data.users.Count)" -ForegroundColor Green
    $result.Data.users | ForEach-Object { Write-Host "    - $($_.user_id) ($($_.name))" -ForegroundColor Gray }
}

# Add test user
$testUserId = "test_user_$(Get-Random -Maximum 9999)"
$result = Invoke-BioRequest -Method POST -Endpoint "/users" -Body @{
    user_id = $testUserId
    name = "Test User"
}
if ($result.Success) {
    Write-Host "  Added user: $testUserId" -ForegroundColor Green
} else {
    Write-Host "  Could not add user: $($result.Error)" -ForegroundColor Red
}

# Test 3: Face Detection
Write-Host "`n[Test 3] Face Detection" -ForegroundColor Yellow

if ($ImagePath -and (Test-Path $ImagePath)) {
    $result = Invoke-BioRequest -Method POST -Endpoint "/face/detect" -Body @{
        image_path = $ImagePath
        register_new = $false
    }
    if ($result.Success) {
        Write-Host "  Faces detected: $($result.Data.faces_detected)" -ForegroundColor Green
        if ($result.Data.results.Count -gt 0) {
            $result.Data.results | ForEach-Object {
                Write-Host "    Confidence: $([math]::Round($_.confidence * 100, 1))%" -ForegroundColor Gray
                Write-Host "    Message: $($_.message)" -ForegroundColor Gray
            }
        }
    } else {
        Write-Host "  Error: $($result.Error)" -ForegroundColor Red
    }
} else {
    Write-Host "  Skipping (no image path provided)" -ForegroundColor Gray
    Write-Host "  Example: .\test.ps1 -ImagePath 'C:\path\to\photo.jpg'" -ForegroundColor Gray
}

# Test 4: Voice Recognition
Write-Host "`n[Test 4] Voice Recognition" -ForegroundColor Yellow

if ($AudioPath -and (Test-Path $AudioPath)) {
    $result = Invoke-BioRequest -Method POST -Endpoint "/voice/recognize" -Body @{
        audio_path = $AudioPath
        microphone = $false
    }
    if ($result.Success) {
        Write-Host "  Transcription: $($result.Data.transcription)" -ForegroundColor Green
    } else {
        Write-Host "  Error: $($result.Error)" -ForegroundColor Red
    }
} else {
    Write-Host "  Skipping (no audio path provided)" -ForegroundColor Gray
    Write-Host "  Example: .\test.ps1 -AudioPath 'C:\path\to\audio.wav'" -ForegroundColor Gray
}

# Test 5: Pupil Detection
Write-Host "`n[Test 5] Pupil Detection" -ForegroundColor Yellow

if ($ImagePath -and (Test-Path $ImagePath)) {
    $result = Invoke-BioRequest -Method POST -Endpoint "/pupil/detect" -Body @{
        image_path = $ImagePath
    }
    if ($result.Success) {
        Write-Host "  Eyes detected: $($result.Data.eyes_detected)" -ForegroundColor Green
        Write-Host "  Gaze: X=$($result.Data.gaze_direction.x) Y=$($result.Data.gaze_direction.y)" -ForegroundColor Gray
    } else {
        Write-Host "  Error: $($result.Error)" -ForegroundColor Red
    }
}

# Test 6: Combined Analysis
Write-Host "`n[Test 6] Combined Analysis" -ForegroundColor Yellow

$combinedBody = @{}
if ($ImagePath -and (Test-Path $ImagePath)) {
    $combinedBody["image_path"] = $ImagePath
}
if ($AudioPath -and (Test-Path $AudioPath)) {
    $combinedBody["audio_path"] = $AudioPath
}
$combinedBody["mode"] = "verify"
$combinedBody["target_user"] = $testUserId

if ($combinedBody.Count -gt 2) {
    $result = Invoke-BioRequest -Method POST -Endpoint "/combine" -Body $combinedBody
    if ($result.Success) {
        Write-Host "  Combined Confidence: $([math]::Round($result.Data.combined_confidence * 100, 1))%" -ForegroundColor Green
        Write-Host "  Identified User: $($result.Data.identified_user ?? 'None')" -ForegroundColor Gray
        Write-Host "  Modalities: $($result.Data.modalities.Keys -join ', ')" -ForegroundColor Gray
    } else {
        Write-Host "  Error: $($result.Error)" -ForegroundColor Red
    }
} else {
    Write-Host "  Skipping (need both image and audio for combined analysis)" -ForegroundColor Gray
}

# Cleanup
Write-Host "`n[Test 7] Cleanup" -ForegroundColor Yellow
$result = Invoke-BioRequest -Method DELETE -Endpoint "/users/$testUserId"
if ($result.Success -and $result.Data.status -eq "success") {
    Write-Host "  Removed test user: $testUserId" -ForegroundColor Green
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Tests Complete!" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Cyan
