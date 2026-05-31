#!/bin/bash
# vstunnel Daemon Start Script

set -e

echo "🚀 vstunnel Daemon Launcher"
echo "============================"

# Check if virtual environment exists
if [ ! -d "backend/venv" ]; then
    echo "❌ Virtual environment not found. Run './scripts/setup.sh' first."
    exit 1
fi

# Activate virtual environment
source backend/venv/bin/activate

# Load environment variables
if [ -f "config/.env" ]; then
    export $(cat config/.env | xargs)
fi

# Start daemon
echo "📡 Starting vstunnel daemon..."
echo "Port: ${DAEMON_PORT:-8080}"
echo "Host: ${DAEMON_HOST:-localhost}"
echo ""
echo "👉 Next: Open VS Code Ports panel and forward port ${DAEMON_PORT:-8080}"
echo "👉 Set visibility to 'Public' to generate tunnel URL"
echo ""

python3 backend/daemon.py
