# vstunnel - Technical Architecture

## System Overview

vstunnel v2 implements a **multi-instance, event-driven** architecture for remote monitoring and control of GitHub Copilot agent sessions. The system observes Copilot's side effects (file changes, terminal output) and streams them to a mobile client via a central relay.

---

## Components

### 1. VS Code Extension (`extension/`)

Runs inside each VS Code window. Two responsibilities:

**CopilotMonitor** — observes what Copilot does:
- `FileTracker`: listens to `workspace.onDidChangeTextDocument`, `onDidCreateFiles`, `onDidDeleteFiles`, `onDidRenameFiles`. Debounces 500ms.
- `DiffGenerator`: polls `git diff HEAD` every 5 seconds. Emits only when the diff hash changes. Caps at 50KB.
- `PromptInjector`: sends prompts to Copilot via `workbench.action.chat.open` with query parameter.

**RelayClient** — outbound WebSocket to the relay:
- Registers with `user_id` + `instance_id` + `workspace_name`
- Pushes monitor events upstream as `PUSH_EVENT` messages
- Receives commands from phone (`INJECT_PROMPT`, `GET_DIFF`, `REVERT_FILE`, etc.)
- Auto-reconnects with exponential backoff (2s → 30s max)

### 2. Relay Server (`relay/server.py`)

Stateless message broker. Routes events from laptops to phones and commands from phones to laptops.

**Data model:**
```python
users = {
    "z003vsvd": {
        "token": "e93cf8ec...",
        "instances": {
            "inst_a1b2c3": InstanceSession(ws, workspace_name, event_buffer),
            "inst_d4e5f6": InstanceSession(ws, workspace_name, event_buffer),
        }
    }
}
```

**Event buffering:** Each instance keeps a deque of the last 200 events with sequence numbers. When a phone reconnects, it can request `GET_EVENTS_SINCE` to replay missed events.

### 3. Mobile UI (`frontend/`)

Static SPA served by the relay at `/`. Connects via WebSocket to `/ws/phone`.

**Tabs:**
- Activity: reverse-chronological feed of file/terminal events
- Diff: colored unified diff with per-file revert buttons
- Prompt: text input targeting active session, new chat, or inline edit

**Workspace switcher:** Tabs at top showing all connected instances. Filters all content by selected instance.

---

## Message Protocol

### Registration (Extension → Relay)

```json
{"type": "REGISTER", "user_id": "z003vsvd", "instance_id": "inst_a1b2c3", "workspace_name": "my-app", "workspace_path": "/home/user/my-app"}
```

Response:
```json
{"type": "REGISTERED", "user_id": "z003vsvd", "instance_id": "inst_a1b2c3", "token": "e93cf8ec...", "relay_version": "2.0.0"}
```

### Event Push (Extension → Relay → Phone)

```json
{"type": "PUSH_EVENT", "event": {"type": "AGENT_ACTIVITY", "instance_id": "inst_a1b2c3", "workspace": "my-app", "seq": 42, "activity": {"type": "file_edit", "filePath": "src/App.tsx", "linesAdded": 5, "linesRemoved": 2}}}
```

### Commands (Phone → Relay → Extension)

```json
{"type": "INJECT_PROMPT", "instance_id": "inst_a1b2c3", "prompt": "Also add tests", "target": "active_session"}
{"type": "GET_DIFF", "instance_id": "inst_a1b2c3"}
{"type": "REVERT_FILE", "instance_id": "inst_a1b2c3", "filePath": "src/App.tsx"}
{"type": "ACCEPT_APPROVAL", "instance_id": "inst_a1b2c3", "approvalId": "apr_001"}
```

### Phone Authentication

```json
{"type": "CONNECT_TO", "user_id": "z003vsvd", "token": "e93cf8ec..."}
```

Response includes all active instances:
```json
{"type": "WELCOME", "user_id": "z003vsvd", "instances": [...]}
```

---

## Data Flow

### Monitoring (Copilot edits a file)

```
Copilot writes to src/App.tsx
    → VS Code fires onDidChangeTextDocument
    → FileTracker debounces (500ms), emits AgentActivity
    → CopilotMonitor fires onEvent
    → RelayClient sends PUSH_EVENT to relay
    → Relay forwards to all phones connected to this user
    → Phone renders activity card in feed
```

### Prompt Injection (phone sends follow-up)

```
User taps "Send" on phone
    → Phone WS sends INJECT_PROMPT to relay
    → Relay looks up instance by instance_id
    → Relay forwards to that extension's WebSocket
    → Extension receives command via RelayClient.onCommand
    → PromptInjector calls workbench.action.chat.open with query
    → Copilot receives the prompt in its active session
    → Extension sends COMMAND_RESULT back through relay to phone
```

### Event Replay (phone reconnects)

```
Phone reconnects after network drop
    → Phone sends GET_EVENTS_SINCE {instance_id, since_seq: 35}
    → Relay reads from instance.event_buffer (deque, max 200)
    → Returns all events with seq > 35
    → Phone renders missed activities
```

---

## Multi-Instance Model

Each VS Code window is independent:
- Has its own extension activation
- Generates a stable `instance_id` stored in `workspaceState` (survives restarts)
- Registers separately with the relay
- Events are tagged with `instance_id` and `workspace` name
- Commands from phone are routed to a specific instance

The relay groups instances under a single `user_id`. One auth token per user (not per instance).

---

## Security Model

| Layer | Mechanism |
|-------|-----------|
| Transport | TLS via nginx termination (relay), or plain HTTP on trusted VPN |
| Authentication | Random 128-bit token generated on first laptop registration |
| Authorization | Phone must present correct token to access a user's instances |
| Isolation | Per-user: phone can only see/control instances belonging to authenticated user |
| Data at rest | Nothing persisted. Event buffer is in-memory, lost on relay restart |
| Code safety | Source code never leaves the laptop. Only metadata (file paths, line counts, diff text) transits the relay |

---

## Limitations

1. **Cannot read Copilot's chat text** — we observe side effects (file changes, terminal), not internal chat state
2. **Terminal monitoring requires proposed API** — `onDidWriteTerminalData` needs `enabledApiProposals` opt-in (Phase 2)
3. **Approval detection is heuristic** — pattern matching on terminal output for `(y/n)` prompts
4. **Prompt injection timing** — if Copilot is mid-response, the injected prompt may start a new turn rather than append
