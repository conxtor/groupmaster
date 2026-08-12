FROM debian:bookworm-slim AS whisper-builder
ARG WHISPER_CPP_VERSION=v1.8.1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates cmake g++ git make && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${WHISPER_CPP_VERSION} https://github.com/ggml-org/whisper.cpp.git /src/whisper.cpp
RUN cmake -S /src/whisper.cpp -B /src/whisper.cpp/build \
    -DWHISPER_BUILD_TESTS=OFF \
    -DWHISPER_BUILD_SERVER=OFF \
    -DGGML_NATIVE=OFF \
    -DGGML_CPU_ARM_ARCH=armv8-a \
    && cmake --build /src/whisper.cpp/build --config Release --target whisper-cli -j2
RUN mkdir -p /tmp/whisper-libs && find /src/whisper.cpp/build -type f -name 'lib*.so*' -exec cp {} /tmp/whisper-libs/ \;

FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg libgomp1 libstdc++6 poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-deu tesseract-ocr-spa tesseract-ocr-fra && rm -rf /var/lib/apt/lists/*
COPY --from=whisper-builder /src/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-builder /tmp/whisper-libs/ /usr/local/lib/
COPY apps/media-worker/ensure-whisper-model.sh /usr/local/bin/ensure-whisper-model
RUN chmod +x /usr/local/bin/ensure-whisper-model && ldconfig
COPY apps/media-worker/pyproject.toml ./
RUN pip install --no-cache-dir asyncpg nats-py boto3 pillow
COPY apps/media-worker/src ./src
ENTRYPOINT ["/usr/local/bin/ensure-whisper-model"]
CMD ["python", "-u", "src/worker.py"]
