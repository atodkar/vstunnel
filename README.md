# vstunnel

**Remote Copilot Agent Monitor & Control**

Monitor active GitHub Copilot sessions, review changes, accept/reject agent requests, and send follow-up prompts — all from your phone.

---

## The Problem

You start a Copilot agent task on your laptop and step away. The agent stalls waiting for approval, makes unwanted changes, or finishes without you knowing. You have no visibility until you're back at your desk.

## The Solution

**vstunnel** is a VS Code extension + relay server that streams Copilot's activity to your phone in real time. You see every file it edits, every command it runs, and can approve, reject, or redirect it remotely.

```
Phone  ──wss://──>  Relay Server  <──wss://──  VS Code Extension (per instance)
```

---

## Key Features

- **Activity Feed** — real-time stream of file edits, creates, deletes
- **Diff Viewer** — see exactly what Copilot changed (colored unified diff)
- **Prompt Injection** — send follow-up prompts into the active chat session
- **Approval Control** — accept/reject agent requests from your phone
- **Multi-Instance** — each VS Code window registers independently; switch between them on phone
- **Privacy-first** — all traffic stays on your corporate VPN, no external services

---

## Quick Start

### 1. Deploy the relay server (once, on a corporate VM)

```bash
cd relay/
docker build -f Dockerfile -t vstunnel-relay .
docker run -d --name vstunnel-relay --restart unless-stopped -p 8080:8080 vstunnel-relay

# Verify
curl http://<vm-ip>:8080/health
```

The relay also serves the mobile UI at `http://<vm-ip>:8080/`.

### 2. Install the VS Code extension (on each developer laptop)

```bash
cd extension/
npm install
npm run compile
npx vsce package        # creates vstunnel-2.0.0.vsix
code --install-extension vstunnel-2.0.0.vsix
```

### 3. Configure the extension

In VS Code Settings (`Ctrl+,`):

| Setting | Value | Description |
|---------|-------|-------------|
| `vstunnel.relayUrl` | `http://<vm-ip>:8080` | Relay server URL |
| `vstunnel.userId` | `your-username` | Shown to phone clients |
| `vstunnel.autoStart` | `true` | Start bridge on VS Code launch |

### 4. Start the bridge

`Ctrl+Shift+P` → **"vstunnel: Start Mobile Bridge"**

Output panel shows:
```
vstunnel: Connected to relay (http://<vm-ip>:8080)
vstunnel: Registered as 'your-username'. Phone token: a1b2c3d4...
```

### 5. Connect from phone

1. Open `http://<vm-ip>:8080` in your phone browser
2. Select your username from the user list
3. Enter the auth token from step 4
4. Monitor activity, review diffs, send prompts

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ DEVELOPER LAPTOP                                                     │
│                                                                      │
│  ┌─ VS Code (my-react-app) ──────────────────────┐                 │
│  │  Extension: CopilotMonitor + RelayClient       │                 │
│  │  instance_id: inst_a1b2c3                      │──┐              │
│  └────────────────────────────────────────────────┘  │              │
│                                                      │ outbound     │
│  ┌─ VS Code (backend-api) ───────────────────────┐  │ WebSocket    │
│  │  Extension: CopilotMonitor + RelayClient       │──┤              │
│  │  instance_id: inst_d4e5f6                      │  │              │
│  └────────────────────────────────────────────────┘  │              │
└──────────────────────────────────────────────────────┼──────────────┘
                                                       │
                                                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│ RELAY SERVER (corporate VM, Docker)                                    │
│  - Groups instances by user_id                                        │
│  - Buffers last 200 events per instance                               │
│  - Forwards events to phones, commands to instances                   │
│  - Serves mobile UI at /                                              │
└──────────────────────────────────────────────────────────────────────┘
                                                       │
                                                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│ PHONE (mobile browser)                                                │
│  [my-react-app] [backend-api]    ← workspace switcher                │
│  [Activity] [Diff] [Prompt]      ← content tabs                      │
│  [APPROVAL: "Run npm install?" [Accept] [Reject]]                    │
└──────────────────────────────────────────────────────────────────────┘
```

All connections are **outbound** from the laptop. No firewall ports needed.

---

## Project Layout

```
vstunnel/
├── extension/                 # VS Code Extension (primary)
│   ├── src/extension.ts       # Activation, command dispatch
│   ├── src/server.ts          # Local WebSocket server + event push
│   ├── src/relay-client.ts    # Outbound relay connection
│   ├── src/monitor/           # Copilot activity monitoring
│   │   ├── types.ts           # Shared interfaces
│   │   ├── file-tracker.ts    # File change detection
│   │   ├── diff-generator.ts  # Git diff polling
│   │   ├── prompt-injector.ts # Inject prompts into Copilot chat
│   │   └── index.ts           # CopilotMonitor facade
│   ├── src/views/             # Sidebar panels
│   └── package.json           # Extension manifest + config schema
├── relay/                     # Central Relay Server
│   ├── server.py              # aiohttp WebSocket broker
│   ├── Dockerfile             # Production container
│   └── docker-compose.yml     # Quick deploy
├── frontend/                  # Mobile Web UI (served by relay)
│   ├── index.html             # Tab-based SPA
│   ├── js/app.js              # WebSocket client + UI logic
│   └── css/styles.css         # Dark mobile-first design
├── backend/                   # Standalone Daemon (legacy/alternative)
│   ├── daemon.py              # Python WebSocket server
│   └── requirements.txt
└── docs/
    ├── ARCHITECTURE.md        # Technical design deep-dive
    ├── DEVELOPER_GUIDE.md     # Build, test, contribute
    ├── DEPLOYMENT.md          # Production deployment
    └── RELAY_DEPLOYMENT.md    # Relay-specific setup
```

---

## Configuration

### Extension Settings (VS Code)

| Setting | Default | Description |
|---------|---------|-------------|
| `vstunnel.relayUrl` | `""` | Relay server URL. When set, connects outbound. |
| `vstunnel.userId` | system username | Your ID shown to phone clients |
| `vstunnel.port` | `8080` | Local WebSocket port (direct mode) |
| `vstunnel.autoStart` | `false` | Start bridge on VS Code launch |
| `vstunnel.requireToken` | `true` | Require auth token for connections |

### Relay Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_PORT` | `8080` | Listen port |
| `RELAY_HOST` | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | `INFO` | Logging level |
| `FRONTEND_DIR` | `../frontend` | Path to mobile UI files |

---

## Security

- **Token auth**: Each extension instance gets a random token on registration. Phones must present it to connect.
- **No data storage**: Relay only forwards messages. Nothing is persisted.
- **Network isolation**: All traffic stays within corporate VPN.
- **Per-user isolation**: A phone can only reach instances belonging to the authenticated user.

---

## Legacy: Standalone Daemon

For environments where the extension can't be installed, the Python daemon still works:

```bash
cd backend/
pip install -r requirements.txt
export RELAY_URL=http://<vm-ip>:8080
export RELAY_USER_ID=your-username
python3 daemon.py
```

This connects to the relay the same way but uses process detection + CLI for VS Code interaction (less reliable than the extension approach).

---

## License

[MIT](LICENSE)
