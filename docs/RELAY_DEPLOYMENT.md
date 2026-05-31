# Relay Server Deployment

Deploy the vstunnel relay on a corporate server. The relay routes events from VS Code extensions to phones and commands from phones back to extensions. No ports need to be opened on any laptop.

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
│  │  ├── WebSocket (/ws/laptop, /ws/phone)     │               │
│  │  ├── HTTP API  (/api/users, /api/connect)  │               │
│  │  ├── Event buffer (200 per instance)       │               │
│  │  └── Auth (per-user token)                 │               │
│  └────────────────────────────────────────────┘               │
│    ▲              ▲                                            │
│    │              │                                            │
│  Laptop A        Laptop B                                     │
│  (2 VS Code)    (1 VS Code)                                  │
│    inst_a1       inst_b1                                      │
│    inst_a2                                                    │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

All connections are **outbound** from both phones and laptops. The relay is a stateless message broker — it buffers events in memory but persists nothing to disk.

---

## Quick Start (Docker)

### 1. Deploy the relay server

```bash
cd relay/

# Build and run with docker-compose
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

### 2. Install the VS Code extension (on each developer laptop)

```bash
cd extension/
npm install
npm run compile
npx vsce package        # creates vstunnel-2.0.0.vsix
code --install-extension vstunnel-2.0.0.vsix
```

Configure in VS Code Settings (`Ctrl+,`):

```json
{
  "vstunnel.relayUrl": "https://vstunnel.siemens.internal",
  "vstunnel.userId": "z003vsvd",
  "vstunnel.autoStart": true
}
```

Start the bridge: `Ctrl+Shift+P` → **"vstunnel: Start Mobile Bridge"**

Output panel shows:
```
vstunnel: Connected to relay (https://vstunnel.siemens.internal)
vstunnel: Registered as 'z003vsvd'. Phone token: a1b2c3d4...
```

### 3. Connect from phone

1. Open `https://vstunnel.siemens.internal` on your phone browser
2. Select your username from the online user list
3. Enter the auth token from step 2
4. Monitor activity, review diffs, approve/reject requests, send prompts

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_PORT` | `8080` | Port to listen on |
| `RELAY_HOST` | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | `INFO` | DEBUG, INFO, WARNING, ERROR |
| `FRONTEND_DIR` | `../frontend` | Path to mobile UI static files |

---

## Multi-Instance Model

The relay supports multiple VS Code windows per user. Each window registers independently with a unique `instance_id`:

```
users["z003vsvd"] = {
    "token": "e93cf8ec...",
    "instances": {
        "inst_a1b2c3": InstanceSession(ws, "my-react-app", event_buffer),
        "inst_d4e5f6": InstanceSession(ws, "backend-api", event_buffer),
    }
}
```

- Each instance has its own event buffer (deque, max 200 events with sequence numbers)
- Events are tagged with `instance_id` and `workspace` name
- Commands from phones are routed to a specific instance
- Phone UI shows workspace tabs to switch between instances
- One auth token per user (not per instance)

---

## Message Flow

### Extension Registration

```
Extension connects to /ws/laptop
  → Sends: {"type": "REGISTER", "user_id": "z003vsvd",
             "instance_id": "inst_a1b2c3",
             "workspace_name": "my-react-app",
             "workspace_path": "/home/user/my-react-app"}
  → Relay responds: {"type": "REGISTERED", "token": "e93cf8ec..."}
```

### Event Streaming (Extension → Relay → Phone)

```
Copilot edits a file
  → Extension detects via onDidChangeTextDocument
  → Extension sends: {"type": "PUSH_EVENT", "event": {
       "type": "AGENT_ACTIVITY", "instance_id": "inst_a1b2c3",
       "workspace": "my-react-app", "seq": 42,
       "activity": {"type": "file_edit", "filePath": "src/App.tsx", ...}
    }}
  → Relay buffers the event (instance.event_buffer.append)
  → Relay forwards to all phones connected to this user
```

### Commands (Phone → Relay → Extension)

```
Phone sends prompt to specific instance
  → Phone WS: {"type": "INJECT_PROMPT", "instance_id": "inst_a1b2c3",
                "prompt": "Also add tests", "target": "active_session"}
  → Relay looks up instance by instance_id
  → Relay forwards to that extension's WebSocket
  → Extension executes the command
  → Extension responds: {"type": "COMMAND_RESULT", ...}
  → Relay forwards result back to phone
```

### Event Replay (Phone Reconnects)

```
Phone reconnects after network drop
  → Phone sends: {"type": "GET_EVENTS_SINCE",
                   "instance_id": "inst_a1b2c3", "since_seq": 35}
  → Relay returns all buffered events with seq > 35
  → Phone renders missed activities without gaps
```

---

## Health Check

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

---

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check |
| GET | `/ws/laptop` | Extension WebSocket connection |
| GET | `/ws/phone` | Phone WebSocket connection |
| GET | `/api/users` | List online users |
| GET | `/api/connect` | HTTP polling session (fallback) |
| GET | `/api/poll` | Drain messages (polling mode) |
| POST | `/api/send` | Send command (polling mode) |
| GET | `/` | Mobile UI (static files) |

---

## Production Deployment

### Behind nginx (TLS termination)

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

### DNS

```
vstunnel.siemens.internal → <relay server IP>
```

### Firewall

```
Inbound:  Port 443 from VPN CIDR
Outbound: None required
```

---

## Scaling

The relay is lightweight (single Python process, in-memory state):

- **Users**: Tested with 50+ concurrent users, each with 2-3 instances
- **Events**: 200 events buffered per instance = ~10MB total for 50 users
- **WebSocket connections**: aiohttp handles thousands of concurrent connections
- **Horizontal scaling**: Not needed for typical team sizes. For 100+ users, run multiple relay instances behind a load balancer with sticky sessions (each user pins to one relay)

---

## Updating

```bash
docker stop vstunnel-relay
docker rm vstunnel-relay

# Rebuild with latest code
docker build -f relay/Dockerfile -t vstunnel-relay .
docker run -d \
  --name vstunnel-relay \
  --restart unless-stopped \
  -p 8080:8080 \
  vstunnel-relay
```

Extensions reconnect automatically (exponential backoff, 2s → 30s max).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Extension can't connect | Relay not reachable | Check VPN, verify `curl <relay-url>/health` works |
| Phone shows no users | No extensions registered | Start extension bridge (`Ctrl+Shift+P` → "vstunnel: Start") |
| Events not appearing | WebSocket closed | Check relay logs (`docker logs vstunnel-relay`) |
| Token rejected | Wrong token for user | Token is shown in VS Code Output panel ("vstunnel" channel) |
| Stale data after reconnect | Missed events beyond buffer | Buffer holds 200 events; longer disconnects lose history |

---

## Cost

| Component | Spec | Monthly Cost |
|-----------|------|-------------|
| VM (relay) | t4g.small or equivalent | ~$12 (or $0 on existing infra) |
| Storage | 20GB | ~$2 |
| Data transfer | VPC internal | $0 |
| **Total** | | **$0 - $14/mo** |
