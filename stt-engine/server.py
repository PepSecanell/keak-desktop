#!/usr/bin/env python3
"""
Keak Sovereign — local transcription server (standalone build).

Runs faster-whisper on-device. No audio leaves the machine. Serves the exact contract the Keak desktop
overlay expects: GET /health and POST /transcribe (multipart `file` + optional `language`) on 127.0.0.1:9889.

Built into a single self-contained executable by .github/workflows/keak-stt-build.yml (PyInstaller). ffmpeg
is bundled via imageio-ffmpeg, so the user needs nothing installed. The model is fetched once on first run.
"""

import os
import sys
import tempfile
import subprocess

# ── Config (override via env vars) ────────────────────────────────────────────
MODEL_SIZE   = os.getenv("KEAK_WHISPER_MODEL",  "distil-large-v3")
DEVICE       = os.getenv("KEAK_WHISPER_DEVICE", "auto")   # auto | cpu | cuda
COMPUTE_TYPE = os.getenv("KEAK_WHISPER_COMPUTE", "int8")  # int8 is fastest on CPU
PORT         = int(os.getenv("KEAK_WHISPER_PORT", "9889"))
BEAM_SIZE    = int(os.getenv("KEAK_WHISPER_BEAM", "1"))   # 1 = fastest, 5 = most accurate
# ──────────────────────────────────────────────────────────────────────────────

from fastapi import FastAPI, File, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from faster_whisper import WhisperModel

# Bundled ffmpeg — no system install needed (imageio-ffmpeg ships a static binary PyInstaller can include).
try:
    import imageio_ffmpeg
    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
except Exception:
    FFMPEG = "ffmpeg"  # fall back to PATH


def resolve_device(device: str):
    if device != "auto":
        return device, COMPUTE_TYPE
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16"
    except Exception:
        pass
    return "cpu", "int8"


real_device, real_compute = resolve_device(DEVICE)
print(f"Loading {MODEL_SIZE} on {real_device} ({real_compute}) …", flush=True)
model = WhisperModel(MODEL_SIZE, device=real_device, compute_type=real_compute)
print(f"Model loaded. Keak Sovereign ready on http://127.0.0.1:{PORT}", flush=True)

app = FastAPI(title="Keak Sovereign — Local Whisper")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_SIZE, "device": real_device}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...), language: str = Form(None)):
    audio_bytes = await file.read()
    with tempfile.TemporaryDirectory() as tmp_dir:
        webm_path = os.path.join(tmp_dir, "rec.webm")
        wav_path = os.path.join(tmp_dir, "rec.wav")
        with open(webm_path, "wb") as f:
            f.write(audio_bytes)
        try:
            subprocess.run(
                [FFMPEG, "-y", "-i", webm_path, "-ar", "16000", "-ac", "1", "-f", "wav", wav_path],
                check=True, capture_output=True, timeout=20,
            )
        except subprocess.CalledProcessError as e:
            return {"error": f"ffmpeg conversion failed: {e.stderr.decode()[:200]}"}
        except FileNotFoundError:
            return {"error": "ffmpeg not available in this build"}

        kwargs = {"beam_size": BEAM_SIZE, "vad_filter": True, "vad_parameters": {"min_silence_duration_ms": 300}}
        if language and language != "auto":
            kwargs["language"] = language
        segments, info = model.transcribe(wav_path, **kwargs)
        text = " ".join(s.text.strip() for s in segments).strip()

    return {
        "text": text,
        "duration_seconds": round(info.duration, 2) if hasattr(info, "duration") else 0,
        "language": getattr(info, "language", language or "auto"),
    }


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
