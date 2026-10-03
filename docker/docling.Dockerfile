# syntax=docker/dockerfile:1
# Docling parse service (python/docling_service). No VLM, no OCR models.
#
#   docker build -f docker/docling.Dockerfile --target test .   # full pytest suite, network disabled
#   docker build -f docker/docling.Dockerfile -t mf-rag-docling .
#
# The build needs Hugging Face access (models stage); the runtime is offline.

FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_NO_CACHE=1
# opencv-python (a docling dependency) needs libGL/glib at import time.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.11.3 /uv /usr/local/bin/uv
COPY python/docling_service/requirements.lock /tmp/requirements.lock
RUN uv pip install --system --torch-backend cpu -r /tmp/requirements.lock

FROM base AS models
# layout (docling-layout-heron), tableformer (docling-models), picture_classifier
# (DocumentFigureClassifier-v2.5); the onnx layout variant is unused (transformers engine).
RUN docling-tools models download layout tableformer picture_classifier -o /opt/docling-models \
  && rm -rf /opt/docling-models/docling-project--docling-layout-heron-onnx \
  && python -c "from transformers import AutoTokenizer; AutoTokenizer.from_pretrained('BAAI/bge-m3').save_pretrained('/opt/docling-models/bge-m3-tokenizer')"

FROM base AS app
COPY --from=models /opt/docling-models /opt/docling-models
ENV DOCLING_MODELS_DIR=/opt/docling-models \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    DOCLING_HTTP_THREADS=12 \
    PORT=8090
WORKDIR /srv/python
COPY python/docling_service /srv/python/docling_service
RUN useradd --system --uid 10001 --no-create-home docling

FROM app AS test
COPY python/docling_service/requirements-dev.txt /tmp/requirements-dev.txt
RUN uv pip install --system -r /tmp/requirements-dev.txt
COPY tests/fixtures/docling /srv/tests/fixtures/docling
USER docling
# --network=none proves the suite (incl. real model conversion) needs no network.
RUN --network=none cd /srv/python/docling_service && python -m pytest -p no:cacheprovider -rs

FROM app AS runtime
USER docling
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ['PORT'], timeout=4)"
# One process (models loaded once, ~4 GiB peak per conversion), gthread so /health
# answers during a conversion; the app converts one parse at a time and queues the rest.
CMD ["sh", "-c", "exec gunicorn -k gthread -w 1 --threads ${DOCLING_HTTP_THREADS} -b 0.0.0.0:${PORT} --timeout 3600 --graceful-timeout 30 'docling_service.app:create_app()'"]
