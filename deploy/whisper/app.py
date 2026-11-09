from __future__ import annotations

import os
import tempfile
import threading
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import PlainTextResponse
from starlette.concurrency import run_in_threadpool
from faster_whisper import WhisperModel

MODEL_NAME = os.getenv("ASR_MODEL", "base")
DEVICE = os.getenv("ASR_DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("ASR_COMPUTE_TYPE", "int8")
MAX_BYTES = int(os.getenv("ASR_MAX_BYTES", str(50 * 1024 * 1024)))

app = FastAPI(title="web-lair whisper", version="1")
_model: WhisperModel | None = None
# ctranslate2 models are not safe to call concurrently from several threads.
_lock = threading.Lock()


def model() -> WhisperModel:
    global _model
    if _model is None:
        _model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
    return _model


def vtt_time(seconds: float) -> str:
    millis = max(0, round(seconds * 1000))
    hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000)
    secs, millis = divmod(millis, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}"


def escape_cue(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def transcribe(path: str, task: str, language: str | None, vad_filter: bool):
    with _lock:
        segments, info = model().transcribe(
            path,
            task=task,
            language=language,
            vad_filter=vad_filter,
            beam_size=5,
        )
        rows = [
            {"start": segment.start, "end": segment.end, "text": segment.text.strip()}
            for segment in segments
            if segment.text.strip()
        ]
    return rows, info


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "loaded": _model is not None}


@app.post("/asr")
async def asr(
    audio_file: UploadFile = File(...),
    output: str = Query("json"),
    task: str = Query("transcribe"),
    language: str | None = Query(None),
    vad_filter: bool = Query(False),
):
    if task not in {"transcribe", "translate"}:
        raise HTTPException(status_code=400, detail="task must be transcribe or translate")
    payload = await audio_file.read(MAX_BYTES + 1)
    if not payload:
        raise HTTPException(status_code=400, detail="empty audio file")
    if len(payload) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="audio file too large")

    suffix = Path(audio_file.filename or "audio").suffix or ".audio"
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as handle:
            handle.write(payload)
            temp_path = handle.name
        language_arg = None if not language or language == "auto" else language
        rows, info = await run_in_threadpool(transcribe, temp_path, task, language_arg, vad_filter)
    finally:
        if temp_path:
            Path(temp_path).unlink(missing_ok=True)

    text = " ".join(row["text"] for row in rows).strip()
    if output == "text":
        return PlainTextResponse(text)
    if output == "vtt":
        cues = "\n\n".join(
            f"{vtt_time(row['start'])} --> {vtt_time(max(row['end'], row['start'] + 0.001))}\n"
            f"{escape_cue(row['text'])}"
            for row in rows
        )
        body = f"WEBVTT\n\n{cues}\n" if cues else "WEBVTT\n"
        return PlainTextResponse(body, media_type="text/vtt; charset=utf-8")

    return {
        "text": text,
        "segments": rows,
        "language": info.language,
        "language_probability": info.language_probability,
        "duration": info.duration,
    }
