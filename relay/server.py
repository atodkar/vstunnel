#!/usr/bin/env python3
"""
vstunnel Relay Server — Central bridge for corporate deployments.

Laptops connect outbound to this relay and register their user/workspace.
Phones connect to this relay and pick a user to send prompts to.
The relay routes messages between matched pairs. No data is stored.

Endpoints:
  GET  /health              — Health check
  GET  /ws/laptop           — WebSocket for laptop daemons
  GET  /ws/phone            — WebSocket for phone clients
  GET  /api/connect         — HTTP polling: create phone session
  GET  /api/poll            — HTTP polling: receive messages
  POST /api/send            — HTTP polling: send message
  GET  /api/users           — List registered laptop users
  GET  /*                   — Serve mobile frontend
"""

import asyncio
import hashlib
import json
import logging
import os
import secrets
import signal
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from aiohttp import web

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("vstunnel-relay")

RELAY_VERSION = "1.0.0"
POLL_SESSION_TIMEOUT = 120
FRONTEND_DIR = Path(os.getenv("FRONTEND_DIR", str(Path(__file__).parent.parent / "frontend")))
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "")


# ─── State ────────────────────────────────────────────────────────────────────


class LaptopSession:
    def __init__(self, user_id: str, ws, workspaces: list = None):
        self.user_id = user_id
        self.ws = ws
        self.workspaces = workspaces or []
        self.connected_at = datetime.now(timezone.utc)
        self.last_seen = datetime.now(timezone.utc)
        self.pending_responses: dict[str, asyncio.Future] = {}

    def to_dict(self) -> dict:
        return {
            "user_id": self.user_id,
            "workspaces": self.workspaces,
            "connected_at": self.connected_at.isoformat() + "Z",
            "online": not self.ws.closed,
        }


class RelayState:
    def __init__(self):
        self.laptops: dict[str, LaptopSession] = {}  # user_id -> LaptopSession
        self.phone_ws_sessions: dict[str, web.WebSocketResponse] = {}  # phone ws -> target user_id
        self.poll_sessions: dict[str, dict] = {}  # session_id -> {user_id, messages, last_poll}
        self.start_time = datetime.now(timezone.utc)
        self.total_prompts = 0
        self.auth_tokens: dict[str, str] = {}  # user_id -> token (generated on laptop register)
        self.shutdown_event = asyncio.Event()

    @property
    def uptime_seconds(self) -> int:
        return int((datetime.now(timezone.utc) - self.start_time).total_seconds())

    def register_laptop(self, user_id: str, ws, workspaces: list = None) -> str:
        token = self.auth_tokens.get(user_id, secrets.token_hex(16))
        self.auth_tokens[user_id] = token
        self.laptops[user_id] = LaptopSession(user_id, ws, workspaces)
        logger.info(f"Laptop registered: {user_id} ({len(workspaces or [])} workspaces)")
        return token

    def unregister_laptop(self, user_id: str):
        self.laptops.pop(user_id, None)
        logger.info(f"Laptop unregistered: {user_id}")

    def get_laptop(self, user_id: str) -> LaptopSession | None:
        session = self.laptops.get(user_id)
        if session and not session.ws.closed:
            return session
        if session and session.ws.closed:
            self.laptops.pop(user_id, None)
        return None

    def list_users(self) -> list[dict]:
        live = []
        stale = []
        for uid, session in self.laptops.items():
            if session.ws.closed:
                stale.append(uid)
            else:
                live.append(session.to_dict())
        for uid in stale:
            self.laptops.pop(uid, None)
        return live

    def create_poll_session(self, user_id: str) -> str:
        session_id = uuid.uuid4().hex[:16]
        self.poll_sessions[session_id] = {
            "user_id": user_id,
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
            if len(session["messages"]) > 200:
                session["messages"] = session["messages"][-200:]

    def drain_poll_messages(self, session_id: str) -> list:
        session = self.poll_sessions.get(session_id)
        if not session:
            return []
        messages = session["messages"]
        session["messages"] = []
        return messages

    def cleanup_stale(self):
        now = datetime.now(timezone.utc)
        stale = [
            sid for sid, s in self.poll_sessions.items()
            if (now - s["last_poll"]).total_seconds() > POLL_SESSION_TIMEOUT
        ]
        for sid in stale:
            del self.poll_sessions[sid]

        dead = [uid for uid, s in self.laptops.items() if s.ws.closed]
        for uid in dead:
            self.laptops.pop(uid, None)


state = RelayState()


# ─── Auth Helpers ─────────────────────────────────────────────────────────────


def verify_phone_token(user_id: str, token: str) -> bool:
    expected = state.auth_tokens.get(user_id)
    if not expected:
        return False
    return secrets.compare_digest(expected, token)


CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Session-Id, Authorization",
}


# ─── HTTP Handlers ────────────────────────────────────────────────────────────


async def handle_cors(request):
    return web.Response(status=204, headers=CORS_HEADERS)


async def handle_health(request):
    state.cleanup_stale()
    return web.json_response({
        "status": "healthy",
        "version": RELAY_VERSION,
        "uptime": state.uptime_seconds,
        "registered_laptops": len(state.laptops),
        "poll_sessions": len(state.poll_sessions),
        "total_prompts": state.total_prompts,
    }, headers=CORS_HEADERS)


