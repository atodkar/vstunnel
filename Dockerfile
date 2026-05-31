FROM python:3.11-slim AS runtime

LABEL maintainer="vstunnel contributors"
LABEL description="vstunnel Copilot Daemon - WebSocket server for mobile Copilot bridge"

WORKDIR /app

RUN adduser --disabled-password --gecos "" vstunnel

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/daemon.py .
COPY config/.env.example .env

RUN chown -R vstunnel:vstunnel /app

USER vstunnel

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')" || exit 1

ENV DAEMON_HOST=0.0.0.0
ENV DAEMON_PORT=8080
ENV LOG_LEVEL=INFO

CMD ["python3", "daemon.py"]
