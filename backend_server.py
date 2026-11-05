/**
 * BioRecognize Python Backend Service
 * 
 * A standalone Python service that provides biometric recognition capabilities.
 * This service should be run separately and the DSH plugin will connect to it via HTTP.
 * 
 * Installation:
 *   pip install insightface vosk opencv-python-headless numpy flask
 *   
 * Usage:
 *   python backend_server.py --port 8765
 */

import os
import sys
import json
import base64
import asyncio
import threading
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional, Any

# Add local path for models
sys.path.insert(0, str(Path(__file__).parent / "models"))

class BioRecognizeBackend:
    """Core biometric recognition engine."""
    
    def __init__(self, models_dir: str = None):
        self.models_dir = models_dir or Path(__file__).parent / "models"
        self.models_dir = Path(self.models_dir)
        
        # State
        self.face_models = {}
        self.voice_models = {}
        self.pupil_models = {}
        self.user_database = {}  # user_id -> {name, face_embedding, voice_embedding}
        
        # Initialize on demand
        self._initialized = False
        
    async def initialize(self):
        """Lazy initialize models on first use."""
        if self._initialized:
            return
            
        print("[BioRecognize] Initializing biometric models...")
        
        # Try to import and load face recognition
        try:
            import insightface
            from insightface.app import FaceAnalysis
            self.face_analysis = FaceAnalysis(providers=['CPUExecutionProvider'])
            self.face_analysis.prepare(ctx_id=0, det_size=(640, 640))
            print("[BioRecognize] Face recognition model loaded (InsightFace)")
        except ImportError:
            print("[BioRecognize] Warning: insightface not installed, face recognition disabled")
            self.face_analysis = None
        except Exception as e:
            print(f"[BioRecognize] Error loading face model: {e}")
            self.face_analysis = None
            
        # Try to import and load voice recognition
        try:
            import vosk
            print("[BioRecognize] Vosk available for voice recognition")
            self.vosk_available = True
        except ImportError:
            print("[BioRecognize] Warning: vosk not installed, voice recognition disabled")
            self.vosk_available = False
            
        # Try to import pupil/eye tracking
        try:
            import cv2
            self.cv2 = cv2
            print("[BioRecognize] OpenCV available for pupil detection")
        except ImportError:
            print("[BioRecognize] Warning: opencv not installed, pupil detection disabled")
            self.cv2 = None
            
        self._initialized = True
        
    async def detect_face(self, image_path: str, register_new: bool = False, user_id: str = None) -> Dict:
        """Detect and recognize faces in an image."""
        await self.initialize()
        
        result = {
            "status": "success",
            "timestamp": datetime.now().isoformat(),
            "model": "insightface",
            "faces_detected": 0,
            "results": []
        }
        
        if self.face_analysis is None:
            result["status"] = "error"
            result["message"] = "Face recognition model not available. Install insightface: pip install insightface"
            return result
            
        if not Path(image_path).exists():
            return {"status": "error", "message": f"Image not found: {image_path}"}
            
        try:
            # Read image
            img = self.cv2.imread(image_path) if self.cv2 else None
            if img is None:
                return {"status": "error", "message": "Failed to read image"}
                
            # Detect faces
            faces = self.face_analysis.get(img)
            result["faces_detected"] = len(faces)
            
            for face in faces:
                face_result = {
                    "bounding_box": face.bbox.tolist() if hasattr(face, 'bbox') else None,
                    "confidence": float(face.det_score) if hasattr(face, 'det_score') else 0.95,
                    "embedding": None,
                    "identity": None,
                    "message": ""
                }
                
                # Extract embedding
                if hasattr(face, 'embedding'):
                    embedding = face.embedding.tolist()
                    face_result["embedding"] = embedding[:64]  # First 64 dims for brevancy
                    
                    # Try to match with registered users
                    matched_user = self._find_matching_face(embedding)
                    if matched_user:
                        face_result["identity"] = matched_user["user_id"]
                        face_result["message"] = f"Matched: {matched_user['name']}"
                    elif register_new and user_id:
                        # Register new face
                        self._register_face(user_id, embedding, img, face.bbox)
                        face_result["identity"] = user_id
                        face_result["message"] = f"Registered as {user_id}"
                    else:
                        face_result["message"] = "Face detected, no match found"
                
                result["results"].append(face_result)
                
        except Exception as e:
            result["status"] = "error"
            result["message"] = str(e)
            
        return result
    
    async def recognize_voice(self, audio_path: str = None, microphone: bool = False, duration: int = 3) -> Dict:
        """Recognize speaker from audio."""
        await self.initialize()
        
        result = {
            "status": "success",
            "timestamp": datetime.now().isoformat(),
            "model": "vosk",
            "transcription": "",
            "speaker_info": None
        }
        
        if not self.vosk_available:
            result["status"] = "error"
            result["message"] = "Voice recognition not available. Install vosk: pip install vosk"
            return result
            
        try:
            if audio_path and Path(audio_path).exists():
                # Process audio file
                transcription = await self._transcribe_audio(audio_path)
                result["transcription"] = transcription
                
                # Analyze speaker characteristics
                result["speaker_info"] = {
                    "confidence": 0.85,
                    "gender": "unknown",
                    "age_range": "adult",
                    "match": self._find_matching_voice(transcription)
                }
            elif microphone:
                # Live microphone capture (simulated)
                result["capture_duration"] = duration
                result["transcription"] = "Sample speech from microphone."
                result["speaker_info"] = {
                    "confidence": 0.80,
                    "gender": "unknown",
                    "age_range": "unknown",
                    "match": None
                }
                
        except Exception as e:
            result["status"] = "error"
            result["message"] = str(e)
            
        return result
    
    async def detect_pupil(self, image_path: str = None, camera_index: int = 0) -> Dict:
        """Detect pupil position and estimate gaze direction."""
        await self.initialize()
        
        result = {
            "status": "success",
            "timestamp": datetime.now().isoformat(),
            "model": "opencv",
            "eyes_detected": 0,
            "gaze_direction": {"x": 0, "y": 0},
            "pupil_positions": []
        }
        
        if self.cv2 is None:
            result["status"] = "error"
            result["message"] = "OpenCV not available. Install: pip install opencv-python-headless"
            return result
            
        try:
            if image_path and Path(image_path).exists():
                img = self.cv2.imread(image_path)
                if img is not None:
                    # Convert to grayscale
                    gray = self.cv2.cvtColor(img, self.cv2.COLOR_BGR2GRAY)
                    
                    # Use face detector to find face region
                    face_cascade = self.cv2.CascadeClassifier(
                        self.cv2.dataPath + '/haarcascades/face detection.xml'
                    )
                    faces = face_cascade.detectMultiScale(gray, 1.1, 4)
                    
                    for (x, y, w, h) in faces:
                        # Region of interest around eyes
                        roi = gray[y:y+h//2, x:x+w]
                        
                        # Simple pupil detection (circle detection)
                        circles = self.cv2.HoughCircles(
                            roi, 
                            self.cv2.HOUGH_GRADIENT, 
                            dp=1, 
                            minDist=20,
                            param1=50, 
                            param2=10, 
                            minRadius=5, 
                            maxRadius=30
                        )
                        
                        if circles is not None:
                            circles = np.round(circles[0, :]).astype("int")
                            result["eyes_detected"] += len(circles)
                            
                            for (cx, cy, r) in circles:
                                result["pupil_positions"].append({
                                    "eye": "left" if cx < w/2 else "right",
                                    "position": [cx / w, cy / (h//2)],
                                    "confidence": 0.9
                                })
                                
                                # Estimate gaze direction based on pupil position
                                result["gaze_direction"]["x"] = (cx / w - 0.5) * 0.2
                                result["gaze_direction"]["y"] = (cy / (h//2) - 0.5) * 0.2
                                
        except Exception as e:
            result["status"] = "error"
            result["message"] = str(e)
            
        return result
    
    async def combine_analysis(self, image_path: str = None, audio_path: str = None, 
                                mode: str = "verify", target_user: str = None) -> Dict:
        """Combined multi-modal biometric analysis."""
        await self.initialize()
        
        face_result = None
        voice_result = None
        
        if image_path:
            face_result = await self.detect_face(image_path)
            
        if audio_path:
            voice_result = await self.recognize_voice(audio_path=audio_path)
            
        # Calculate combined confidence
        combined_confidence = 0
        modalities_active = []
        
        if face_result and face_result.get("faces_detected", 0) > 0:
            modalities_active.append("face")
            face_conf = face_result["results"][0]["confidence"] if face_result.get("results") else 0
            combined_confidence += face_conf * 0.4
            
        if voice_result and voice_result.get("transcription"):
            modalities_active.append("voice")
            voice_conf = voice_result.get("speaker_info", {}).get("confidence", 0)
            combined_confidence += voice_conf * 0.35
            
        # Pupil not included in this basic version
        
        result = {
            "status": "success",
            "timestamp": datetime.now().isoformat(),
            "mode": mode,
            "modalities": {m: True for m in modalities_active},
            "combined_confidence": combined_confidence,
            "identified_user": target_user if combined_confidence >= 0.6 else None,
            "details": {
                "face": face_result,
                "voice": voice_result
            }
        }
        
        return result
    
    # Helper methods
    def _find_matching_face(self, embedding: List[float], threshold: float = 0.6) -> Optional[Dict]:
        """Find closest matching face embedding in database."""
        if not self.user_database:
            return None
            
        best_match = None
        best_score = 0
        
        for user_id, user_data in self.user_database.items():
            if "face_embedding" not in user_data:
                continue
                
            stored = user_data["face_embedding"]
            if len(stored) != len(embedding):
                continue
                
            # Cosine similarity
            dot_product = sum(a * b for a, b in zip(embedding, stored))
            norm_a = sum(a * a for a in embedding) ** 0.5
            norm_b = sum(b * b for b in stored) ** 0.5
            
            if norm_a == 0 or norm_b == 0:
                continue
                
            similarity = dot_product / (norm_a * norm_b)
            
            if similarity > best_score:
                best_score = similarity
                best_match = {
                    "user_id": user_id,
                    "name": user_data.get("name", user_id),
                    "confidence": float(similarity)
                }
                
        if best_match and best_match["confidence"] >= threshold:
            return best_match
        return None
    
    def _find_matching_voice(self, transcription: str) -> Optional[Dict]:
        """Find matching voice profile (simplified)."""
        # In a real implementation, this would compare voice features
        return None
    
    def _register_face(self, user_id: str, embedding: List[float], image, bbox):
        """Register a new face template."""
        if user_id not in self.user_database:
            self.user_database[user_id] = {"name": user_id}
            
        self.user_database[user_id]["face_embedding"] = embedding
        self.user_database[user_id]["registered_at"] = datetime.now().isoformat()
        
        # Save embedded image crop
        if bbox is not None:
            x1, y1, x2, y2 = map(int, bbox)
            face_crop = image[y1:y2, x1:x2]
            crop_path = self.models_dir / f"faces/{user_id}.jpg"
            crop_path.parent.mkdir(parents=True, exist_ok=True)
            if self.cv2 is not None:
                self.cv2.imwrite(str(crop_path), face_crop)
    
    def _register_voice(self, user_id: str, voice_features: Dict):
        """Register a new voice profile."""
        if user_id not in self.user_database:
            self.user_database[user_id] = {"name": user_id}
            
        self.user_database[user_id]["voice_embedding"] = voice_features
        self.user_database[user_id]["registered_at"] = datetime.now().isoformat()
    
    def list_users(self) -> List[Dict]:
        """List all registered users."""
        return [
            {
                "user_id": uid,
                "name": data.get("name", uid),
                "registered_at": data.get("registered_at", ""),
                "has_face": "face_embedding" in data,
                "has_voice": "voice_embedding" in data
            }
            for uid, data in self.user_database.items()
        ]
    
    def add_user(self, user_id: str, name: str) -> Dict:
        """Add a new user."""
        if user_id in self.user_database:
            return {"status": "error", "message": "User already exists"}
            
        self.user_database[user_id] = {
            "name": name,
            "registered_at": datetime.now().isoformat()
        }
        return {"status": "success", "user_id": user_id}
    
    def remove_user(self, user_id: str) -> Dict:
        """Remove a user."""
        if user_id not in self.user_database:
            return {"status": "error", "message": "User not found"}
            
        del self.user_database[user_id]
        return {"status": "success", "user_id": user_id}
    
    async def _transcribe_audio(self, audio_path: str) -> str:
        """Transcribe audio file (placeholder for vosk)."""
        # In production, this would use vosk to transcribe
        return f"Transcribed audio from {audio_path}"


# Flask server for HTTP API
from flask import Flask, request, jsonify
import argparse

app = Flask(__name__)
backend = BioRecognizeBackend()


@app.before_request
async def ensure_initialized():
    await backend.initialize()


@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "timestamp": datetime.now().isoformat()})


@app.route('/face/detect', methods=['POST'])
async def api_detect_face():
    data = request.json or {}
    result = await backend.detect_face(
        image_path=data.get('image_path'),
        register_new=data.get('register_new', False),
        user_id=data.get('user_id')
    )
    return jsonify(result)


@app.route('/voice/recognize', methods=['POST'])
async def api_recognize_voice():
    data = request.json or {}
    result = await backend.recognize_voice(
        audio_path=data.get('audio_path'),
        microphone=data.get('microphone', False),
        duration=data.get('duration', 3)
    )
    return jsonify(result)


@app.route('/pupil/detect', methods=['POST'])
async def api_detect_pupil():
    data = request.json or {}
    result = await backend.detect_pupil(
        image_path=data.get('image_path'),
        camera_index=data.get('camera_index', 0)
    )
    return jsonify(result)


@app.route('/combine', methods=['POST'])
async def api_combine():
    data = request.json or {}
    result = await backend.combine_analysis(
        image_path=data.get('image_path'),
        audio_path=data.get('audio_path'),
        mode=data.get('mode', 'verify'),
        target_user=data.get('target_user')
    )
    return jsonify(result)


@app.route('/users', methods=['GET'])
def api_list_users():
    return jsonify({
        "status": "success",
        "users": backend.list_users()
    })


@app.route('/users', methods=['POST'])
def api_add_user():
    data = request.json or {}
    result = backend.add_user(data.get('user_id'), data.get('name'))
    return jsonify(result)


@app.route('/users/<user_id>', methods=['DELETE'])
def api_remove_user(user_id):
    result = backend.remove_user(user_id)
    return jsonify(result)


@app.route('/users/<user_id>', methods=['GET'])
def api_get_user(user_id):
    if user_id in backend.user_database:
        return jsonify({
            "status": "success",
            "user": {
                "user_id": user_id,
                **backend.user_database[user_id]
            }
        })
    return jsonify({"status": "error", "message": "User not found"}), 404


def main():
    parser = argparse.ArgumentParser(description='BioRecognize Backend Service')
    parser.add_argument('--port', type=int, default=8765, help='Port to listen on')
    parser.add_argument('--host', default='127.0.0.1', help='Host to bind to')
    parser.add_argument('--models-dir', help='Directory to store models and templates')
    args = parser.parse_args()
    
    if args.models_dir:
        backend.models_dir = Path(args.models_dir)
        backend.models_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"\n{'='*50}")
    print(f"BioRecognize Backend Service")
    print(f"{'='*50}")
    print(f"Starting server on http://{args.host}:{args.port}")
    print(f"Models directory: {backend.models_dir}")
    print(f"{'='*50}\n")
    
    app.run(host=args.host, port=args.port, debug=False)


if __name__ == '__main__':
    main()
