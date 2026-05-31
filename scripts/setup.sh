#!/bin/bash
# vstunnel Setup Script - Install dependencies and configure environment

set -e

echo "🚀 vstunnel Setup"
echo "===================="

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

# Check Python availability
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is required but not installed. Please install Python 3.8+"
    exit 1
fi

echo -e "${BLUE}📦 Setting up Python backend...${NC}"

# Create virtual environment
if [ ! -d "backend/venv" ]; then
    python3 -m venv backend/venv
    echo "✅ Virtual environment created"
fi

# Activate virtual environment
source backend/venv/bin/activate

# Install dependencies
echo -e "${BLUE}📥 Installing Python dependencies...${NC}"
pip install --upgrade pip
pip install -r backend/requirements.txt
echo "✅ Python dependencies installed"

# Copy environment file
if [ ! -f "config/.env" ]; then
    cp config/.env.example config/.env
    echo "✅ Environment file created at config/.env"
else
    echo "ℹ️  config/.env already exists"
fi

echo ""
echo -e "${GREEN}✨ Setup complete!${NC}"
echo ""
echo "Next steps:"
echo "1. Start the daemon: ./scripts/start-daemon.sh"
echo "2. Forward port 8080 via VS Code Ports panel"
echo "3. Open frontend/index.html in a web browser"
echo ""
