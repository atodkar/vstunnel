# Developer Guide

How to build, run, and modify vstunnel.

---

## Prerequisites

- Node.js 18+ and npm
- Python 3.8+
- VS Code 1.85+
- Git
- Docker (for relay deployment)

---

## Extension Development

### Setup

```bash
cd extension/
npm install
```

### Build

```bash
npm run compile        # one-time build
npm run watch          # watch mode (auto-rebuild on save)
```

### Run in VS Code (debug)

1. Open the `extension/` folder in VS Code
2. Press `F5` — launches Extension Development Host
3. In the new window: `Ctrl+Shift+P` → "vstunnel: Start Mobile Bridge"
4. Check the Output panel (select "vstunnel") for logs

### Package as .vsix

```bash
npx vsce package
# Creates vstunnel-2.0.0.vsix
```

### Install the .vsix

```bash
code --install-extension vstunnel-2.0.0.vsix
```

Or in VS Code: `Ctrl+Shift+P` → "Extensions: Install from VSIX..."

### Extension Structure

```
extension/src/
├── extension.ts          # Activation, command registration, lifecycle
├── server.ts             # Local WebSocket server (direct mode)
├── relay-client.ts       # Outbound WebSocket to relay
├── monitor/
│   ├── types.ts          # Shared TypeScript interfaces
│   ├── file-tracker.ts   # Workspace file change detection
│   ├── diff-generator.ts # Periodic git diff with dedup
│   ├── prompt-injector.ts# Inject prompts into Copilot chat
│   └── index.ts          # CopilotMonitor facade class
└── views/
    ├── status.ts         # Sidebar status tree
    └── history.ts        # Sidebar history tree
```

### Key Configuration Properties

Defined in `extension/package.json` under `contributes.configuration`:

| Property | Type | Default | Purpose |
|----------|------|---------|---------|
| `vstunnel.relayUrl` | string | `""` | Relay URL (enables relay mode) |
| `vstunnel.userId` | string | `""` | User ID for relay registration |
| `vstunnel.port` | number | `8080` | Local WS port (direct mode) |
| `vstunnel.autoStart` | boolean | `false` | Auto-start on VS Code launch |
| `vstunnel.requireToken` | boolean | `true` | Require auth for local connections |

---

## Relay Server Development

### Setup

```bash
cd relay/
pip install -r requirements.txt
```

### Run locally

```bash
python3 server.py
# Listens on http://0.0.0.0:8080
```

Or with environment overrides:

```bash
RELAY_PORT=9090 LOG_LEVEL=DEBUG python3 server.py
```

### Test endpoints

```bash
# Health check
curl http://localhost:8080/health

# List users (empty until an extension connects)
curl http://localhost:8080/api/users

# Mobile UI
open http://localhost:8080/
```

### Relay Structure

Single file: `relay/server.py` (~450 lines)

Key classes:
- `InstanceSession` — represents one connected VS Code extension
- `RelayState` — global state (users, instances, poll sessions)

Key endpoints:
- `GET /ws/laptop` — extension WebSocket
- `GET /ws/phone` — phone WebSocket
- `GET /api/users` — list online users
- `GET /api/connect` — HTTP polling session creation
- `GET /api/poll` — HTTP polling message drain
- `POST /api/send` — HTTP command send

---

## Frontend Development

The frontend is a static SPA (`frontend/index.html`, `frontend/js/app.js`, `frontend/css/styles.css`).

**No build step required.** It's served directly by the relay at `/`.

### Run locally (without relay)

```bash
# Serve with any static server:
cd frontend/
python3 -m http.server 3000
# Open http://localhost:3000
```

Note: the UI needs a relay to connect to, so for local dev you'll want the relay running too.

### Structure

| File | Purpose |
|------|---------|
| `index.html` | Tab-based SPA layout (setup, user select, main panel) |
| `js/app.js` | `VSTunnelApp` class — WebSocket client, UI rendering, event handling |
| `css/styles.css` | Dark theme, mobile-first responsive, diff coloring |

### Key UI Components

- **Setup panel**: relay URL input + connect button
- **User panel**: list of online users + auth token input
- **Main panel**: workspace tabs, content tabs (Activity/Diff/Prompt), approval banner, status bar

---

## Running the Full Stack Locally

```bash
# Terminal 1: Relay server
cd relay/ && python3 server.py

# Terminal 2: VS Code with extension
cd extension/ && npm run watch
# Then F5 in VS Code to launch Extension Development Host
# Configure vstunnel.relayUrl = http://localhost:8080

# Terminal 3 (or phone browser):
# Open http://localhost:8080 in browser
```

---

## Adding a New Monitor Module

To observe a new type of Copilot activity:

1. Create `extension/src/monitor/your-monitor.ts`
2. Implement using VS Code APIs (see existing `file-tracker.ts` as template)
3. Emit events via `vscode.EventEmitter<AgentActivity>`
4. Wire it in `extension/src/monitor/index.ts` (CopilotMonitor constructor)
5. The event will automatically flow: Extension → Relay → Phone

---

## Testing

### Relay integration test

```bash
cd /path/to/vstunnel
python3 -c "
import asyncio
from relay.server import create_app
from aiohttp import web
import aiohttp

async def test():
    app = create_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, 'localhost', 18080)
    await site.start()
    async with aiohttp.ClientSession() as s:
        async with s.get('http://localhost:18080/health') as r:
            data = await r.json()
            assert data['version'] == '2.0.0'
            print('PASS:', data)
    await runner.cleanup()

asyncio.run(test())
"
```

### Extension type check

```bash
cd extension/
npx tsc --noEmit
```

### Frontend syntax check

```bash
node --check frontend/js/app.js
```
