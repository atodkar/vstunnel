<p align="center">
  <img src="docs/assets/banner.png" alt="vstunnel" width="600" />
</p>

<h1 align="center">vstunnel</h1>

<p align="center">
  <strong>Privacy-first mobile remote control for GitHub Copilot</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="docs/USER_GUIDE.md">User Guide</a> &middot;
  <a href="docs/DEVELOPER_GUIDE.md">Developer Guide</a> &middot;
  <a href="docs/ARCHITECTURE.md">Architecture</a> &middot;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/python-3.8%2B-blue.svg" alt="Python 3.8+" />
  <img src="https://img.shields.io/badge/platform-linux%20%7C%20macos%20%7C%20windows-lightgrey.svg" alt="Platform" />
  <img src="https://img.shields.io/badge/cost-%240%2Fmo-brightgreen.svg" alt="$0/mo" />
</p>

---

## The Problem

You kick off a long Copilot generation, test suite, or AI agent on your laptop. You step away. The process stalls waiting for human approval — and you don't know until you're back at your desk.

## The Solution

**vstunnel** is a lightweight companion that lets you monitor and send prompts to your desktop VS Code / Copilot session from any mobile browser. Your source code never leaves your machine.

```
Phone  ──wss://──►  GitHub Tunnel  ──►  Local Daemon  ──►  VS Code Copilot
```

---

## Key Principles

| Principle | How |
|---|---|
| **Privacy-first** | Code never transits third-party servers. All traffic stays in your encrypted tunnel. |
| **Zero cost** | Reuses VS Code's built-in tunnel infrastructure. No subscriptions, no cloud bills. |
| **No native app** | Mobile UI is a static web page — no App Store, no install. |
| **Minimal footprint** | One Python file, zero build step, two dependencies. |

---

## Quick Start

### Prerequisites

- Python 3.8+
- VS Code (any recent version with built-in port forwarding)
- A GitHub account (for tunnel auth)

### 1. Clone & install

```bash
git clone https://github.com/atodkar/vstunnel.git
cd vstunnel
make setup        # or: ./scripts/setup.sh
```

### 2. Start the daemon

```bash
make run          # or: ./scripts/start-daemon.sh
```

### 3. Expose via VS Code tunnel

1. Open **VS Code** on your laptop.
2. Open the **Ports** panel (`Ctrl+Shift+P` → "Ports: Focus on Ports View").
3. Forward port **8080** and set visibility to **Public**.
4. Copy the generated URL (e.g. `https://abcdef.githubdev.dev`).

### 4. Connect from your phone

1. Open the mobile UI — either locally (`frontend/index.html`) or your deployed URL.
2. Paste the tunnel URL.
3. Tap **Connect**. Start sending prompts.

---

## Project Layout

```
vstunnel/
├── extension/               # VS Code Extension (recommended for users)
│   ├── src/extension.ts     # Extension entry point
│   ├── src/server.ts        # Embedded WebSocket server
│   ├── src/views/           # Sidebar panels (status, history)
│   └── package.json         # Extension manifest
├── backend/                 # Standalone Python Daemon (alternative)
│   ├── daemon.py            # Async WebSocket server + workspace detection
│   └── requirements.txt
├── frontend/                # Mobile PWA
│   ├── index.html           # SPA with workspace picker
│   ├── css/styles.css       # Mobile-first responsive UI
│   └── js/app.js            # WebSocket client + multi-instance support
├── docs/
│   ├── USER_GUIDE.md        # End-user step-by-step
│   ├── DEVELOPER_GUIDE.md   # Developer onboarding
│   ├── ARCHITECTURE.md      # Technical design
│   ├── SCALING.md           # Scaling to many users
│   └── DEPLOYMENT.md        # Production deployment
├── Dockerfile
├── docker-compose.yml
├── Makefile
├── CONTRIBUTING.md
├── CHANGELOG.md
└── LICENSE                   # MIT
```

---

## How It Works

```
┌──────────── INTERNET ───────────────────────────────────────────┐
│                                                                   │
│  [ Phone Browser ]                                               │
│        │  wss://                                                  │
│        ▼                                                         │
│  [ GitHub Dev Tunnel ]  ◄── TLS 1.3, GitHub-authenticated       │
│        │                                                         │
└────────┼─────────────────────────────────────────────────────────┘
         │
┌────────▼──────── YOUR LAPTOP ────────────────────────────────────┐
│                                                                   │
│  [ vstunnel daemon ]  (localhost:8080)                           │
│        │                                                         │
│        │  subprocess: code --inline-chat "..."                   │
│        ▼                                                         │
│  [ VS Code + Copilot Extension ]                                │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

1. The **daemon** runs a WebSocket server on `localhost:8080`.
2. VS Code's **port forwarding** wraps it in a public TLS URL.
3. Your **phone** connects over `wss://` through that tunnel.
4. Prompts arrive at the daemon, which calls the VS Code CLI.
5. Status updates stream back to the phone in real time.

