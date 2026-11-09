FROM python:3.12-slim

# Build-time only; the proxy is not persisted in the runtime environment.
ARG HTTP_PROXY
ARG HTTPS_PROXY

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# PyAV (installed by faster-whisper) carries its own FFmpeg libraries, so the
# image does not need the apt package. Keeping apt out also makes the build
# reproducible on hosts whose Debian mirror is unreachable.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 9000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9000", "--workers", "1"]
