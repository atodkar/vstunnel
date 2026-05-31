#!/usr/bin/env python3
"""
vstunnel Copilot Daemon - Local WebSocket Server
Manages connections from mobile UI and executes prompts in VS Code.
Supports multiple VS Code instances via workspace detection and targeting.
Serves mobile UI via HTTP and provides HTTP polling fallback when WebSocket is blocked.
"""

import asyncio
import json
import os
import re
import signal
import platform
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import aiohttp
from aiohttp import web
import logging

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("vstunnel")

DAEMON_VERSION = "1.4.1"
MAX_PROMPT_LENGTH = 10_000
HEARTBEAT_INTERVAL = 20
STATUS_INTERVAL = 3
POLL_SESSION_TIMEOUT = 120
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


# ─── Workspace Detection ───────────────────────────────────────────────────────


class Workspace:
    """Represents a detected VS Code instance/workspace."""

    def __init__(self, workspace_id: str, folder_path: str, name: str, pid: int = None):
        self.id = workspace_id
        self.folder_path = folder_path
        self.name = name
        self.pid = pid

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "folder_path": self.folder_path,
            "name": self.name,
            "pid": self.pid,
        }


class WorkspaceManager:
    """
    Detects running VS Code instances and their workspace folders.

    Detection strategy (cross-platform):
    1. Parse process list for VS Code processes with folder arguments
    2. Fall back to VS Code's recently-opened storage
    3. Support manual workspace registration
    """

    def __init__(self):
        self.active_workspace_id: str | None = None
        self._manual_workspaces: list[Workspace] = []

    def register_manual(self, folder_path: str):
        """Allow users to manually register a workspace folder."""
        path = Path(folder_path).resolve()
        if path.is_dir():
            ws_id = self._path_to_id(str(path))
            ws = Workspace(
                workspace_id=ws_id,
                folder_path=str(path),
                name=path.name,
            )
            existing_ids = {w.id for w in self._manual_workspaces}
            if ws_id not in existing_ids:
                self._manual_workspaces.append(ws)
            return ws.to_dict()
        return None

    async def detect_workspaces(self) -> list[dict]:
        """Detect all running VS Code instances with their workspace folders."""
        workspaces = []

        try:
            detected = await self._detect_from_processes()
            workspaces.extend(detected)
        except Exception as e:
            logger.debug(f"Process detection failed: {e}")

        if not workspaces:
            try:
                detected = await self._detect_from_storage()
                workspaces.extend(detected)
            except Exception as e:
                logger.debug(f"Storage detection failed: {e}")

        for manual in self._manual_workspaces:
            if manual.id not in {w.id for w in workspaces}:
                workspaces.append(manual)

        return [ws.to_dict() if isinstance(ws, Workspace) else ws for ws in workspaces]

    async def _detect_from_processes(self) -> list[Workspace]:
        """Parse running processes to find VS Code instances."""
        system = platform.system()
        workspaces = []

        if system in ("Linux", "Darwin"):
            proc = await asyncio.create_subprocess_exec(
                "ps", "aux",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await proc.communicate()
            lines = stdout.decode(errors="replace").splitlines()

            for line in lines:
                if "code" not in line.lower():
                    continue

                folder = self._extract_folder_from_cmdline(line)
                if folder:
                    path = Path(folder)
                    if path.is_dir():
                        pid = self._extract_pid(line)
                        ws = Workspace(
                            workspace_id=self._path_to_id(str(path)),
                            folder_path=str(path),
                            name=path.name,
                            pid=pid,
                        )
                        if ws.id not in {w.id for w in workspaces}:
                            workspaces.append(ws)

        elif system == "Windows":
            proc = await asyncio.create_subprocess_exec(
                "powershell", "-NoProfile", "-Command",
                "Get-CimInstance Win32_Process -Filter \"name like '%Code%'\" | "
                "Select-Object ProcessId,CommandLine | Format-List",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await proc.communicate()
            lines = stdout.decode(errors="replace").splitlines()

            current_pid = None
            current_cmdline = ""
            for line in lines:
                line = line.strip()
                if line.startswith("ProcessId"):
                    current_pid = None
                    parts = line.split(":", 1)
                    if len(parts) == 2:
                        try:
                            current_pid = int(parts[1].strip())
                        except ValueError:
                            pass
                elif line.startswith("CommandLine"):
                    parts = line.split(":", 1)
                    current_cmdline = parts[1].strip() if len(parts) == 2 else ""
                elif not line and current_cmdline:
                    folder = self._extract_folder_from_cmdline(current_cmdline)
                    if folder:
                        path = Path(folder)
                        if path.is_dir():
                            ws = Workspace(
                                workspace_id=self._path_to_id(str(path)),
                                folder_path=str(path),
                                name=path.name,
                                pid=current_pid,
                            )
                            if ws.id not in {w.id for w in workspaces}:
                                workspaces.append(ws)
                    current_cmdline = ""
                    current_pid = None

            if current_cmdline:
                folder = self._extract_folder_from_cmdline(current_cmdline)
                if folder:
                    path = Path(folder)
                    if path.is_dir():
                        ws = Workspace(
                            workspace_id=self._path_to_id(str(path)),
                            folder_path=str(path),
                            name=path.name,
                            pid=current_pid,
                        )
                        if ws.id not in {w.id for w in workspaces}:
                            workspaces.append(ws)

        return workspaces

    async def _detect_from_storage(self) -> list[Workspace]:
        """Read VS Code's storage.json for recently opened workspaces."""
        storage_path = self._get_storage_path()
        if not storage_path or not storage_path.exists():
            return []

        try:
            content = storage_path.read_text(encoding="utf-8")
            data = json.loads(content)
        except (json.JSONDecodeError, OSError):
            return []

        workspaces = []
        entries = (
            data.get("openedPathsList", {}).get("entries", [])
            or data.get("lastKnownMenubarData", {}).get("menus", {}).get("File", {}).get("items", [])
        )

        for entry in entries[:10]:
            folder_uri = None
            if isinstance(entry, dict):
                folder_uri = entry.get("folderUri") or entry.get("fileUri")
            elif isinstance(entry, str):
                folder_uri = entry

            if folder_uri and folder_uri.startswith("file://"):
                folder_path = folder_uri.replace("file://", "")
                if platform.system() == "Windows" and folder_path.startswith("/"):
                    folder_path = folder_path[1:]

                path = Path(folder_path)
                if path.is_dir():
                    ws = Workspace(
                        workspace_id=self._path_to_id(str(path)),
                        folder_path=str(path),
                        name=path.name,
                    )
                    if ws.id not in {w.id for w in workspaces}:
                        workspaces.append(ws)

        return workspaces

    def _get_storage_path(self) -> Path | None:
        """Get VS Code storage.json path for the current platform."""
        system = platform.system()
        home = Path.home()

        if system == "Darwin":
            return home / "Library/Application Support/Code/storage.json"
        elif system == "Linux":
            return home / ".config/Code/storage.json"
        elif system == "Windows":
            appdata = os.getenv("APPDATA", "")
            if appdata:
                return Path(appdata) / "Code/storage.json"
        return None

    def _extract_folder_from_cmdline(self, cmdline: str) -> str | None:
        """Extract workspace folder from a VS Code process command line."""
        patterns = [
            r'--folder-uri\s+file:///([^\s]+)',
            r'--folder-uri\s+"file:///([^"]+)"',
            r'--folder-uri\s+file://(/[^\s]+)',
            r'--folder-uri\s+"file://([^"]+)"',
        ]
        for pat in patterns:
            match = re.search(pat, cmdline)
            if match:
                return match.group(1)

        parts = cmdline.split()
        for part in reversed(parts):
            if part.startswith("--"):
                continue
            if part.startswith("/") or (len(part) > 2 and part[1] == ":"):
                p = Path(part)
                if p.is_dir() and (p / ".git").exists():
                    return str(p)
        return None

    def _extract_pid(self, ps_line: str) -> int | None:
        """Extract PID from a ps aux output line."""
        parts = ps_line.split()
        if len(parts) >= 2:
            try:
                return int(parts[1])
            except ValueError:
                pass
        return None

    def _path_to_id(self, path: str) -> str:
        """Generate a short stable ID from a folder path."""
        import hashlib
        return hashlib.sha256(path.encode()).hexdigest()[:12]

    def get_folder_for_id(self, workspace_id: str) -> str | None:
        """Resolve a workspace ID back to its folder path."""
        for ws in self._manual_workspaces:
            if ws.id == workspace_id:
                return ws.folder_path
        return None

    async def resolve_folder(self, workspace_id: str) -> str | None:
        """Resolve workspace ID to folder path, checking all sources."""
        manual = self.get_folder_for_id(workspace_id)
        if manual:
            return manual

        all_ws = await self.detect_workspaces()
        for ws in all_ws:
            if ws["id"] == workspace_id:
                return ws["folder_path"]
        return None


# ─── Daemon State ──────────────────────────────────────────────────────────────


class DaemonState:
    def __init__(self):
        self.connected_clients: set = set()
        self.prompt_history: list = []
        self.total_prompts_executed: int = 0
        self.start_time: datetime = datetime.now(timezone.utc)
        self.vscode_available: bool = False
        self.shutdown_event: asyncio.Event = asyncio.Event()
        self.workspace_manager: WorkspaceManager = WorkspaceManager()
        self.poll_sessions: dict = {}  # session_id -> PollSession

    @property
    def uptime_seconds(self) -> int:
        delta = datetime.now(timezone.utc) - self.start_time
        return int(delta.total_seconds())

    def record_prompt(self, prompt: str, result: dict, workspace: str = None):
        entry = {
            "prompt": prompt[:100],
            "result": result["status"],
            "workspace": workspace,
            "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
        }
        self.prompt_history.append(entry)
        if len(self.prompt_history) > 50:
            self.prompt_history = self.prompt_history[-50:]
        self.total_prompts_executed += 1

    def create_poll_session(self) -> str:
        session_id = uuid.uuid4().hex[:16]
        self.poll_sessions[session_id] = {
            "created": datetime.now(timezone.utc),
            "last_poll": datetime.now(timezone.utc),
            "messages": [],
        }
        return session_id

    def get_poll_session(self, session_id: str) -> dict | None:
        session = self.poll_sessions.get(session_id)
        if session:
            session["last_poll"] = datetime.now(timezone.utc)
        return session

    def queue_poll_message(self, session_id: str, message: dict):
        session = self.poll_sessions.get(session_id)
        if session:
            session["messages"].append(message)
            if len(session["messages"]) > 100:
                session["messages"] = session["messages"][-100:]

    def drain_poll_messages(self, session_id: str) -> list:
        session = self.poll_sessions.get(session_id)
        if not session:
            return []
        messages = session["messages"]
        session["messages"] = []
        return messages

    def cleanup_stale_sessions(self):
        now = datetime.now(timezone.utc)
        stale = [
            sid for sid, s in self.poll_sessions.items()
            if (now - s["last_poll"]).total_seconds() > POLL_SESSION_TIMEOUT
        ]
        for sid in stale:
            del self.poll_sessions[sid]


state = DaemonState()


# ─── VS Code Execution ─────────────────────────────────────────────────────────


def check_vscode_cli() -> bool:
    return shutil.which("code") is not None


async def execute_vscode_command(prompt: str, workspace_folder: str = None) -> dict:
    """
    Send a prompt to VS Code Copilot Chat via the CLI.

    Uses 'code --command' to trigger Copilot inline chat, falling back to
    writing the prompt to a temp file and opening it in VS Code as a signal.
    """
    if not state.vscode_available:
        return {
            "status": "ERROR",
            "message": "VS Code CLI ('code') not found in PATH",
            "exit_code": -1,
        }

    try:
        cmd = []
        if platform.system() == "Windows":
            cmd = ["cmd", "/c", "code"]
        else:
            cmd = ["code"]

        if workspace_folder:
            folder_uri = workspace_folder
            if platform.system() == "Windows" and not workspace_folder.startswith("file:"):
                folder_uri = workspace_folder.replace("\\", "/")
                if not folder_uri.startswith("/"):
                    folder_uri = "/" + folder_uri
            cmd.extend(["--reuse-window", "--folder-uri", f"file://{folder_uri}"])

        prompt_file = Path(os.environ.get("TEMP", "/tmp")) / "vstunnel_prompt.md"
        prompt_file.write_text(f"# Copilot Prompt\n\n{prompt}\n", encoding="utf-8")
        cmd.extend(["--goto", str(prompt_file)])

        logger.debug(f"Executing: {' '.join(cmd)}")

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(
            process.communicate(), timeout=30.0
        )

        if process.returncode == 0:
            target = f" (workspace: {Path(workspace_folder).name})" if workspace_folder else ""
            logger.info(f"Prompt delivered{target}: {prompt[:60]}...")
            return {
                "status": "SUCCESS",
                "message": f"Prompt delivered to VS Code{target}",
                "exit_code": 0,
            }
        else:
            error_msg = stderr.decode().strip() or "Non-zero exit code"
            logger.warning(f"VS Code exit code {process.returncode}: {error_msg}")
            return {
                "status": "ERROR",
                "message": error_msg,
                "exit_code": process.returncode,
            }

    except asyncio.TimeoutError:
        logger.error("VS Code command timed out after 30s")
        return {
            "status": "ERROR",
            "message": "Command timed out after 30 seconds",
            "exit_code": -1,
        }
    except Exception as e:
        logger.error(f"VS Code execution error: {e}")
        return {
            "status": "ERROR",
            "message": str(e),
            "exit_code": -1,
        }


# ─── HTTP + WebSocket Server (aiohttp) ───────────────────────────────────────


CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Session-Id",
}


async def handle_cors(request):
    return web.Response(status=204, headers=CORS_HEADERS)


async def handle_health(request):
    return web.json_response({
        "status": "healthy",
        "version": DAEMON_VERSION,
        "uptime": state.uptime_seconds,
        "connected_clients": len(state.connected_clients),
        "poll_sessions": len(state.poll_sessions),
        "vscode_available": state.vscode_available,
        "transport": ["websocket", "polling"],
    }, headers=CORS_HEADERS)


async def handle_api_connect(request):
    state.cleanup_stale_sessions()
    session_id = state.create_poll_session()
    workspaces = await state.workspace_manager.detect_workspaces()
    return web.json_response({
        "type": "WELCOME",
        "session_id": session_id,
        "version": DAEMON_VERSION,
        "os": platform.system(),
        "vscode_available": state.vscode_available,
        "workspaces": workspaces,
        "transport": "polling",
        "poll_interval_ms": 2000,
        "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
    }, headers=CORS_HEADERS)


async def handle_api_poll(request):
    session_id = request.headers.get("X-Session-Id") or request.query.get("session")

    if not session_id or not state.get_poll_session(session_id):
        return web.json_response(
            {"type": "ERROR", "message": "Invalid or expired session"},
            status=401, headers=CORS_HEADERS,
        )

    messages = state.drain_poll_messages(session_id)

    workspaces = await state.workspace_manager.detect_workspaces()
    status_msg = {
        "type": "STATUS_UPDATE",
        "status": "READY_AND_LISTENING",
        "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
        "os": platform.system(),
        "version": DAEMON_VERSION,
        "connected_clients": len(state.connected_clients) + len(state.poll_sessions),
        "uptime": state.uptime_seconds,
        "total_prompts": state.total_prompts_executed,
        "vscode_available": state.vscode_available,
        "workspaces": workspaces,
    }
    messages.append(status_msg)

    return web.json_response({"messages": messages}, headers=CORS_HEADERS)


async def handle_api_send(request):
    session_id = request.headers.get("X-Session-Id") or request.query.get("session")

    if not session_id or not state.get_poll_session(session_id):
        return web.json_response(
            {"type": "ERROR", "message": "Invalid or expired session"},
            status=401, headers=CORS_HEADERS,
        )

    try:
        data = await request.json()
    except (json.JSONDecodeError, Exception):
        return web.json_response(
            {"type": "ERROR", "message": "Invalid JSON body"},
            status=400, headers=CORS_HEADERS,
        )

    msg_type = data.get("type")

    if msg_type == "PROMPT":
        prompt_text = data.get("payload", "").strip()
        workspace_id = data.get("workspace_id")

        if not prompt_text:
            return web.json_response({"type": "ERROR", "message": "Empty prompt"}, status=400, headers=CORS_HEADERS)
        if len(prompt_text) > MAX_PROMPT_LENGTH:
            return web.json_response(
                {"type": "ERROR", "message": f"Prompt exceeds {MAX_PROMPT_LENGTH} characters"},
                status=400, headers=CORS_HEADERS,
            )

        workspace_folder = None
        workspace_name = None
        if workspace_id:
            workspace_folder = await state.workspace_manager.resolve_folder(workspace_id)
            if workspace_folder:
                workspace_name = Path(workspace_folder).name

        result = await execute_vscode_command(prompt_text, workspace_folder)
        state.record_prompt(prompt_text, result, workspace_name)

        response = {
            "type": "PROMPT_ACK",
            "result": result,
            "workspace": workspace_name,
            "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
        }
        state.queue_poll_message(session_id, response)
        return web.json_response(response, headers=CORS_HEADERS)

    elif msg_type == "LIST_WORKSPACES":
        workspaces = await state.workspace_manager.detect_workspaces()
        response = {
            "type": "WORKSPACES",
            "workspaces": workspaces,
            "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
        }
        return web.json_response(response, headers=CORS_HEADERS)

    elif msg_type == "HISTORY":
        response = {
            "type": "HISTORY_RESPONSE",
            "history": state.prompt_history[-20:],
        }
        return web.json_response(response, headers=CORS_HEADERS)

    elif msg_type == "REGISTER_WORKSPACE":
        folder_path = data.get("folder_path", "").strip()
        if folder_path:
            result = state.workspace_manager.register_manual(folder_path)
            if result:
                return web.json_response({"type": "WORKSPACE_REGISTERED", "workspace": result}, headers=CORS_HEADERS)
        return web.json_response({"type": "ERROR", "message": "Invalid folder path"}, status=400, headers=CORS_HEADERS)

    return web.json_response({"type": "ERROR", "message": f"Unknown message type: {msg_type}"}, status=400, headers=CORS_HEADERS)


async def handle_websocket(request):
    """WebSocket handler for aiohttp - wraps existing logic."""
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    remote = request.remote
    logger.info(f"WebSocket client connected: {remote}")
    state.connected_clients.add(ws)

    async def ws_send(data):
        await ws.send_str(json.dumps(data))

    async def ws_stream_status():
        try:
            while not ws.closed:
                workspaces = await state.workspace_manager.detect_workspaces()
                packet = {
                    "type": "STATUS_UPDATE",
                    "status": "READY_AND_LISTENING",
                    "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
                    "os": platform.system(),
                    "version": DAEMON_VERSION,
                    "connected_clients": len(state.connected_clients) + len(state.poll_sessions),
                    "uptime": state.uptime_seconds,
                    "total_prompts": state.total_prompts_executed,
                    "vscode_available": state.vscode_available,
                    "workspaces": workspaces,
                }
                await ws_send(packet)
                await asyncio.sleep(STATUS_INTERVAL)
        except Exception:
            pass

    status_task = asyncio.create_task(ws_stream_status())

    try:
        workspaces = await state.workspace_manager.detect_workspaces()
        await ws_send({
            "type": "WELCOME",
            "version": DAEMON_VERSION,
            "os": platform.system(),
            "vscode_available": state.vscode_available,
            "workspaces": workspaces,
            "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
        })

        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    await ws_send({"type": "ERROR", "message": "Invalid JSON"})
                    continue

                msg_type = data.get("type")

                if msg_type == "PROMPT":
                    prompt_text = data.get("payload", "").strip()
                    workspace_id = data.get("workspace_id")

                    if not prompt_text:
                        await ws_send({"type": "ERROR", "message": "Empty prompt"})
                        continue
                    if len(prompt_text) > MAX_PROMPT_LENGTH:
                        await ws_send({"type": "ERROR", "message": f"Prompt exceeds {MAX_PROMPT_LENGTH} characters"})
                        continue

                    workspace_folder = None
                    workspace_name = None
                    if workspace_id:
                        workspace_folder = await state.workspace_manager.resolve_folder(workspace_id)
                        if workspace_folder:
                            workspace_name = Path(workspace_folder).name

                    result = await execute_vscode_command(prompt_text, workspace_folder)
                    state.record_prompt(prompt_text, result, workspace_name)
                    await ws_send({
                        "type": "PROMPT_ACK",
                        "result": result,
                        "workspace": workspace_name,
                        "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
                    })

                elif msg_type == "PING":
                    await ws_send({"type": "PONG", "timestamp": datetime.now(timezone.utc).isoformat() + "Z"})

                elif msg_type == "LIST_WORKSPACES":
                    workspaces = await state.workspace_manager.detect_workspaces()
                    await ws_send({"type": "WORKSPACES", "workspaces": workspaces, "timestamp": datetime.now(timezone.utc).isoformat() + "Z"})

                elif msg_type == "REGISTER_WORKSPACE":
                    folder_path = data.get("folder_path", "").strip()
                    if folder_path:
                        result = state.workspace_manager.register_manual(folder_path)
                        if result:
                            await ws_send({"type": "WORKSPACE_REGISTERED", "workspace": result})
                        else:
                            await ws_send({"type": "ERROR", "message": f"Invalid folder path: {folder_path}"})

                elif msg_type == "HISTORY":
                    await ws_send({"type": "HISTORY_RESPONSE", "history": state.prompt_history[-20:]})

                else:
                    await ws_send({"type": "ERROR", "message": f"Unknown message type: {msg_type}"})

            elif msg.type == web.WSMsgType.ERROR:
                logger.error(f"WebSocket error: {ws.exception()}")

    except Exception as e:
        logger.error(f"WebSocket connection error ({remote}): {e}")
    finally:
        state.connected_clients.discard(ws)
        status_task.cancel()
        logger.info(f"WebSocket client disconnected: {remote}")

    return ws


def create_app() -> web.Application:
    app = web.Application()

    app.router.add_route("OPTIONS", "/{path:.*}", handle_cors)

    app.router.add_get("/health", handle_health)
    app.router.add_get("/api/connect", handle_api_connect)
    app.router.add_get("/api/poll", handle_api_poll)
    app.router.add_post("/api/send", handle_api_send)

    app.router.add_get("/ws", handle_websocket)

    if FRONTEND_DIR.is_dir():
        async def serve_index(request):
            return web.FileResponse(FRONTEND_DIR / "index.html")

        app.router.add_get("/", serve_index)
        app.router.add_static("/css", FRONTEND_DIR / "css")
        app.router.add_static("/js", FRONTEND_DIR / "js")

    return app


# ─── Relay Client Mode ────────────────────────────────────────────────────────


async def handle_relay_message(data: dict) -> dict:
    """Process a message forwarded from the relay and return a response."""
    msg_type = data.get("type")
    request_id = data.get("_relay_request_id")

    if msg_type == "PROMPT":
        prompt_text = data.get("payload", "").strip()
        workspace_id = data.get("workspace_id")

        if not prompt_text:
            return {"type": "RESPONSE", "result": {"status": "ERROR", "message": "Empty prompt"}, "_relay_request_id": request_id}
        if len(prompt_text) > MAX_PROMPT_LENGTH:
            return {"type": "RESPONSE", "result": {"status": "ERROR", "message": f"Prompt exceeds {MAX_PROMPT_LENGTH} chars"}, "_relay_request_id": request_id}

        workspace_folder = None
        workspace_name = None
        if workspace_id:
            workspace_folder = await state.workspace_manager.resolve_folder(workspace_id)
            if workspace_folder:
                workspace_name = Path(workspace_folder).name

        result = await execute_vscode_command(prompt_text, workspace_folder)
        state.record_prompt(prompt_text, result, workspace_name)

        return {
            "type": "RESPONSE",
            "result": result,
            "workspace": workspace_name,
            "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
            "_relay_request_id": request_id,
        }

    elif msg_type == "LIST_WORKSPACES":
        workspaces = await state.workspace_manager.detect_workspaces()
        return {
            "type": "RESPONSE",
            "workspaces": workspaces,
            "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
            "_relay_request_id": request_id,
        }

    elif msg_type == "HISTORY":
        return {
            "type": "RESPONSE",
            "history": state.prompt_history[-20:],
            "_relay_request_id": request_id,
        }

    return {"type": "RESPONSE", "error": f"Unknown: {msg_type}", "_relay_request_id": request_id}


async def relay_client_loop(relay_url: str, user_id: str):
    """Connect to relay server and handle forwarded messages from phones."""
    ws_url = relay_url.replace("https://", "wss://").replace("http://", "ws://")
    ws_url = ws_url.rstrip("/") + "/ws/laptop"

    reconnect_delay = 2

    while not state.shutdown_event.is_set():
        try:
            async with aiohttp.ClientSession() as session:
                logger.info(f"Connecting to relay: {ws_url}")
                async with session.ws_connect(ws_url, heartbeat=30) as ws:
                    reconnect_delay = 2

                    workspaces = await state.workspace_manager.detect_workspaces()
                    await ws.send_json({
                        "type": "REGISTER",
                        "user_id": user_id,
                        "workspaces": [w if isinstance(w, dict) else w.to_dict() for w in workspaces],
                    })

                    reg_msg = await ws.receive_json()
                    if reg_msg.get("type") == "REGISTERED":
                        token = reg_msg.get("token", "")
                        logger.info(f"Registered with relay as '{user_id}'")
                        logger.info(f"Phone auth token: {token}")
                        logger.info(f"Share this with your phone to connect:")
                        logger.info(f"  User ID: {user_id}")
                        logger.info(f"  Token:   {token}")
                    else:
                        logger.error(f"Registration failed: {reg_msg}")
                        await asyncio.sleep(5)
                        continue

                    workspace_update_task = asyncio.create_task(
                        _periodic_workspace_update(ws)
                    )

                    try:
                        async for msg in ws:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                data = json.loads(msg.data)
                                response = await handle_relay_message(data)
                                await ws.send_json(response)
                            elif msg.type == aiohttp.WSMsgType.ERROR:
                                logger.error(f"Relay WS error: {ws.exception()}")
                                break
                            elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING, aiohttp.WSMsgType.CLOSED):
                                break
                    finally:
                        workspace_update_task.cancel()

        except aiohttp.ClientError as e:
            logger.warning(f"Relay connection failed: {e}")
        except Exception as e:
            logger.error(f"Relay error: {e}")

        if not state.shutdown_event.is_set():
            logger.info(f"Reconnecting to relay in {reconnect_delay}s...")
            await asyncio.sleep(reconnect_delay)
            reconnect_delay = min(reconnect_delay * 2, 30)


