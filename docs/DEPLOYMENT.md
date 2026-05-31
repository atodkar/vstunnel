# vstunnel - Deployment Guide

Complete guide for deploying vstunnel in different environments.

## Local Development

### Prerequisites
- Python 3.8+
- VS Code with Remote Tunnels (built-in)
- Git

### Installation Steps

```bash
# 1. Clone/download vstunnel
git clone https://github.com/yourusername/vstunnel.git
cd vstunnel

# 2. Run setup script
chmod +x scripts/*.sh
./scripts/setup.sh

# 3. Start the daemon
./scripts/start-daemon.sh

# Output should show:
# 🚀 vstunnel Daemon v1.0.0
# 📡 Running on localhost:8080
# 👉 Next: Forward port 8080 via VS Code Ports panel
```

### VS Code Port Forwarding

1. Open VS Code
2. Terminal → Ports (or Cmd+Shift+P → Forward a Port)
3. Enter port: `8080`
4. Right-click entry → Set Label: "vstunnel"
5. Right-click entry → Port Visibility → Public
6. Copy generated URL

### Mobile Connection

1. Open mobile browser
2. Navigate to `file:///path/to/vstunnel/frontend/index.html`
   - Or deploy to Vercel (see cloud deployment)
3. Paste tunnel URL (format: `abc123.githubdev.dev`)
4. Click "Connect to Daemon"
5. Start sending prompts!

---

## Docker Deployment

### Dockerfile

```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy application
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/daemon.py .
COPY config/.env .env

# Expose port
EXPOSE 8080

# Run daemon
CMD ["python3", "daemon.py"]
```

### Build and Run

```bash
# Build image
docker build -t vstunnel:latest .

# Run container with port mapping
docker run -p 8080:8080 \
  -e DAEMON_HOST=0.0.0.0 \
  -e DAEMON_PORT=8080 \
  vstunnel:latest

# Or use docker-compose
docker-compose up -d
```

### docker-compose.yml

```yaml
version: '3.8'

services:
  vstunnel:
    build: .
    ports:
      - "8080:8080"
    environment:
      DAEMON_HOST: 0.0.0.0
      DAEMON_PORT: 8080
      LOG_LEVEL: INFO
    restart: unless-stopped
    volumes:
      - ./config/.env:/app/.env:ro
```

---

## Cloud Deployment

### Frontend on Vercel/Netlify

**Vercel Deployment:**

```bash
# 1. Install Vercel CLI
npm install -g vercel

# 2. Deploy frontend
cd frontend
vercel deploy --prod

# 3. Your frontend now at: https://vstunnel.vercel.app
```

**vercel.json** (in frontend root):
```json
{
  "buildCommand": "exit 0",
  "outputDirectory": "."
}
```

### Backend Considerations

**Important**: The daemon should ONLY run on your local machine. Never expose it to the internet.

- ❌ Do NOT deploy daemon to cloud
- ✅ Do run daemon locally behind VS Code tunnels
- ✅ Do deploy frontend to CDN/static hosting
- ✅ Tunnel provides secure relay without exposing daemon

---

## Systemd Service (Linux)

Create `/etc/systemd/user/vstunnel.service`:

```ini
[Unit]
Description=vstunnel Copilot Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/username/vstunnel
Environment="PATH=/home/username/vstunnel/backend/venv/bin:/usr/local/bin:/usr/bin"
ExecStart=/home/username/vstunnel/scripts/start-daemon.sh
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

**Enable and start:**
```bash
systemctl --user enable vstunnel
systemctl --user start vstunnel

# Check status
systemctl --user status vstunnel

