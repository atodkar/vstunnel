#!/usr/bin/env python3
"""
vstunnel Copilot Daemon - Local WebSocket Server
Manages connections from mobile UI and executes prompts in VS Code.
Supports multiple VS Code instances via workspace detection and targeting.
Provides health check HTTP endpoint alongside the WebSocket service.
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
from datetime import datetime, timezone
from http import HTTPStatus
from pathlib import Path

import websockets
import logging

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("vstunnel")

DAEMON_VERSION = "1.2.0"
MAX_PROMPT_LENGTH = 10_000
HEARTBEAT_INTERVAL = 20
STATUS_INTERVAL = 3


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
                "wmic", "process", "where",
                "name like '%Code%'",
                "get", "ProcessId,CommandLine",
                "/format:csv",
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
                        ws = Workspace(
                            workspace_id=self._path_to_id(str(path)),
                            folder_path=str(path),
                            name=path.name,
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
            r'--folder-uri\s+file://(/[^\s]+)',
            r'--folder-uri\s+"file://([^"]+)"',
            r'--user-data-dir\s+([^\s]+)',
        ]
        for pat in patterns:
            match = re.search(pat, cmdline)
            if match:
                return match.group(1)

        parts = cmdline.split()
        for part in reversed(parts):
            if part.startswith("/") and not part.startswith("--"):
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


state = DaemonState()


# ─── VS Code Execution ─────────────────────────────────────────────────────────


def check_vscode_cli() -> bool:
    return shutil.which("code") is not None


async def execute_vscode_command(prompt: str, workspace_folder: str = None) -> dict:
    """
    Invoke VS Code CLI to inject prompt into inline chat.

    If workspace_folder is provided, targets that specific VS Code instance
    using --reuse-window and --folder-uri to route to the correct window.
    """
    if not state.vscode_available:
        return {
            "status": "ERROR",
            "message": "VS Code CLI ('code') not found in PATH",
            "exit_code": -1,
        }

    try:
        cmd = ["code"]

        if workspace_folder:
            cmd.extend(["--reuse-window", "--folder-uri", f"file://{workspace_folder}"])

        cmd.extend(["--inline-chat", prompt])

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
            logger.info(f"Prompt injected{target}: {prompt[:60]}...")
            return {
                "status": "SUCCESS",
                "message": f"Prompt executed in VS Code{target}",
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


# ─── WebSocket Handlers ────────────────────────────────────────────────────────


async def stream_status(websocket):
    """Push periodic status updates to connected mobile clients."""
    try:
        while True:
            workspaces = await state.workspace_manager.detect_workspaces()
            packet = {
                "type": "STATUS_UPDATE",
                "status": "READY_AND_LISTENING",
                "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
                "os": platform.system(),
                "version": DAEMON_VERSION,
                "connected_clients": len(state.connected_clients),
                "uptime": state.uptime_seconds,
                "total_prompts": state.total_prompts_executed,
                "vscode_available": state.vscode_available,
                "workspaces": workspaces,
            }
            await websocket.send(json.dumps(packet))
            await asyncio.sleep(STATUS_INTERVAL)
    except websockets.exceptions.ConnectionClosed:
        pass


async def heartbeat(websocket):
    """Send periodic pings to detect stale connections."""
    try:
        while True:
            await asyncio.sleep(HEARTBEAT_INTERVAL)
            pong = await websocket.ping()
            await asyncio.wait_for(pong, timeout=10)
    except (asyncio.TimeoutError, websockets.exceptions.ConnectionClosed):
        pass


async def handle_connection(websocket):
    """Manage a single WebSocket client session."""
    remote = websocket.remote_address
    logger.info(f"Client connected: {remote}")
    state.connected_clients.add(websocket)

    status_task = asyncio.create_task(stream_status(websocket))
    heartbeat_task = asyncio.create_task(heartbeat(websocket))

    try:
        workspaces = await state.workspace_manager.detect_workspaces()
        welcome = {
            "type": "WELCOME",
            "version": DAEMON_VERSION,
            "os": platform.system(),
            "vscode_available": state.vscode_available,
            "workspaces": workspaces,
            "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
        }
        await websocket.send(json.dumps(welcome))

        async for message in websocket:
            try:
                data = json.loads(message)
            except json.JSONDecodeError:
                await websocket.send(json.dumps({
                    "type": "ERROR",
                    "message": "Invalid JSON",
                }))
                continue

            msg_type = data.get("type")

            if msg_type == "PROMPT":
                prompt_text = data.get("payload", "").strip()
                workspace_id = data.get("workspace_id")

                if not prompt_text:
                    await websocket.send(json.dumps({
                        "type": "ERROR",
                        "message": "Empty prompt",
                    }))
                    continue

                if len(prompt_text) > MAX_PROMPT_LENGTH:
                    await websocket.send(json.dumps({
                        "type": "ERROR",
                        "message": f"Prompt exceeds {MAX_PROMPT_LENGTH} characters",
                    }))
                    continue

                workspace_folder = None
                workspace_name = None
                if workspace_id:
                    workspace_folder = await state.workspace_manager.resolve_folder(workspace_id)
                    if workspace_folder:
                        workspace_name = Path(workspace_folder).name
                        logger.info(f"Targeting workspace: {workspace_name}")
                    else:
                        logger.warning(f"Workspace ID '{workspace_id}' not found, using default")

                logger.info(f"Received prompt ({len(prompt_text)} chars): {prompt_text[:60]}...")
                result = await execute_vscode_command(prompt_text, workspace_folder)
                state.record_prompt(prompt_text, result, workspace_name)

                response = {
                    "type": "PROMPT_ACK",
                    "result": result,
                    "workspace": workspace_name,
                    "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
                }
                await websocket.send(json.dumps(response))

            elif msg_type == "PING":
                await websocket.send(json.dumps({
                    "type": "PONG",
                    "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
                }))

            elif msg_type == "LIST_WORKSPACES":
                workspaces = await state.workspace_manager.detect_workspaces()
                await websocket.send(json.dumps({
                    "type": "WORKSPACES",
                    "workspaces": workspaces,
                    "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
                }))

            elif msg_type == "REGISTER_WORKSPACE":
                folder_path = data.get("folder_path", "").strip()
                if folder_path:
                    result = state.workspace_manager.register_manual(folder_path)
                    if result:
                        await websocket.send(json.dumps({
                            "type": "WORKSPACE_REGISTERED",
                            "workspace": result,
                        }))
                    else:
                        await websocket.send(json.dumps({
                            "type": "ERROR",
                            "message": f"Invalid folder path: {folder_path}",
                        }))

            elif msg_type == "HISTORY":
                await websocket.send(json.dumps({
                    "type": "HISTORY_RESPONSE",
                    "history": state.prompt_history[-20:],
                }))

            else:
                await websocket.send(json.dumps({
                    "type": "ERROR",
                    "message": f"Unknown message type: {msg_type}",
                }))

    except websockets.exceptions.ConnectionClosed:
        logger.info(f"Client disconnected: {remote}")
    except Exception as e:
        logger.error(f"Connection error ({remote}): {e}")
    finally:
        state.connected_clients.discard(websocket)
        status_task.cancel()
        heartbeat_task.cancel()


# ─── HTTP Health Check ─────────────────────────────────────────────────────────


async def health_check(path, request_headers):
    """HTTP health check endpoint at /health."""
    if path == "/health":
        body = json.dumps({
            "status": "healthy",
            "version": DAEMON_VERSION,
            "uptime": state.uptime_seconds,
            "connected_clients": len(state.connected_clients),
            "vscode_available": state.vscode_available,
        }).encode()
        return HTTPStatus.OK, [("Content-Type", "application/json")], body
    return None


# ─── Main Entry Point ──────────────────────────────────────────────────────────


async def main():
    port = int(os.getenv("DAEMON_PORT", "8080"))
    host = os.getenv("DAEMON_HOST", "localhost")

    state.vscode_available = check_vscode_cli()

    logger.info(f"vstunnel Daemon v{DAEMON_VERSION}")
    logger.info(f"Listening on {host}:{port}")
    logger.info(f"VS Code CLI: {'available' if state.vscode_available else 'NOT FOUND'}")
    logger.info(f"Multi-instance support: enabled")
    logger.info(f"Next: Forward port {port} in VS Code Ports panel (set visibility to Public)")

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

    async with websockets.serve(
        handle_connection,
        host,
        port,
        process_request=health_check,
        ping_interval=None,
    ):
        logger.info("Daemon ready. Waiting for connections...")
        await state.shutdown_event.wait()

    logger.info("Shutting down gracefully...")
    for ws in list(state.connected_clients):
        await ws.close(1001, "Server shutting down")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Daemon stopped.")
