# Relay Server Deployment

Deploy the vstunnel relay on a corporate server so phones and laptops communicate through it. No ports need to be opened on any laptop.

---

## Architecture

```
┌─────────────── CORPORATE NETWORK (VPN) ──────────────────────┐
│                                                                │
│  Phone (VPN)                                                  │
│    │  https://vstunnel.siemens.internal                       │
│    ▼                                                          │
│  ┌────────────────────────────────────────────┐               │
│  │  Relay Server (Docker container)            │               │
│  │  ├── Mobile UI (served at /)               │               │
│  │  ├── HTTP API  (/api/connect, /poll, /send)│               │
│  │  ├── WebSocket (/ws/laptop, /ws/phone)     │               │
│  │  └── Auth (per-user token)                 │               │
│  └────────────────────────────────────────────┘               │
│    ▲                                                          │
│    │  wss://vstunnel.siemens.internal/ws/laptop               │
│  Laptop Daemon (connects outbound)                            │
│    └── VS Code + Copilot                                      │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

All connections are **outbound** from both phone and laptop. The relay just routes messages between them.

---

## Quick Start (Docker)

### 1. Deploy the relay server

```bash
cd relay/

# Build and run
docker compose up -d

# Verify
curl http://localhost:8080/health
```

Or deploy to any Docker host:

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
```

### 2. Start the daemon on each developer's laptop

```bash
# Set relay URL and your user ID
export RELAY_URL=https://vstunnel.siemens.internal
export RELAY_USER_ID=z003vsvd

# Start daemon
python3 backend/daemon.py
```

The daemon will output:
```
Registered with relay as 'z003vsvd'
Phone auth token: a1b2c3d4e5f6...
Share this with your phone to connect:
  User ID: z003vsvd
  Token:   a1b2c3d4e5f6...
```

### 3. Connect from phone

1. Open `https://vstunnel.siemens.internal` on your phone browser
2. Your laptop appears in the user list
3. Paste the auth token from step 2
4. Select your laptop, choose a workspace, send prompts

---

## Environment Variables

### Relay Server

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_PORT` | `8080` | Port to listen on |
| `RELAY_HOST` | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | `INFO` | Logging level |
| `FRONTEND_DIR` | `../frontend` | Path to frontend static files |

### Laptop Daemon (relay mode)

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_URL` | (none) | Relay server URL. When set, enables relay client mode |
| `RELAY_USER_ID` | `$USER` | Your user ID shown to phones |
| `LOG_LEVEL` | `INFO` | Logging level |

---

## How It Works

### Message Flow

```
1. Laptop starts daemon with RELAY_URL set
   → Daemon connects to relay via WebSocket: /ws/laptop
   → Sends: {"type": "REGISTER", "user_id": "z003vsvd", "workspaces": [...]}
   → Relay responds with auth token

2. Phone opens relay URL in browser
   → Fetches user list: GET /api/users
   → Sees "z003vsvd" online
   → Authenticates: POST /api/connect?user=z003vsvd&token=...
   → Gets polling session ID

3. Phone sends prompt
   → POST /api/send (with session ID)
   → Relay forwards to laptop's WebSocket
   → Laptop executes VS Code command
   → Response flows back: Laptop → Relay → Phone
```

### Security

- **Token auth**: Each laptop generates a random token on registration. Phones must present this token to connect. Token is shown in the daemon terminal output.
- **No data storage**: The relay only forwards messages. Prompts and responses are never persisted.
- **Network isolation**: All traffic stays within the corporate VPN.
- **Per-user isolation**: A phone can only reach the laptop it authenticated to.

---

## Production Deployment

### Behind nginx (TLS termination)

```nginx
server {
    listen 443 ssl;
    server_name vstunnel.siemens.internal;

    ssl_certificate     /etc/ssl/certs/internal.pem;
    ssl_certificate_key /etc/ssl/private/internal.key;

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

### DNS

```
vstunnel.siemens.internal → 10.x.x.x (relay server IP)
```

### Firewall

```
Inbound: Port 443 from VPN CIDR (10.0.0.0/8)
Outbound: None needed
```

---

## Cost

| Component | Spec | Monthly Cost |
|-----------|------|-------------|
| EC2 instance | t4g.small (2 vCPU, 2GB) | ~$12 |
| EBS storage | 20GB gp3 | ~$2 |
| Data transfer | VPC internal | $0 |
| **Total** | | **~$14/mo** |

On existing data center VM: **$0/mo**
