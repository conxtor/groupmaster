FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir nats-py
COPY provision.py ./provision.py
CMD ["python", "-u", "provision.py"]
