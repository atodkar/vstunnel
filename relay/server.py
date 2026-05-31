#!/usr/bin/env python3
"""
vstunnel Relay Server v2 — Multi-instance Copilot bridge.

Laptops (VS Code extensions) connect outbound and register per-instance.
Phones connect and receive streamed events (file changes, diffs, terminal output).
Phone commands are routed to specific instances.

Endpoints:
  GET  /health              — Health check
  GET  /ws/laptop           — WebSocket for VS Code extension instances
  GET  /ws/phone            — WebSocket for phone clients
  GET  /api/connect         — HTTP polling: create phone session
  GET  /api/poll            — HTTP polling: receive messages
  POST /api/send            — HTTP polling: send command
  GET  /api/users           — List registered users and instances
  GET  /*                   — Serve mobile frontend
"""

import asyncio
import json
import logging
import os
import secrets
import signal
import sys
import uuid
from collections import deque
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

RELAY_VERSION = "2.0.0"
POLL_SESSION_TIMEOUT = 120
MAX_EVENT_BUFFER = 200
FRONTEND_DIR = Path(os.getenv("FRONTEND_DIR", str(Path(__file__).parent.parent / "frontend")))


# ─── State ────────────────────────────────────────────────────────────────────


class InstanceSession:
    """A single VS Code instance connected to the relay."""

    def __init__(self, instance_id: str, user_id: str, workspace_name: str,
                 workspace_path: str, ws):
        self.instance_id = instance_id
        self.user_id = user_id
        self.workspace_name = workspace_name
        self.workspace_path = workspace_path
        self.ws = ws
        self.connected_at = datetime.now(timezone.utc)
        self.last_seen = datetime.now(timezone.utc)
        self.pending_responses: dict[str, asyncio.Future] = {}
        self.event_buffer: deque = deque(maxlen=MAX_EVENT_BUFFER)
        self.seq = 0

    def to_dict(self) -> dict:
        return {
            "instance_id": self.instance_id,
            "user_id": self.user_id,
            "workspace_name": self.workspace_name,
            "workspace_path": self.workspace_path,
            "connected_at": self.connected_at.isoformat() + "Z",
            "online": not self.ws.closed,
            "event_count": len(self.event_buffer),
        }


class RelayState:
    def __init__(self):
        self.users: dict[str, dict] = {}
        # users[user_id] = {
        #   "token": str,
        #   "instances": {instance_id: InstanceSession}
        # }
        self.phone_ws_sessions: dict[int, dict] = {}
        # phone ws id -> {"user_id": str, "ws": WebSocketResponse}
        self.poll_sessions: dict[str, dict] = {}
        self.start_time = datetime.now(timezone.utc)
        self.total_prompts = 0
        self.shutdown_event = asyncio.Event()

    @property
    def uptime_seconds(self) -> int:
        return int((datetime.now(timezone.utc) - self.start_time).total_seconds())

    def register_instance(self, user_id: str, instance_id: str,
                          workspace_name: str, workspace_path: str, ws) -> str:
        if user_id not in self.users:
            self.users[user_id] = {
                "token": secrets.token_hex(16),
                "instances": {},
            }

        user = self.users[user_id]
        user["instances"][instance_id] = InstanceSession(
            instance_id, user_id, workspace_name, workspace_path, ws
        )
        logger.info(f"Instance registered: {user_id}/{workspace_name} ({instance_id})")
        return user["token"]

    def unregister_instance(self, user_id: str, instance_id: str):
        user = self.users.get(user_id)
        if user:
            user["instances"].pop(instance_id, None)
            if not user["instances"]:
                self.users.pop(user_id, None)
        logger.info(f"Instance unregistered: {user_id}/{instance_id}")

    def get_instance(self, user_id: str, instance_id: str) -> InstanceSession | None:
        user = self.users.get(user_id)
        if not user:
            return None
        instance = user["instances"].get(instance_id)
        if instance and not instance.ws.closed:
            return instance
        if instance and instance.ws.closed:
            user["instances"].pop(instance_id, None)
        return None

    def get_user_instances(self, user_id: str) -> list[InstanceSession]:
        user = self.users.get(user_id)
        if not user:
            return []
        live = []
        stale = []
        for iid, inst in user["instances"].items():
            if inst.ws.closed:
                stale.append(iid)
            else:
                live.append(inst)
        for iid in stale:
            user["instances"].pop(iid, None)
        return live

    def list_users(self) -> list[dict]:
        result = []
        stale_users = []
        for uid, user in self.users.items():
            instances = []
            stale_instances = []
            for iid, inst in user["instances"].items():
                if inst.ws.closed:
                    stale_instances.append(iid)
                else:
                    instances.append(inst.to_dict())
            for iid in stale_instances:
                user["instances"].pop(iid, None)
            if instances:
                result.append({
                    "user_id": uid,
                    "instances": instances,
                    "online": True,
                })
            else:
                stale_users.append(uid)
        for uid in stale_users:
            self.users.pop(uid, None)
        return result

    def verify_token(self, user_id: str, token: str) -> bool:
        user = self.users.get(user_id)
        if not user:
            return False
        return secrets.compare_digest(user["token"], token)

    def get_phone_sessions_for_user(self, user_id: str) -> list:
        return [
            s for s in self.phone_ws_sessions.values()
            if s["user_id"] == user_id
        ]

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

    def queue_poll_message(self, user_id: str, message: dict):
        for sid, session in self.poll_sessions.items():
            if session["user_id"] == user_id:
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