# View logs
journalctl --user -u vstunnel -f
```

---

## LaunchAgent (macOS)

Create `~/Library/LaunchAgents/com.vstunnel.daemon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.vstunnel.daemon</string>
    
    <key>ProgramArguments</key>
    <array>
        <string>/Users/username/vstunnel/scripts/start-daemon.sh</string>
    </array>
    
    <key>WorkingDirectory</key>
    <string>/Users/username/vstunnel</string>
    
    <key>RunAtLoad</key>
    <true/>
    
    <key>KeepAlive</key>
    <true/>
    
    <key>StandardOutPath</key>
    <string>/tmp/vstunnel.log</string>
    
    <key>StandardErrorPath</key>
    <string>/tmp/vstunnel.err</string>
</dict>
</plist>
```

**Install and start:**
```bash
launchctl load ~/Library/LaunchAgents/com.vstunnel.daemon.plist

# Check status
launchctl list | grep vstunnel

# View logs
tail -f /tmp/vstunnel.log
```

---

## Windows Deployment

### Using Task Scheduler

**Create start script** `vstunnel-start.vbs`:
```vbscript
Set objWshShell = CreateObject("WScript.Shell")
objWshShell.Run "cmd.exe /c cd C:\Users\YourName\vstunnel && venv\Scripts\python.exe backend\daemon.py", 0
```

**Create Task:**
1. Open Task Scheduler
2. Create Basic Task → Name: "vstunnel Daemon"
3. Trigger: "At startup"
4. Action: Start program → `vstunnel-start.vbs`
5. Options: ✓ Run whether user is logged in or not

---

## Production Checklist

- [ ] Dependencies installed via requirements.txt
- [ ] Environment variables configured in .env
- [ ] Port 8080 available (or configured alternative)
- [ ] VS Code tunnel forward created and verified
- [ ] Frontend deployed to CDN (if using remote)
- [ ] Daemon started and listening
- [ ] Mobile device can reach tunnel URL
- [ ] Test prompt execution end-to-end
- [ ] Logs monitored for errors
- [ ] Auto-restart configured (systemd/launchd/Task Scheduler)

---

## Troubleshooting Deployments

### Daemon Won't Start
```bash
# Check Python version
python3 --version  # Should be 3.8+

# Check virtual environment
source backend/venv/bin/activate
python3 -c "import websockets; print(websockets.__version__)"

# Check port availability
lsof -i :8080  # Kill if needed: kill -9 <PID>
```

### Connection Timeout
```bash
# Verify tunnel is active in VS Code
# Check firewall allows port 8080
# Verify tunnel URL in mobile browser

# Test from command line
curl -v wss://your-tunnel.githubdev.dev
```

### Memory Leak
```bash
# Monitor daemon memory usage
watch -n 1 'ps aux | grep daemon.py'

# Add memory limits (systemd)
# In service file add:
# MemoryMax=500M
```

---

## Monitoring

### Log Monitoring
```bash
# Real-time logs
journalctl --user -u vstunnel -f

# Last 50 lines
journalctl --user -u vstunnel -n 50
```

### Health Check Script
```bash
#!/bin/bash
# Check if daemon is responsive
if nc -z localhost 8080; then
    echo "✅ Daemon is running"
else
    echo "❌ Daemon is not responsive - restarting..."
    systemctl --user restart vstunnel
fi
```

### Uptime Monitoring
```bash
# Add to cron for periodic health checks
*/5 * * * * /path/to/check-vstunnel-health.sh
```

---

## Migration & Updates

### Backing Up Configuration
```bash
# Save tunnel URL and settings
cp config/.env config/.env.backup
```

### Updating vstunnel
```bash
cd vstunnel

# Fetch latest
git pull origin main

# Reinstall dependencies (in case of updates)
source backend/venv/bin/activate
pip install -r backend/requirements.txt --upgrade

# Restart daemon
systemctl --user restart vstunnel  # or your restart method
```

### Rollback
```bash
# Restore previous version
git checkout <previous-commit>

# Restart
systemctl --user restart vstunnel
```

---

**Last Updated**: 2026-05-30
**Version**: 1.0.0 Deployment Guide