async def _periodic_workspace_update(ws):
    """Send workspace updates to relay periodically."""
    try:
        while True:
            await asyncio.sleep(30)
            workspaces = await state.workspace_manager.detect_workspaces()
            await ws.send_json({
                "type": "UPDATE_WORKSPACES",
                "workspaces": [w if isinstance(w, dict) else w.to_dict() for w in workspaces],
            })
    except Exception:
        pass


# ─── Main Entry Point ──────────────────────────────────────────────────────────


async def main():
    port = int(os.getenv("DAEMON_PORT", "8080"))
    host = os.getenv("DAEMON_HOST", "localhost")
    relay_url = os.getenv("RELAY_URL", "").strip()
    user_id = os.getenv("RELAY_USER_ID", "").strip() or os.getenv("USER", "").strip() or "developer"

    state.vscode_available = check_vscode_cli()

    logger.info(f"vstunnel Daemon v{DAEMON_VERSION}")
    logger.info(f"VS Code CLI: {'available' if state.vscode_available else 'NOT FOUND'}")
    logger.info(f"Multi-instance support: enabled")

    if not state.vscode_available:
        logger.warning("VS Code CLI not in PATH — prompts will fail until 'code' is available")

    initial_workspaces = await state.workspace_manager.detect_workspaces()
    if initial_workspaces:
        logger.info(f"Detected {len(initial_workspaces)} workspace(s):")
        for ws in initial_workspaces:
            logger.info(f"  - {ws['name']} ({ws['folder_path']})")
    else:
        logger.info("No workspaces detected yet (will scan when clients connect)")

    loop = asyncio.get_running_loop()
    if sys.platform != "win32":
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, state.shutdown_event.set)

    if relay_url:
        # ── Relay client mode ──
        logger.info(f"Mode: RELAY CLIENT → {relay_url}")
        logger.info(f"User ID: {user_id}")
        await relay_client_loop(relay_url, user_id)
    else:
        # ── Standalone server mode ──
        logger.info(f"Mode: STANDALONE SERVER")
        logger.info(f"HTTP + WebSocket on http://{host}:{port}")
        logger.info(f"Mobile UI served at http://{host}:{port}/")

        app = create_app()
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, host, port)
        await site.start()

        logger.info("Daemon ready. Waiting for connections...")
        await state.shutdown_event.wait()

        logger.info("Shutting down gracefully...")
        for ws in list(state.connected_clients):
            try:
                await ws.close()
            except Exception:
                pass
        await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Daemon stopped.")