state = RelayState()


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
    total_instances = sum(
        len(u["instances"]) for u in state.users.values()
    )
    return web.json_response({
        "status": "healthy",
        "version": RELAY_VERSION,
        "uptime": state.uptime_seconds,
        "registered_users": len(state.users),
        "registered_instances": total_instances,
        "poll_sessions": len(state.poll_sessions),
        "total_prompts": state.total_prompts,
    }, headers=CORS_HEADERS)


async def handle_api_users(request):
    users = state.list_users()
    return web.json_response({"users": users}, headers=CORS_HEADERS)


async def handle_api_connect(request):
    """Phone creates a polling session targeted at a user."""
    user_id = request.query.get("user")
    token = (request.query.get("token") or
             request.headers.get("Authorization", "").replace("Bearer ", ""))

    if not user_id:
        return web.json_response(
            {"type": "ERROR", "message": "Missing 'user' parameter"},
            status=400, headers=CORS_HEADERS,
        )

    if not state.verify_token(user_id, token):
        return web.json_response(
            {"type": "ERROR", "message": "Invalid token"},
            status=401, headers=CORS_HEADERS,
        )

    instances = state.get_user_instances(user_id)
    if not instances:
        return web.json_response(
            {"type": "ERROR", "message": f"User '{user_id}' has no active instances"},
            status=404, headers=CORS_HEADERS,
        )

    state.cleanup_stale()
    session_id = state.create_poll_session(user_id)

    return web.json_response({
        "type": "WELCOME",
        "session_id": session_id,
        "version": RELAY_VERSION,
        "user_id": user_id,
        "instances": [i.to_dict() for i in instances],
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
    return web.json_response({"messages": messages}, headers=CORS_HEADERS)


async def handle_api_send(request):
    """Phone sends a command to a specific instance via HTTP."""
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
    instance_id = data.get("instance_id")

    if instance_id:
        return await forward_to_instance(user_id, instance_id, data, session_id=session_id)
    else:
        instances = state.get_user_instances(user_id)
        if instances:
            return await forward_to_instance(
                user_id, instances[0].instance_id, data, session_id=session_id
            )
        return web.json_response(
            {"type": "ERROR", "message": "No active instances"},
            status=502, headers=CORS_HEADERS,
        )


async def forward_to_instance(user_id: str, instance_id: str, data: dict,
                              session_id: str = None, phone_ws=None):
    """Forward a command from phone to a specific VS Code instance."""
    instance = state.get_instance(user_id, instance_id)
    if not instance:
        err = {"type": "ERROR", "message": f"Instance '{instance_id}' is offline"}
        if session_id:
            return web.json_response(err, status=502, headers=CORS_HEADERS)
        return err

    request_id = uuid.uuid4().hex[:12]
    data["_relay_request_id"] = request_id

    future = asyncio.get_event_loop().create_future()
    instance.pending_responses[request_id] = future

    try:
        await instance.ws.send_json(data)
    except Exception as e:
        instance.pending_responses.pop(request_id, None)
        err = {"type": "ERROR", "message": f"Failed to reach instance: {e}"}
        if session_id:
            return web.json_response(err, status=502, headers=CORS_HEADERS)
        return err

    try:
        response = await asyncio.wait_for(future, timeout=60.0)
    except asyncio.TimeoutError:
        instance.pending_responses.pop(request_id, None)
        err = {"type": "ERROR", "message": "Instance did not respond in time"}
        if session_id:
            return web.json_response(err, status=504, headers=CORS_HEADERS)
        return err

    response.pop("_relay_request_id", None)

    if data.get("type") == "PROMPT":
        state.total_prompts += 1

    if session_id:
        state.queue_poll_message(user_id, response)
        return web.json_response(response, headers=CORS_HEADERS)

    return response


async def push_event_to_phones(user_id: str, event: dict):
    """Push an event from a laptop instance to all connected phones for that user."""
    # Send to WebSocket phone clients
    for phone_session in state.get_phone_sessions_for_user(user_id):
        ws = phone_session.get("ws")
        if ws and not ws.closed:
            try:
                await ws.send_json(event)
            except Exception:
                pass

    # Queue for polling phone clients
    state.queue_poll_message(user_id, event)


# ─── WebSocket: Laptop (VS Code Extension) ──────────────────────────────────


async def handle_ws_laptop(request):
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)

    user_id = None
    instance_id = None

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
                    instance_id = data.get("instance_id", "").strip()
                    workspace_name = data.get("workspace_name", "Untitled")
                    workspace_path = data.get("workspace_path", "")

                    if not user_id:
                        await ws.send_json({"type": "ERROR", "message": "Missing user_id"})
                        continue

                    if not instance_id:
                        instance_id = uuid.uuid4().hex[:12]

                    token = state.register_instance(
                        user_id, instance_id, workspace_name, workspace_path, ws
                    )

                    await ws.send_json({
                        "type": "REGISTERED",
                        "user_id": user_id,
                        "instance_id": instance_id,
                        "token": token,
                        "relay_version": RELAY_VERSION,
                        "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
                    })

                elif msg_type == "PUSH_EVENT":
                    if user_id:
                        event = data.get("event", data)
                        event.pop("type", None)
                        event_type = event.pop("type", data.get("event", {}).get("type", "AGENT_ACTIVITY"))

                        # Reconstruct as a proper event
                        push_data = {**event, "type": event_type}
                        if "instance_id" not in push_data:
                            push_data["instance_id"] = instance_id
                        if "workspace" not in push_data:
                            push_data["workspace"] = data.get("workspace", "")

                        # Buffer the event
                        instance = state.get_instance(user_id, instance_id)
                        if instance:
                            instance.seq += 1
                            push_data["seq"] = instance.seq
                            instance.event_buffer.append(push_data)

                        await push_event_to_phones(user_id, push_data)

                elif msg_type == "RESPONSE":
                    request_id = data.get("_relay_request_id")
                    if user_id and instance_id and request_id:
                        instance = state.get_instance(user_id, instance_id)
                        if instance:
                            future = instance.pending_responses.pop(request_id, None)
                            if future and not future.done():
                                future.set_result(data)

                elif msg_type == "PONG":
                    if user_id and instance_id:
                        instance = state.get_instance(user_id, instance_id)
                        if instance:
                            instance.last_seen = datetime.now(timezone.utc)

            elif msg.type == web.WSMsgType.ERROR:
                logger.error(f"Laptop WS error ({user_id}/{instance_id}): {ws.exception()}")

    except Exception as e:
        logger.error(f"Laptop connection error ({user_id}/{instance_id}): {e}")
    finally:
        if user_id and instance_id:
            state.unregister_instance(user_id, instance_id)
        logger.info(f"Laptop disconnected: {user_id}/{instance_id}")

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

                    if not state.verify_token(target_user, token):
                        await ws.send_json({"type": "ERROR", "message": "Invalid token"})
                        continue

                    instances = state.get_user_instances(target_user)
                    if not instances:
                        await ws.send_json({"type": "ERROR", "message": f"User '{target_user}' has no active instances"})
                        continue

                    authenticated = True
                    state.phone_ws_sessions[id(ws)] = {"user_id": target_user, "ws": ws}

                    await ws.send_json({
                        "type": "WELCOME",
                        "version": RELAY_VERSION,
                        "user_id": target_user,
                        "instances": [i.to_dict() for i in instances],
                        "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
                    })

                elif msg_type == "LIST_USERS":
                    users = state.list_users()
                    await ws.send_json({"type": "USER_LIST", "users": users})

                elif msg_type == "GET_INSTANCES":
                    if authenticated and target_user:
                        instances = state.get_user_instances(target_user)
                        await ws.send_json({
                            "type": "INSTANCE_LIST",
                            "instances": [i.to_dict() for i in instances],
                        })

                elif msg_type == "GET_EVENTS_SINCE":
                    if authenticated and target_user:
                        instance_id = data.get("instance_id")
                        since_seq = data.get("since_seq", 0)
                        instance = state.get_instance(target_user, instance_id) if instance_id else None
                        if instance:
                            events = [e for e in instance.event_buffer if e.get("seq", 0) > since_seq]
                            await ws.send_json({"type": "EVENT_REPLAY", "events": events})
                        else:
                            await ws.send_json({"type": "EVENT_REPLAY", "events": []})

                elif authenticated and target_user:
                    instance_id = data.get("instance_id")
                    if instance_id:
                        response = await forward_to_instance(target_user, instance_id, data)
                    else:
                        instances = state.get_user_instances(target_user)
                        if instances:
                            response = await forward_to_instance(
                                target_user, instances[0].instance_id, data
                            )
                        else:
                            response = {"type": "ERROR", "message": "No active instances"}
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
    port = int(os.getenv("RELAY_PORT", "8100"))
    host = os.getenv("RELAY_HOST", "0.0.0.0")

    logger.info(f"vstunnel Relay Server v{RELAY_VERSION}")
    logger.info(f"Listening on {host}:{port}")
    logger.info(f"Laptop WebSocket: ws://{host}:{port}/ws/laptop")
    logger.info(f"Phone WebSocket:  ws://{host}:{port}/ws/phone")
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
    for uid, user in list(state.users.items()):
        for iid, inst in list(user["instances"].items()):
            try:
                await inst.ws.close()
            except Exception:
                pass
    await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Relay stopped.")
