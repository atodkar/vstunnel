# Deployment Guide

Production deployment for vstunnel.

---

## Overview

vstunnel has three components to deploy:

| Component | Where | How |
|-----------|-------|-----|
| Relay Server | Corporate VM / data center | Docker container |
| VS Code Extension | Each developer's laptop | .vsix install |
| Mobile UI | Served by relay at `/` | No separate deploy needed |

---

## 1. Relay Server Deployment

### Docker (recommended)

```bash
# Build from project root
docker build -f relay/Dockerfile -t vstunnel-relay .

# Run
docker run -d \
  --name vstunnel-relay \
  --restart unless-stopped \
  -p 8080:8080 \
  -e LOG_LEVEL=INFO \
  vstunnel-relay

# Verify
curl http://localhost:8080/health
```

Or using docker-compose:

```bash
cd relay/
docker compose up -d
```

### Behind nginx (TLS termination)

For HTTPS access (recommended for production):

```nginx
server {
    listen 443 ssl;
    server_name vstunnel.siemens.internal;

    ssl_certificate     /etc/ssl/certs/vstunnel.pem;
    ssl_certificate_key /etc/ssl/private/vstunnel.key;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }
}
```

Then configure DNS: `vstunnel.siemens.internal → <VM IP>`

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_PORT` | `8080` | Listen port |
| `RELAY_HOST` | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | `INFO` | DEBUG, INFO, WARNING, ERROR |
| `FRONTEND_DIR` | `../frontend` | Path to mobile UI static files |

### Health Check

```bash
curl http://localhost:8080/health
```

Returns:
```json
{
  "status": "healthy",
  "version": "2.0.0",
  "uptime": 3600,
  "registered_users": 3,
  "registered_instances": 5,
  "poll_sessions": 1,
  "total_prompts": 42
}
```

### Firewall Rules

```
Inbound:  Port 443 (or 8080) from VPN CIDR
Outbound: None required
```

---

## 2. VS Code Extension Installation

### From .vsix package

```bash
# Build the package
cd extension/
npm install
npm run compile
npx vsce package
# Output: vstunnel-2.0.0.vsix

# Install
code --install-extension vstunnel-2.0.0.vsix
```

### From source (dev install)

```bash
cd extension/
npm install
npm run compile
```

Then in VS Code: `Ctrl+Shift+P` → "Developer: Install Extension from Location..." → select `extension/` folder.

### Configuration

After installing, open VS Code Settings (`Ctrl+,`) and set:

```json
{
  "vstunnel.relayUrl": "http://vstunnel.siemens.internal:8080",
  "vstunnel.userId": "z003vsvd",
  "vstunnel.autoStart": true
}
```

Or via `Ctrl+Shift+P` → "Preferences: Open Settings (JSON)".

### Verify

1. `Ctrl+Shift+P` → "vstunnel: Start Mobile Bridge"
2. Check Output panel (select "vstunnel" channel)
3. Should show: `Connected to relay` and auth token

---

## 3. Mobile UI

The mobile UI is **served by the relay server** at the root path `/`. No separate deployment is needed.

When you deploy the relay Docker container, the frontend files are bundled inside and served automatically.

**Accessing:** Open `http://<relay-host>:8080/` (or `https://vstunnel.siemens.internal/` with nginx) on any browser.

---

## Multi-User Setup

Each developer:
1. Installs the extension
2. Sets `vstunnel.relayUrl` to the shared relay
3. Sets `vstunnel.userId` to their username

The relay handles multiple users. Each user's phone only sees their own instances (token-authenticated).

---

## Updating

### Relay

```bash
docker stop vstunnel-relay
docker rm vstunnel-relay
# Rebuild with latest code:
docker build -f relay/Dockerfile -t vstunnel-relay .
docker run -d --name vstunnel-relay --restart unless-stopped -p 8080:8080 vstunnel-relay
```

### Extension

```bash
cd extension/
npm run compile
npx vsce package
code --install-extension vstunnel-2.0.0.vsix --force
```

Restart VS Code after updating.

---

## Cost

| Component | Spec | Monthly Cost |
|-----------|------|-------------|
| VM (relay) | t4g.small or equivalent | ~$12 (or $0 on existing infra) |
| Storage | 20GB | ~$2 |
| Data transfer | VPC internal | $0 |
| Extension | Per laptop | $0 |
| Mobile UI | Served by relay | $0 |
| **Total** | | **$0 - $14/mo** |