async def handle_api_users(request):
    users = state.list_users()
    return web.json_response({"users": users}, headers=CORS_HEADERS)


async def handle_api_connect(request):
    """Phone creates a polling session targeted at a specific user."""
    user_id = request.query.get("user")
    token = request.query.get("token") or request.headers.get("Authorization", "").replace("Bearer ", "")

    if not user_id:
        return web.json_response(
            {"type": "ERROR", "message": "Missing 'user' query parameter"},
            status=400, headers=CORS_HEADERS,
        )

    if not verify_phone_token(user_id, token):
        return web.json_response(
            {"type": "ERROR", "message": "Invalid token for this user"},
            status=401, headers=CORS_HEADERS,
        )

    laptop = state.get_laptop(user_id)
    if not laptop:
        return web.json_response(
            {"type": "ERROR", "message": f"User '{user_id}' is not online"},
            status=404, headers=CORS_HEADERS,
        )

    state.cleanup_stale()
    session_id = state.create_poll_session(user_id)

    return web.json_response({
        "type": "WELCOME",
        "session_id": session_id,
        "version": RELAY_VERSION,
        "user_id": user_id,
        "workspaces": laptop.workspaces,
        "transport": "polling",
        "poll_interval_ms": 2000,
        "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
    }, headers=CORS_HEADERS)


async def handle_api_poll(request):
    session_id = request.headers.get("X-Session-Id") or request.query.get("session")

    if not session_id:
        return web.json_response(
            {"type": "ERROR", "message": "Missing session ID"},
            status=400, headers=CORS_HEADERS,
        )

    session = state.get_poll_session(session_id)
    if not session:
        return web.json_response(
            {"type": "ERROR", "message": "Invalid or expired session"},
            status=401, headers=CORS_HEADERS,
        )

    messages = state.drain_poll_messages(session_id)

    user_id = session["user_id"]
    laptop = state.get_laptop(user_id)
    status_msg = {
        "type": "STATUS_UPDATE",
        "user_id": user_id,
        "online": laptop is not None,
        "workspaces": laptop.workspaces if laptop else [],
        "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
    }
    messages.append(status_msg)

    return web.json_response({"messages": messages}, headers=CORS_HEADERS)


async def handle_api_send(request):
    """Phone sends a message to the laptop via HTTP."""
    session_id = request.headers.get("X-Session-Id") or request.query.get("session")

    session = state.get_poll_session(session_id) if session_id else None
    if not session:
        return web.json_response(
            {"type": "ERROR", "message": "Invalid or expired session"},
            status=401, headers=CORS_HEADERS,
        )

    try:
        data = await request.json()
    except Exception:
        return web.json_response(
            {"type": "ERROR", "message": "Invalid JSON"},
            status=400, headers=CORS_HEADERS,
        )

    user_id = session["user_id"]
    return await forward_to_laptop(user_id, data, session_id=session_id)


async def forward_to_laptop(user_id: str, data: dict, session_id: str = None, phone_ws=None):
    """Forward a message from a phone to the target laptop, wait for response."""
    laptop = state.get_laptop(user_id)
    if not laptop:
        err = {"type": "ERROR", "message": f"User '{user_id}' is offline"}
        if session_id:
            return web.json_response(err, status=502, headers=CORS_HEADERS)
        return err

    request_id = uuid.uuid4().hex[:12]
    data["_relay_request_id"] = request_id

    future = asyncio.get_event_loop().create_future()
    laptop.pending_responses[request_id] = future

    try:
        await laptop.ws.send_json(data)
    except Exception as e:
        laptop.pending_responses.pop(request_id, None)
        err = {"type": "ERROR", "message": f"Failed to reach laptop: {e}"}
        if session_id:
            return web.json_response(err, status=502, headers=CORS_HEADERS)
        return err

    try:
        response = await asyncio.wait_for(future, timeout=60.0)
    except asyncio.TimeoutError:
        laptop.pending_responses.pop(request_id, None)
        err = {"type": "ERROR", "message": "Laptop did not respond in time"}
        if session_id:
            return web.json_response(err, status=504, headers=CORS_HEADERS)
        return err

    response.pop("_relay_request_id", None)

    if data.get("type") == "PROMPT":
        state.total_prompts += 1

    if session_id:
        state.queue_poll_message(session_id, response)
        return web.json_response(response, headers=CORS_HEADERS)

    return response


# ─── WebSocket: Laptop ───────────────────────────────────────────────────────


