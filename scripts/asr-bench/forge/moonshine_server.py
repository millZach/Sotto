# OpenAI-compatible transcription server for Moonshine models, for Forge.
#
# Mirrors the endpoint shape of the Parakeet container (POST
# /v1/audio/transcriptions, multipart `file` + `model`, returns {"text": ...})
# so Sotto's remote transcriber and scripts/asr-bench/bench-forge.mjs can hit
# either server by URL alone.
#
# Run:  uvicorn moonshine_server:app --host 0.0.0.0 --port 5093

import io
import math
import os

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
from transformers import pipeline

MODEL_ID = os.environ.get("MOONSHINE_MODEL", "UsefulSensors/moonshine-streaming-medium")
DEVICE = "cuda:0" if torch.cuda.is_available() else "cpu"

asr = pipeline(
    "automatic-speech-recognition",
    model=MODEL_ID,
    device=DEVICE,
    torch_dtype=torch.float16 if DEVICE.startswith("cuda") else torch.float32,
)

# Warm up so the first real request doesn't pay CUDA graph/kernel setup.
asr({"array": np.zeros(16000, dtype=np.float32), "sampling_rate": 16000},
    generate_kwargs={"max_new_tokens": 24})

app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_ID, "device": DEVICE}


@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...), model: str = Form(None)):
    try:
        data, sr = sf.read(io.BytesIO(await file.read()), dtype="float32")
    except Exception as err:  # noqa: BLE001
        return JSONResponse(status_code=400, content={"error": f"could not decode audio: {err}"})
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != 16000:
        # Callers (Sotto, bench) always send 16 kHz; linear resample keeps
        # stray inputs working without pulling in librosa.
        target = int(len(data) * 16000 / sr)
        data = np.interp(np.linspace(0, len(data), target, endpoint=False),
                         np.arange(len(data)), data).astype(np.float32)
        sr = 16000
    seconds = len(data) / sr
    # Moonshine's own budget heuristic (~6 tokens/sec) with headroom; the
    # library default truncates sub-second tails to zero tokens.
    max_new = max(24, math.ceil(seconds * 6) + 8)
    out = asr({"array": data, "sampling_rate": sr},
              generate_kwargs={"max_new_tokens": max_new})
    return {"text": (out.get("text") or "").strip()}
