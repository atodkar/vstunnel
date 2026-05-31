# Developer Guide: Working with vstunnel

This guide is for developers who are seeing this codebase for the first time and want to understand, run, modify, or contribute to it.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Prerequisites](#prerequisites)
3. [Step-by-Step Setup](#step-by-step-setup)
4. [Project Structure Explained](#project-structure-explained)
5. [How the Code Works](#how-the-code-works)
6. [Running Locally](#running-locally)
7. [Making Changes](#making-changes)
8. [Testing](#testing)
9. [Debugging](#debugging)
10. [Common Development Tasks](#common-development-tasks)
11. [Architecture Decisions](#architecture-decisions)

---

## Project Overview

**vstunnel** is a tool that lets you send text prompts to GitHub Copilot on your laptop from a mobile phone browser. It has three parts:

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  PHONE                    INTERNET              LAPTOP      │
│                                                             │
│  ┌──────────┐        ┌──────────────┐     ┌────────────┐  │
│  │ Frontend │──wss──►│ VS Code      │────►│ Backend    │  │
│  │ (HTML/JS)│        │ Tunnel       │     │ (Python)   │  │
│  └──────────┘        └──────────────┘     └─────┬──────┘  │
│                                                   │         │
│                                             ┌─────▼──────┐  │
│                                             │ VS Code    │  │
│                                             │ + Copilot  │  │
│                                             └────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

- **Frontend** (`frontend/`): Static HTML/CSS/JS page that runs in the phone browser. Connects to the backend via WebSocket.
- **Backend** (`backend/`): Python async server that receives prompts and calls the VS Code CLI.
- **Transport**: VS Code's built-in port forwarding (we don't manage this — VS Code does).

---

## Prerequisites

Install these before starting:

| Tool | Version | How to Check | Install |
|------|---------|-------------|---------|
| Python | 3.8+ | `python3 --version` | [python.org](https://python.org/downloads) |
| pip | Any | `pip3 --version` | Comes with Python |
| Git | Any | `git --version` | [git-scm.com](https://git-scm.com) |
| VS Code | Recent | `code --version` | [code.visualstudio.com](https://code.visualstudio.com) |
| Make | Any | `make --version` | Pre-installed on macOS/Linux; Windows: use Git Bash |

Optional but recommended:
| Tool | Purpose |
|------|---------|
| Docker | Run containerized builds |
| curl | Test health endpoint |
| jq | Pretty-print JSON responses |

---

## Step-by-Step Setup

### 1. Clone the repository

```bash
git clone https://github.com/atodkar/vstunnel.git
cd vstunnel
```

### 2. Run the setup

```bash
make setup
```

This runs `scripts/setup.sh`, which does:
1. Checks Python 3 exists
2. Creates a virtual environment at `backend/venv/`
3. Installs production dependencies (`aiohttp`, `python-dotenv`)
4. Copies `config/.env.example` → `config/.env`

### 3. Install dev dependencies

```bash
source backend/venv/bin/activate
pip install -r backend/requirements-dev.txt
```

This adds: `pytest`, `pytest-asyncio`, `black`, `flake8`

### 4. Verify everything works

```bash
# Run the daemon
make run-dev

# In another terminal, check health:
curl http://localhost:8080/health
```

Expected output:
```json
{
  "status": "healthy",
  "version": "1.3.0",
  "uptime": 5,
  "connected_clients": 0,
  "poll_sessions": 0,
  "vscode_available": true,
  "transport": ["websocket", "polling"]
}
```

### 5. Run the tests

```bash
make test
```

### 6. Run the linter

```bash
make lint
```

**You're set up.** Now let's understand the code.

---

## Project Structure Explained

```
vstunnel/
│
├── backend/                     ← Python server (the "brain")
│   ├── daemon.py               ← Main entry point. THE file that runs.
│   ├── requirements.txt        ← Production dependencies
│   ├── requirements-dev.txt    ← Dev/test dependencies
│   └── tests/
│       ├── __init__.py
│       └── test_daemon.py      ← Unit tests
│
├── frontend/                    ← Phone web UI (static files)
│   ├── index.html              ← Page structure
│   ├── css/styles.css          ← Visual styling
│   ├── js/app.js              ← Connection logic (HTTP-first + WS upgrade)
│   ├── package.json            ← Metadata for deployment tools
│   └── vercel.json             ← Vercel deployment config
│
├── config/
│   └── .env.example            ← Default env vars (copied to .env on setup)
│
├── scripts/
│   ├── setup.sh                ← One-time install script
│   └── start-daemon.sh         ← Daemon launcher (activates venv, loads env)
│
├── docs/                        ← Documentation
│   ├── USER_GUIDE.md           ← End-user instructions
│   ├── DEVELOPER_GUIDE.md      ← This file
│   ├── ARCHITECTURE.md         ← Technical design deep-dive
│   └── DEPLOYMENT.md           ← Production deployment options
│
├── .github/                     ← GitHub-specific configs
│   ├── workflows/ci.yml        ← CI pipeline (tests + Docker)
│   ├── ISSUE_TEMPLATE/         ← Bug/feature request forms
│   └── PULL_REQUEST_TEMPLATE.md
│
├── Dockerfile                   ← Container build instructions
├── docker-compose.yml           ← Docker orchestration
├── Makefile                     ← Developer command shortcuts
├── README.md                    ← Project landing page
├── CONTRIBUTING.md              ← How to contribute
├── CHANGELOG.md                 ← Version history
├── CODE_OF_CONDUCT.md           ← Community standards
├── LICENSE                      ← MIT license
├── .gitignore                   ← Files Git should ignore
└── .editorconfig                ← Editor formatting rules
```

---

## How the Code Works

### Backend: `backend/daemon.py`

This is the only Python file that matters. Here's what it does, section by section:

#### Startup (`main()`)

```python
async def main():
    port = int(os.getenv("DAEMON_PORT", "8080"))
    host = os.getenv("DAEMON_HOST", "localhost")
    state.vscode_available = check_vscode_cli()
    
    app = create_app()  # aiohttp app with HTTP + WebSocket routes
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()
    await state.shutdown_event.wait()
```

1. Reads config from environment variables
2. Checks if `code` CLI is in PATH
3. Creates an aiohttp app (serves HTTP API, WebSocket, and frontend static files)
4. Waits forever (until SIGTERM/SIGINT)

#### WebSocket handler (`handle_websocket()`)

```python
async def handle_websocket(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    # 1. Register client
    # 2. Send WELCOME message
    # 3. Start background status streaming task
    # 4. Loop: receive messages, route by type
    # 5. On disconnect: cleanup
```

Each phone that connects via WebSocket gets its own instance of this function running concurrently.
Phones that cannot use WebSocket use the HTTP polling API instead (`/api/connect`, `/api/poll`, `/api/send`).

#### Message types the daemon understands:

| Client sends | Daemon responds with | Effect |
|------|------|--------|
| `{"type": "PROMPT", "payload": "..."}` | `{"type": "PROMPT_ACK", "result": {...}}` | Runs `code --inline-chat "..."` |
| `{"type": "PING"}` | `{"type": "PONG"}` | Keep-alive check |
| `{"type": "HISTORY"}` | `{"type": "HISTORY_RESPONSE", "history": [...]}` | Returns last 20 prompts |

#### VS Code execution (`execute_vscode_command()`)

```python
process = await asyncio.create_subprocess_exec(
    "code", "--inline-chat", prompt, ...
)
```

Literally calls the `code` binary as a subprocess. Simple and reliable.

#### Health check endpoint

The daemon also handles plain HTTP `GET /health` requests (not WebSocket) for monitoring tools.

---

### Frontend: `frontend/js/app.js`

Single class: `VSTunnelClient`

```javascript
class VSTunnelClient {
    constructor()           // Set up DOM references and event listeners
    connect()               // Validate input, create WebSocket
    connectToWebSocket(url) // Transform URL to wss://, connect
    onConnected()           // Switch UI from setup → control panel
    onMessage(event)        // Route incoming messages by type
    sendPrompt()            // Package text as JSON, send over WebSocket
    disconnect()            // Close WebSocket cleanly
    log(message, type)      // Add entry to activity log
}
```

Key design choices:
- **No framework** (React, Vue, etc.) — just vanilla JS
- **No build step** — open the HTML file and it works
- **localStorage** — remembers the last tunnel URL you used

---

### Frontend: `frontend/css/styles.css`

- Uses **CSS custom properties** (variables) for theming
- **Mobile-first**: base styles are mobile, `@media` queries add desktop layouts
- **Dark mode**: automatic via `prefers-color-scheme: dark`
- **No preprocessor** (no Sass/Less) — plain CSS

---

## Running Locally

### Method 1: Make commands (recommended)

```bash
make run          # Production mode
make run-dev      # Debug logging
make frontend     # Serve UI at localhost:3000
make health       # Check daemon status
```

### Method 2: Manual

```bash
# Terminal 1: Backend
source backend/venv/bin/activate
python3 backend/daemon.py

# Terminal 2: Frontend (optional, for local testing)
cd frontend
python3 -m http.server 3000

# Terminal 3: Test
curl http://localhost:8080/health
```

### Method 3: Docker

```bash
make docker-build
make docker-run

# Or directly:
docker compose up --build
```

### Connecting a test client

You can test without a phone using a WebSocket client:

```bash
# Using websocat (install: cargo install websocat)
websocat ws://localhost:8080

# Type this JSON and press Enter:
{"type": "PING"}
# You should get: {"type": "PONG", ...}

# Send a prompt:
{"type": "PROMPT", "payload": "Hello from terminal"}
```

Or use the browser console:
```javascript
const ws = new WebSocket('ws://localhost:8080');
ws.onmessage = (e) => console.log(JSON.parse(e.data));
ws.onopen = () => ws.send(JSON.stringify({type: "PING"}));
```

---

## Making Changes

### Modify the backend

1. Edit `backend/daemon.py`
2. Stop the running daemon (`Ctrl+C`)
3. Restart: `make run-dev`
4. Test your change

### Modify the frontend

1. Edit files in `frontend/`
2. Refresh the browser page
3. No restart needed (it's static files)

### Add a new message type

1. In `backend/daemon.py`, add a new `elif` in `handle_connection()`:
   ```python
   elif msg_type == "YOUR_NEW_TYPE":
       # Handle it
       await websocket.send(json.dumps({
           "type": "YOUR_NEW_TYPE_RESPONSE",
           "data": "..."
       }))
   ```

2. In `frontend/js/app.js`, handle the response in `onMessage()`:
   ```javascript
   } else if (data.type === 'YOUR_NEW_TYPE_RESPONSE') {
       this.handleYourNewType(data);
   }
   ```

### Add a new UI section

1. Add HTML in `frontend/index.html`
2. Add styles in `frontend/css/styles.css`
3. Add logic in `frontend/js/app.js` (in the `VSTunnelClient` class)

---

## Testing

### Run all tests

```bash
make test
```

### Run a specific test

```bash
source backend/venv/bin/activate
pytest backend/tests/test_daemon.py::TestDaemonState::test_record_prompt -v
```

### Write a new test

Add to `backend/tests/test_daemon.py`:

```python
class TestYourFeature:
    def test_something(self, daemon_module):
        # daemon_module is the imported daemon.py with fresh state
        result = daemon_module.some_function("input")
        assert result == "expected"

    @pytest.mark.asyncio
    async def test_async_thing(self, daemon_module):
        result = await daemon_module.some_async_function()
        assert result["status"] == "SUCCESS"
```

### Test the full flow manually

1. Start daemon: `make run-dev`
2. Open `frontend/index.html` in browser
3. Connect to `localhost:8080` (works locally without a tunnel)
4. Send a test prompt
5. Check daemon terminal for log output

---

## Debugging

### Enable debug logging

```bash
LOG_LEVEL=DEBUG python3 backend/daemon.py
```

This shows all WebSocket messages, connection events, and subprocess calls.

### Common issues when developing

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ModuleNotFoundError: No module named 'aiohttp'` | Venv not activated | `source backend/venv/bin/activate` |
| `OSError: [Errno 98] Address already in use` | Port 8080 occupied | Kill old process: `lsof -ti:8080 \| xargs kill` |
| `code: command not found` | VS Code CLI not in PATH | Install from VS Code command palette |
| WebSocket won't connect from phone | Corporate device blocks ws:// | Use HTTP polling (automatic fallback in frontend) |
| Changes not reflected | Browser cache | Hard refresh: `Ctrl+Shift+R` |

### Inspect WebSocket traffic

Open browser DevTools → Network → WS tab. You'll see all messages between the frontend and daemon.

---

## Common Development Tasks

### Format code before committing

```bash
make format    # Auto-fixes Python style
make lint      # Checks without fixing
```

### Check if daemon is running

```bash
make health
# Or:
curl -s http://localhost:8080/health | python3 -m json.tool
```

### Rebuild Docker image after changes

```bash
make docker-build
make docker-run
```

### Simulate a phone connection from CLI

```python
# save as test_client.py — using HTTP polling (works even when WebSocket is blocked)
import requests, json, time

BASE = "http://localhost:8080"

# Connect and get session
resp = requests.get(f"{BASE}/api/connect")
data = resp.json()
session_id = data["session_id"]
print(f"Connected! Daemon v{data['version']} on {data['os']}")
print(f"Transport: {data['transport']}")

# Send a prompt
resp = requests.post(f"{BASE}/api/send",
    headers={"X-Session-Id": session_id, "Content-Type": "application/json"},
    json={"type": "PROMPT", "payload": "Say hello"})
ack = resp.json()
print(f"Result: {ack['result']['status']}")

# Or use WebSocket directly (if not blocked):
# import aiohttp, asyncio
# async def ws_test():
#     async with aiohttp.ClientSession() as session:
#         async with session.ws_connect(f"ws://localhost:8080/ws") as ws:
#             welcome = await ws.receive_json()
#             print(f"Connected! v{welcome['version']}")
#             await ws.send_json({"type": "PROMPT", "payload": "Say hello"})
#             ack = await ws.receive_json()  # skip status updates
#             print(f"Result: {ack}")
# asyncio.run(ws_test())
```

### Add a new environment variable

1. Add to `config/.env.example` with a comment
2. Read it in `daemon.py`: `os.getenv("YOUR_VAR", "default")`
3. Document in `README.md` Configuration table
4. Add to `Dockerfile` ENV section
5. Add to `docker-compose.yml` environment section

---

## Architecture Decisions

Decisions made in this project and why:

| Decision | Rationale |
|----------|-----------|
| **Vanilla JS frontend** | No build step, runs anywhere, easy to understand |
| **Single Python file** | Low barrier to entry, easy to audit, no package structure overhead |
| **aiohttp library** | Handles HTTP + WebSocket on one port, HTTP polling fallback for restricted networks |
| **VS Code CLI** | Avoids needing a VS Code extension (simpler, no marketplace) |
| **No database** | State is ephemeral and in-memory. Daemon is stateless across restarts. |
| **HTTP-first connection** | Corporate mobile devices often block ws:// URLs; HTTP works everywhere |
| **Async Python** | WebSockets are I/O bound; async handles many connections on one thread |
| **No TypeScript** | Frontend is small (~300 lines). Types would add build complexity for little gain. |

### Things intentionally NOT included (and why):

- **React/Vue/Svelte**: Would require npm, a build step, and node_modules for a 200-line UI
- **FastAPI/Flask**: WebSocket-first server doesn't benefit from HTTP frameworks
- **Database**: No persistent state needed — prompts are fire-and-forget
- **VS Code Extension**: Would require the Extension API, TypeScript build chain, and marketplace publishing
- **Native mobile app**: Would require app store distribution. A web page works immediately.

---

## Next Steps for New Contributors

1. **Read the tests** (`backend/tests/test_daemon.py`) — they show how the daemon behaves
2. **Run `make run-dev`** and send messages with a WebSocket client
3. **Browse open issues** on GitHub for `good first issue` labels
4. **Read CONTRIBUTING.md** for PR workflow and style guide

Questions? Open a Discussion on GitHub or ask in an issue.

---

**See also:**
- [Architecture Deep Dive](ARCHITECTURE.md) — Protocol specs, security model, performance
- [Deployment Guide](DEPLOYMENT.md) — Docker, systemd, launchd, Windows
- [User Guide](USER_GUIDE.md) — End-user perspective
