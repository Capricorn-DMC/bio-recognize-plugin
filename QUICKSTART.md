# BioRecognize - Quick Start Guide

## Installation (One-Command)

```powershell
cd C:\Users\RJ21\Documents\deepseek-harness\default-workspace\bio-recognize-plugin
.\start.ps1
```

Or with manual Python path:
```powershell
.\start.ps1 -PythonPath "C:\Python311\python.exe"
```

## Manual Setup

If automatic setup fails:

### 1. Install Python
Download from https://www.python.org/downloads/ (select "Add to PATH")

### 2. Create virtual environment
```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

### 3. Download Models

**Face Recognition (InsightFace):**
```powershell
cd models\insightface
# Download from: https://github.com/deepinsight/insightface/tree/master/python-package#pretrained-models
# Extract 'buffalo_l' or 'antelopev2' folder here
```

**Voice Recognition (Vosk):**
```powershell
cd models\vosk
Invoke-WebRequest -Uri "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip" -OutFile "vosk-model-small-en-us-0.15.zip"
Expand-Archive -Path "vosk-model-small-en-us-0.15.zip" -DestinationPath "." -Force
```

### 4. Start Server
```powershell
python backend_server.py --port 8765
```

## DSH Plugin Already Installed

The DSH plugin `@local/bio-recognize` is already installed and active.

## Testing

```powershell
# Test with sample data
.\test.ps1 -ImagePath "C:\path\to\face.jpg" -AudioPath "C:\path\to\voice.wav"

# Quick health check
.\test.ps1
```

## Tools Available in DSH

| Tool | Function |
|------|----------|
| `biometric_face_detect` | Detect & recognize faces |
| `biometric_voice_recognize` | Speaker identification |
| `biometric_pupil_detect` | Eye/gaze tracking |
| `biometric_combine` | Multi-modal fusion |
| `biometric_manage_users` | User management |

## Architecture

```
┌─────────────────┐     HTTP      ┌──────────────────┐
│   DSH Plugin    │ ◄──────────► │  Python Backend  │
│  (Node.js)      │    :8765     │  (Flask + ML)    │
└─────────────────┘              └──────────────────┘
                                         │
                                 ┌───────┴───────┐
                                 │   Models      │
                                 ├───────────────┤
                                 │ InsightFace   │
                                 │ Vosk          │
                                 │ OpenCV        │
                                 └───────────────┘
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `insightface not found` | Install with `pip install insightface` |
| `vosk not found` | Install with `pip install vosk` |
| `opencv not found` | Install with `pip install opencv-python-headless` |
| Backend connection failed | Start server: `python backend_server.py --port 8765` |

## File Structure

```
bio-recognize-plugin/
├── index.js              # DSH Agent tools (already installed)
├── client.js             # UI components
├── backend_server.py     # Python ML backend
├── requirements.txt      # Python dependencies
├── setup.ps1            # Installation script
├── start.ps1            # Quick start script
├── test.ps1             # Test script
├── README.md            # Full documentation
├── cordis.patch.yml     # DSH bundle config
└── models/              # ML model storage
    ├── insightface/
    ├── vosk/
    └── faces/
```