async def handle_ws_laptop(request):
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)

    user_id = None

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    await ws.send_json({"type": "ERROR", "message": "Invalid JSON"})
                    continue

                msg_type = data.get("type")

                if msg_type == "REGISTER":
                    user_id = data.get("user_id", "").strip()
                    if not user_id:
                        await ws.send_json({"type": "ERROR", "message": "Missing user_id"})
                        continue

                    workspaces = data.get("workspaces", [])
                    token = state.register_laptop(user_id, ws, workspaces)

                    await ws.send_json({
                        "type": "REGISTERED",
                        "user_id": user_id,
                        "token": token,
                        "relay_version": RELAY_VERSION,
                        "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
                    })

                elif msg_type == "UPDATE_WORKSPACES":
                    if user_id and user_id in state.laptops:
                        state.laptops[user_id].workspaces = data.get("workspaces", [])
                        await ws.send_json({"type": "WORKSPACES_UPDATED"})

                elif msg_type == "RESPONSE":
                    request_id = data.get("_relay_request_id")
                    if user_id and request_id:
                        laptop = state.get_laptop(user_id)
                        if laptop:
                            future = laptop.pending_responses.pop(request_id, None)
                            if future and not future.done():
                                future.set_result(data)

                elif msg_type == "PONG":
                    if user_id and user_id in state.laptops:
                        state.laptops[user_id].last_seen = datetime.now(timezone.utc)

            elif msg.type == web.WSMsgType.ERROR:
                logger.error(f"Laptop WS error ({user_id}): {ws.exception()}")

    except Exception as e:
        logger.error(f"Laptop connection error ({user_id}): {e}")
    finally:
        if user_id:
            state.unregister_laptop(user_id)
        logger.info(f"Laptop disconnected: {user_id}")

    return ws


# ─── WebSocket: Phone ────────────────────────────────────────────────────────


async def handle_ws_phone(request):
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)

    target_user = None
    authenticated = False

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    await ws.send_json({"type": "ERROR", "message": "Invalid JSON"})
                    continue

                msg_type = data.get("type")

                if msg_type == "CONNECT_TO":
                    target_user = data.get("user_id", "").strip()
                    token = data.get("token", "")

                    if not target_user:
                        await ws.send_json({"type": "ERROR", "message": "Missing user_id"})
                        continue

                    if not verify_phone_token(target_user, token):
                        await ws.send_json({"type": "ERROR", "message": "Invalid token"})
                        continue

                    laptop = state.get_laptop(target_user)
                    if not laptop:
                        await ws.send_json({"type": "ERROR", "message": f"User '{target_user}' is offline"})
                        continue

                    authenticated = True
                    state.phone_ws_sessions[id(ws)] = target_user

                    await ws.send_json({
                        "type": "WELCOME",
                        "version": RELAY_VERSION,
                        "user_id": target_user,
                        "workspaces": laptop.workspaces,
                        "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
                    })

                elif msg_type == "LIST_USERS":
                    users = state.list_users()
                    await ws.send_json({"type": "USER_LIST", "users": users})

                elif authenticated and target_user:
                    response = await forward_to_laptop(target_user, data)
                    if isinstance(response, dict):
                        await ws.send_json(response)

                else:
                    await ws.send_json({"type": "ERROR", "message": "Not authenticated. Send CONNECT_TO first."})

            elif msg.type == web.WSMsgType.ERROR:
                logger.error(f"Phone WS error: {ws.exception()}")

    except Exception as e:
        logger.error(f"Phone connection error: {e}")
    finally:
        state.phone_ws_sessions.pop(id(ws), None)

    return ws


# ─── App Setup ────────────────────────────────────────────────────────────────


def create_app() -> web.Application:
    app = web.Application()

    app.router.add_route("OPTIONS", "/{path:.*}", handle_cors)

    app.router.add_get("/health", handle_health)
    app.router.add_get("/api/users", handle_api_users)
    app.router.add_get("/api/connect", handle_api_connect)
    app.router.add_get("/api/poll", handle_api_poll)
    app.router.add_post("/api/send", handle_api_send)

    app.router.add_get("/ws/laptop", handle_ws_laptop)
    app.router.add_get("/ws/phone", handle_ws_phone)

    if FRONTEND_DIR.is_dir():
        async def serve_index(request):
            return web.FileResponse(FRONTEND_DIR / "index.html")

        app.router.add_get("/", serve_index)
        app.router.add_static("/css", FRONTEND_DIR / "css")
        app.router.add_static("/js", FRONTEND_DIR / "js")
        logger.info(f"Serving frontend from {FRONTEND_DIR}")

    return app


async def main():
    port = int(os.getenv("RELAY_PORT", "8080"))
    host = os.getenv("RELAY_HOST", "0.0.0.0")

    logger.info(f"vstunnel Relay Server v{RELAY_VERSION}")
    logger.info(f"Listening on {host}:{port}")
    logger.info(f"Laptop WebSocket: ws://{host}:{port}/ws/laptop")
    logger.info(f"Phone WebSocket:  ws://{host}:{port}/ws/phone")
    logger.info(f"Phone HTTP API:   http://{host}:{port}/api/connect")
    logger.info(f"Mobile UI:        http://{host}:{port}/")

    app = create_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()

    logger.info("Relay ready. Waiting for connections...")

    loop = asyncio.get_running_loop()
    if sys.platform != "win32":
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, state.shutdown_event.set)

    await state.shutdown_event.wait()

    logger.info("Shutting down...")
    for uid, session in list(state.laptops.items()):
        try:
            await session.ws.close()
        except Exception:
            pass
    await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Relay stopped.")
