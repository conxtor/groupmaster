#!/bin/sh
set -eu

model_path="${WHISPER_MODEL_PATH:-/models/ggml-medium.bin}"
model_dir="$(dirname "$model_path")"
model_name="$(basename "$model_path")"
partial_path="${model_path}.part"

mkdir -p "$model_dir"
if [ ! -s "$model_path" ]; then
  echo "Downloading local whisper.cpp model $model_name ..."
  curl --fail --location --retry 3 --retry-all-errors \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${model_name}" \
    --output "$partial_path"
  test -s "$partial_path"
  mv "$partial_path" "$model_path"
fi

exec "$@"
