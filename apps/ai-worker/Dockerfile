FROM python:3.12-slim
WORKDIR /app
COPY apps/ai-worker/pyproject.toml ./
RUN pip install --no-cache-dir asyncpg nats-py pydantic fastembed==0.5.1 httpx
COPY apps/ai-worker/src ./src
CMD ["python", "-u", "src/worker.py"]