Full technical breakdown: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

---

## Configuration

Copy the example and edit as needed:

```bash
cp config/.env.example config/.env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `DAEMON_HOST` | `localhost` | Bind address |
| `DAEMON_PORT` | `8080` | WebSocket listen port |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR` |

---

## Deployment Options

| Method | Use Case | Guide |
|--------|----------|-------|
| **Local** | Personal dev machine | This README |
| **Docker** | Isolated environment | `docker compose up` |
| **systemd** | Linux always-on | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#systemd-service-linux) |
| **launchd** | macOS always-on | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#launchagent-macos) |
| **Vercel** | Host mobile UI publicly | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#cloud-deployment) |

---

## Health Check

The daemon exposes an HTTP health endpoint:

```bash
curl http://localhost:8080/health
```

```json
{
  "status": "healthy",
  "version": "1.1.0",
  "uptime": 3600,
  "connected_clients": 1,
  "vscode_available": true
}
```

---

## Security

- All traffic encrypted via TLS (GitHub tunnel infrastructure).
- Source code **never** leaves your machine — only prompts transit.
- No telemetry, no analytics, no tracking.
- Tunnel URLs are authenticated via your GitHub account.
- Daemon binds to `localhost` only — not reachable without the tunnel.

See [docs/ARCHITECTURE.md#security-model](docs/ARCHITECTURE.md#security-model) for threat analysis.

---

## FAQ

<details>
<summary><strong>Is my source code exposed?</strong></summary>

No. Only the prompt text you type on your phone travels through the tunnel. Your codebase stays on your machine.
</details>

<details>
<summary><strong>What happens if the tunnel disconnects?</strong></summary>

The mobile UI detects the drop and auto-reconnects. If the tunnel URL expired, regenerate it in VS Code's Ports panel.
</details>

<details>
<summary><strong>Does this cost anything?</strong></summary>

No. VS Code tunnels are free. The daemon runs on your existing hardware. The mobile UI can be hosted on any free static host.
</details>

<details>
<summary><strong>Can multiple phones connect?</strong></summary>

Yes. The daemon accepts multiple concurrent WebSocket connections.
</details>

<details>
<summary><strong>Do I need GitHub Copilot?</strong></summary>

Yes — the daemon triggers Copilot via VS Code's inline chat CLI. An active Copilot subscription is required.
</details>

---

## Two Ways to Run

### Option A: VS Code Extension (Recommended for most users)

One-click install, zero setup, auto-starts with VS Code:

```bash
# Install from Marketplace (coming soon)
code --install-extension vstunnel.vstunnel

# Or build from source:
cd extension
npm install && npm run compile
```

The extension:
- Embeds the WebSocket server inside VS Code (no separate process)
- Directly calls Copilot via the VS Code API (not CLI hacks)
- Auto-forwards the port
- Shows a QR code for instant mobile pairing
- Handles multi-instance natively (one extension per window)
- Supports token-based authentication

### Option B: Standalone Python Daemon (Power users / self-hosters)

For users who want full control or can't install extensions:

```bash
make setup && make run
```

---

## Scaling to Many Users

vstunnel is designed to be **federated**: each user's laptop is its own server. This means:

- **100 users = same infrastructure cost as 1 user ($0)**
- Extension distributed via VS Code Marketplace (free)
- Mobile UI hosted as static PWA on Vercel (free)
- Optional pairing service for easy connection (~$5/mo for 50,000 users)

See **[docs/SCALING.md](docs/SCALING.md)** for the full scaling architecture, revenue model, and implementation roadmap.

---

## Contributing

We welcome contributions of all kinds. Please read **[CONTRIBUTING.md](CONTRIBUTING.md)** before submitting a PR.

**Good first issues:**
- Improve mobile UI accessibility
- Add unit tests for the daemon
- Support alternative VS Code forks (Cursor, VSCodium)
- Add i18n to the frontend
- Help publish the extension to the Marketplace

---

## License

[MIT](LICENSE) — free for personal and commercial use.

---

<p align="center">
  Built for developers who code from everywhere.
</p>
