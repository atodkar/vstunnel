FROM python:3.11-slim

LABEL maintainer="vstunnel" \
      description="vstunnel Relay Server — corporate bridge for mobile Copilot access"

WORKDIR /app

COPY relay/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY relay/server.py /app/server.py
COPY frontend/ /app/frontend/

ENV RELAY_PORT=8080
ENV RELAY_HOST=0.0.0.0
ENV FRONTEND_DIR=/app/frontend
ENV LOG_LEVEL=INFO

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')"

CMD ["python3", "server.py"]
