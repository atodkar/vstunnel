# User Guide: Using vstunnel

This guide walks you through installing and using vstunnel as an end user — someone who wants to control GitHub Copilot from their phone.

**No programming knowledge required.** Just follow the steps below.

---

## Table of Contents

1. [What You Need](#what-you-need)
2. [Installation (One Time)](#installation-one-time)
3. [Starting a Session](#starting-a-session)
4. [Using the Mobile Interface](#using-the-mobile-interface)
5. [Sending Prompts](#sending-prompts)
6. [Understanding Status Updates](#understanding-status-updates)
7. [Disconnecting](#disconnecting)
8. [Troubleshooting](#troubleshooting)
9. [Tips & Best Practices](#tips--best-practices)

---

## What You Need

Before starting, make sure you have:

| Requirement | Where to Get It |
|-------------|----------------|
| A laptop/desktop computer | Your main dev machine |
| VS Code installed | [code.visualstudio.com](https://code.visualstudio.com) |
| GitHub Copilot subscription | [github.com/copilot](https://github.com/copilot) |
| Python 3.8 or newer | [python.org/downloads](https://python.org/downloads) |
| A GitHub account | [github.com/join](https://github.com/join) |
| A smartphone with a web browser | Any modern phone (iPhone, Android) |

### How to check your Python version:

Open a terminal and type:

```bash
python3 --version
```

You should see something like `Python 3.11.4`. Any version 3.8 or higher works.

---

## Installation (One Time)

You only need to do this once.

### Step 1: Download vstunnel

Open a terminal on your laptop and run:

```bash
git clone https://github.com/atodkar/vstunnel.git
cd vstunnel
```

Or download the ZIP from GitHub and unzip it anywhere on your computer.

### Step 2: Run the setup script

**On macOS or Linux:**
```bash
chmod +x scripts/setup.sh
./scripts/setup.sh
```

**On Windows (PowerShell):**
```powershell
python -m venv backend\venv
backend\venv\Scripts\activate
pip install -r backend\requirements.txt
copy config\.env.example config\.env
```

You should see output ending with:

```
✅ Python dependencies installed
✅ Environment file created at config/.env
✨ Setup complete!
```

**That's it. Installation is done.** You won't need to do this again.

---

## Starting a Session

Every time you want to use vstunnel, follow these 4 steps:

### Step 1: Start the daemon on your laptop

Open a terminal, navigate to the vstunnel folder, and run:

```bash
./scripts/start-daemon.sh
```

Or on Windows:
```powershell
backend\venv\Scripts\activate
python backend\daemon.py
```

You'll see:
```
vstunnel Daemon v1.1.0
Listening on localhost:8080
VS Code CLI: available
Next: Forward port 8080 in VS Code Ports panel (set visibility to Public)
Daemon ready. Waiting for connections...
```

**Leave this terminal window open.** It needs to stay running.

---

### Step 2: Create a tunnel in VS Code

1. Open **VS Code** on your laptop
2. Open your project/workspace as normal
3. Open the **Ports** panel:
   - Click **View** → **Terminal** (or press `` Ctrl+` ``)
   - Click the **PORTS** tab next to TERMINAL

   ```
   ┌─────────────────────────────────────────────┐
   │  TERMINAL   PROBLEMS   OUTPUT   PORTS  ←←←  │
   └─────────────────────────────────────────────┘
   ```

4. Click **Forward a Port** (or the `+` button)
5. Type `8080` and press Enter
6. You'll see a new entry in the Ports panel:

   ```
   Port    Local Address       Visibility
   8080    localhost:8080      Private
   ```

7. **Right-click** the port entry → **Port Visibility** → **Public**
8. A URL will appear in the "Forwarded Address" column, like:

   ```
   https://xk7abc123-8080.use2.devtunnels.ms
   ```

9. **Copy that URL.** You'll paste it on your phone.

> **Note:** VS Code may ask you to sign in with GitHub the first time. This is normal — it authenticates who can access the tunnel.

---

### Step 3: Open the mobile interface on your phone

You have two options:

**Option A: Use the hosted version (easiest)**

If the frontend is deployed to Vercel/Netlify, just open that URL in your phone's browser.

**Option B: Use locally (for testing)**

If you're on the same WiFi network, you can open:
```
http://YOUR_LAPTOP_IP:3000/
```

To serve it locally, run in a second terminal:
```bash
cd frontend
python3 -m http.server 3000
```

---

### Step 4: Connect your phone to the daemon

1. On your phone, you'll see the vstunnel interface:

   ```
   ┌──────────────────────────────┐
   │  🚀 vstunnel    ● Disconnected │
   │                                │
   │  Connection Setup              │
   │                                │
   │  VS Code Tunnel URL:           │
   │  ┌──────────────────────────┐ │
   │  │                          │ │
   │  └──────────────────────────┘ │
   │                                │
   │  [ Connect to Daemon ]         │
   │                                │
   └──────────────────────────────┘
   ```

2. Paste the tunnel URL from Step 2 into the text field.
   - You can paste the full URL (`https://xk7abc123-8080.use2.devtunnels.ms`)
   - Or just the domain (`xk7abc123-8080.use2.devtunnels.ms`)
   - The app handles both formats automatically.

3. Tap **Connect to Daemon**

4. If successful, the status will change to **Connected** (green dot):

   ```
   ┌──────────────────────────────┐
   │  🚀 vstunnel      ● Connected │
   │                                │
   │  OS: Darwin  Version: 1.1.0   │
   │  Last Update: 14:32:05        │
   │                                │
   │  Send Prompt to Copilot        │
   │  ┌──────────────────────────┐ │
   │  │ Type your prompt here... │ │
   │  │                          │ │
   │  │                          │ │
   │  └──────────────────────────┘ │
   │                                │
   │  [ 📤 Send Prompt ] [ Clear ] │
   │                                │
   │  Activity Log                  │
   │  ┌──────────────────────────┐ │
   │  │ ✅ Connected to daemon   │ │
   │  └──────────────────────────┘ │
   │                                │
   │  [ 🔌 Disconnect ]            │
   └──────────────────────────────┘
   ```

**You're connected!** You can now step away from your laptop.

---

## Sending Prompts

Once connected, you can send prompts to GitHub Copilot on your laptop:

1. **Type your prompt** in the text area. Examples:
   - `"Fix the failing test in auth.test.ts"`
   - `"Add error handling to the API endpoint"`
   - `"Explain what the useEffect hook does in App.tsx"`
   - `"Refactor the database query to use joins"`

2. **Tap "Send Prompt"**

3. **Watch the activity log** for confirmation:
   - `📤 Sent: "Fix the failing test..."` — Prompt is on its way
   - `✅ Prompt executed successfully` — VS Code received it and Copilot is working
   - `❌ Error: ...` — Something went wrong (see troubleshooting)

### What happens on your laptop:

When you send a prompt, the daemon:
1. Receives it via the tunnel
2. Calls VS Code's inline chat CLI
3. VS Code opens an inline chat with your prompt pre-filled
4. Copilot starts generating a response

> **Important:** The prompt opens Copilot's inline chat. Copilot will generate code, but you may need to accept/reject the suggestion when you return to your laptop.

---

## Understanding Status Updates

The control panel shows real-time information:

| Field | Meaning |
|-------|---------|
| **OS** | Your laptop's operating system (Darwin = macOS, Linux, Windows) |
| **Version** | vstunnel daemon version running on your laptop |
| **Last Update** | When the last status ping was received (updates every 3 seconds) |

### Connection states:

| Status | Meaning |
|--------|---------|
| 🟢 **Connected** | Everything is working. You can send prompts. |
| 🔴 **Disconnected** | No connection. Check your tunnel URL or laptop. |

If the status shows "Disconnected" unexpectedly:
- Your laptop may have gone to sleep
- The VS Code tunnel may have expired
- Your internet connection may have dropped

---

## Disconnecting

When you're done:

1. Tap **🔌 Disconnect** on your phone
2. Go back to your laptop terminal and press `Ctrl+C` to stop the daemon
3. (Optional) Remove the port forwarding in VS Code's Ports panel

**Or just leave it running.** The daemon uses minimal resources and the tunnel stays active as long as VS Code is open.

---

## Troubleshooting

### "Connection Failed" when tapping Connect

| Possible Cause | Fix |
|----------------|-----|
| Daemon not running | Start it: `./scripts/start-daemon.sh` |
| Wrong URL | Re-copy from VS Code Ports panel |
| Port not public | Right-click port → Visibility → Public |
| VS Code closed | Reopen VS Code (tunnels need it running) |
| Laptop asleep | Wake your laptop |

### "Prompt executed" but nothing happens in VS Code

| Possible Cause | Fix |
|----------------|-----|
| VS Code not in focus | Click on VS Code window |
| No file open | Open a file in the editor first |
| Copilot not active | Check Copilot icon in VS Code status bar |
| `code` CLI not in PATH | Run "Shell Command: Install 'code' command" from VS Code |

### Phone shows "Disconnected" after a while

This usually means your laptop went to sleep or the tunnel expired.

**Fix:**
1. Wake your laptop
2. Check VS Code is still running
3. Check the Ports panel — if the URL changed, copy the new one
4. Reconnect from your phone with the new URL

### Daemon shows "VS Code CLI not found"

The `code` command isn't in your system PATH.

**Fix (macOS):**
1. Open VS Code
2. Press `Cmd+Shift+P`
3. Type "Shell Command: Install 'code' command in PATH"
4. Restart the daemon

**Fix (Linux):**
```bash
sudo ln -s /usr/share/code/bin/code /usr/local/bin/code
```

**Fix (Windows):**
VS Code installer usually adds it to PATH. If not, add `C:\Users\YOU\AppData\Local\Programs\Microsoft VS Code\bin` to your PATH environment variable.

---

## Tips & Best Practices

### Save your tunnel URL

The mobile UI remembers the last URL you used (stored in your browser). But tunnel URLs can change if you restart VS Code, so keep the Ports panel handy.

### Use clear, specific prompts

Good prompts:
- `"Add input validation to the signup form — email must be valid"`
- `"Write a unit test for the calculateTotal function"`
- `"Fix the TypeScript error on line 42 of utils.ts"`

Less effective prompts:
- `"Fix bugs"` (too vague)
- `"Rewrite everything"` (too broad)

### Keep VS Code in the right context

Before stepping away, make sure:
- The file you want Copilot to work on is **open and active**
- You're in the **correct branch**
- Any relevant files are **saved**

### Battery considerations

The mobile UI is lightweight, but WebSocket connections do keep your phone radio active. On long sessions, it uses roughly the same battery as a messaging app.

### Security reminder

- Your source code **never** leaves your laptop
- Only the prompt text you type travels through the tunnel
- The tunnel is encrypted (TLS) and authenticated (GitHub account)
- Anyone with the tunnel URL can connect — don't share it publicly

---

## Quick Reference Card

```
┌─────────────────────────────────────────────────────┐
│                vstunnel Quick Reference              │
├─────────────────────────────────────────────────────┤
│                                                     │
│  START:                                             │
│    1. Terminal: ./scripts/start-daemon.sh            │
│    2. VS Code: Ports → Forward 8080 → Public        │
│    3. Phone: Paste URL → Connect                    │
│                                                     │
│  USE:                                               │
│    Type prompt → Send → Check activity log          │
│                                                     │
│  STOP:                                              │
│    Phone: Disconnect                                │
│    Terminal: Ctrl+C                                  │
│                                                     │
│  HEALTH CHECK:                                      │
│    curl http://localhost:8080/health                 │
│                                                     │
│  COMMON ISSUES:                                     │
│    Can't connect → Check daemon + tunnel URL        │
│    No response → Check VS Code is open              │
│    Disconnected → Wake laptop + check tunnel        │
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## Workflow Example: Real Usage Scenario

**Situation:** You started a test suite and a Copilot code generation task. You need to grab lunch.

**Before leaving your desk:**
1. Start the daemon: `./scripts/start-daemon.sh`
2. Forward port 8080 in VS Code (Public visibility)
3. Copy the tunnel URL

**At lunch (on your phone):**
1. Open vstunnel mobile UI
2. Paste tunnel URL → Connect
3. See status: "READY_AND_LISTENING" — your laptop is alive
4. Copilot finishes and needs your next instruction
5. Type: `"Now run the test suite: npm test"`
6. See: `✅ Prompt executed successfully`
7. Later, type: `"Show me the test results summary"`

**When you return:**
- Your VS Code has the Copilot responses waiting
- Tests have been running
- No workflow stalls!

---

## Frequently Asked Questions

**Q: Can I use this with VS Code on a remote server (SSH)?**
A: The daemon needs to run on the same machine as VS Code. If you're SSH'd into a server with VS Code Remote, run the daemon there too.

**Q: Does it work with VS Code forks (Cursor, VSCodium)?**
A: It should work with any editor that provides a `code` CLI with `--inline-chat` support. Cursor works; VSCodium may need configuration.

**Q: Can multiple people connect to the same daemon?**
A: Yes, but they'd all be sending prompts to the same VS Code instance. This is designed for single-user use.

**Q: What if I close my laptop lid?**
A: Most laptops sleep when the lid closes, which kills the daemon and tunnel. Either disable sleep-on-lid-close or use a keep-awake utility.

**Q: Is there a character limit for prompts?**
A: Yes, 10,000 characters maximum. This is more than enough for any practical prompt.

**Q: Do I need to be on the same WiFi?**
A: No! The tunnel goes through the internet. You can be anywhere — different network, cellular data, another country.

---

**Next:** If something isn't covered here, check [Troubleshooting](DEPLOYMENT.md#troubleshooting-deployments) or open a [GitHub Issue](../../issues/new).
