"""In-memory session store for /touch <-> /tv pairing.

Touch screens register on load and publish their current frame as it changes.
TVs register on load, receive a 4-digit pairing code, and open an SSE stream.
Admin (/connect) pairs a touch session id to a TV's pairing code; the server
fans frame events from the paired touch into the TV's SSE queue.

State is in-memory only. Both touch and TV re-register on reload.
"""

from __future__ import annotations

import asyncio
import json
import random
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

TOUCH_TTL_SEC = 30
TV_TTL_SEC = 90
PRUNE_INTERVAL_SEC = 15
KEEPALIVE_SEC = 20
QUEUE_MAX = 64
PAIRING_CODE_DIGITS = 4


def _new_id() -> str:
    return uuid.uuid4().hex[:16]


@dataclass
class TouchSession:
    id: str
    kind: str = "touch"
    camera: Optional[str] = None
    current_frame: Optional[str] = None
    current_ts: Optional[str] = None
    range_lo_ts: Optional[str] = None
    range_hi_ts: Optional[str] = None
    playing: bool = True
    last_seen: float = field(default_factory=time.time)
    paired_tv_id: Optional[str] = None
    user_agent: str = ""


@dataclass
class TVSession:
    id: str
    kind: str = "tv"
    pairing_code: str = ""
    paired_touch_id: Optional[str] = None
    last_seen: float = field(default_factory=time.time)
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=QUEUE_MAX))
    user_agent: str = ""


class SessionStore:
    def __init__(self):
        self._lock = asyncio.Lock()
        self.touches: dict[str, TouchSession] = {}
        self.tvs: dict[str, TVSession] = {}
        self._pruner_task: Optional[asyncio.Task] = None

    async def start_pruner(self):
        if self._pruner_task is None or self._pruner_task.done():
            self._pruner_task = asyncio.create_task(self._run_pruner())

    async def _run_pruner(self):
        while True:
            try:
                await asyncio.sleep(PRUNE_INTERVAL_SEC)
                await self.prune()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[sessions] pruner error: {e}", flush=True)

    def _gen_pairing_code(self) -> str:
        used = {tv.pairing_code for tv in self.tvs.values() if tv.pairing_code}
        for _ in range(20):
            code = "".join(random.choices("0123456789", k=PAIRING_CODE_DIGITS))
            if code not in used:
                return code
        for _ in range(20):
            code = "".join(random.choices("0123456789", k=PAIRING_CODE_DIGITS + 1))
            if code not in used:
                return code
        return "".join(random.choices("0123456789", k=PAIRING_CODE_DIGITS + 2))

    async def register_touch(self, camera: Optional[str], user_agent: str = "",
                             touch_id: Optional[str] = None) -> TouchSession:
        async with self._lock:
            if touch_id and touch_id in self.touches:
                t = self.touches[touch_id]
                t.last_seen = time.time()
                if camera is not None:
                    t.camera = camera
                if user_agent:
                    t.user_agent = user_agent
                return t
            new_id = touch_id or _new_id()
            t = TouchSession(id=new_id, camera=camera, user_agent=user_agent)
            self.touches[t.id] = t
            return t

    async def heartbeat_touch(self, touch_id: str) -> bool:
        async with self._lock:
            t = self.touches.get(touch_id)
            if not t:
                return False
            t.last_seen = time.time()
            return True

    async def publish_touch_state(self, touch_id: str, payload: dict) -> tuple[bool, bool]:
        """Update touch state, fan out to paired TV. Returns (ok, paired)."""
        async with self._lock:
            t = self.touches.get(touch_id)
            if not t:
                return False, False
            t.last_seen = time.time()
            if "frame" in payload:
                t.current_frame = payload.get("frame")
            if "ts" in payload:
                t.current_ts = payload.get("ts")
            if "camera" in payload:
                t.camera = payload.get("camera")
            if "playing" in payload:
                t.playing = bool(payload.get("playing"))
            if "range_lo_ts" in payload:
                t.range_lo_ts = payload.get("range_lo_ts")
            if "range_hi_ts" in payload:
                t.range_hi_ts = payload.get("range_hi_ts")
            tv = self.tvs.get(t.paired_tv_id) if t.paired_tv_id else None
            if tv and t.current_frame:
                _fanout(tv, {
                    "type": "frame",
                    "frame": t.current_frame,
                    "camera": t.camera,
                    "ts": t.current_ts,
                })
            return True, tv is not None

    async def delete_touch(self, touch_id: str) -> bool:
        async with self._lock:
            t = self.touches.pop(touch_id, None)
            if not t:
                return False
            if t.paired_tv_id:
                tv = self.tvs.get(t.paired_tv_id)
                if tv:
                    tv.paired_touch_id = None
                    tv.pairing_code = self._gen_pairing_code()
                    _fanout(tv, {"type": "unpair", "pairing_code": tv.pairing_code})
            return True

    async def register_tv(self, tv_id: Optional[str], user_agent: str = "") -> TVSession:
        async with self._lock:
            if tv_id and tv_id in self.tvs:
                tv = self.tvs[tv_id]
                tv.last_seen = time.time()
                tv.user_agent = user_agent or tv.user_agent
                if not tv.paired_touch_id and not tv.pairing_code:
                    tv.pairing_code = self._gen_pairing_code()
                return tv
            tv = TVSession(id=_new_id(), user_agent=user_agent)
            tv.pairing_code = self._gen_pairing_code()
            self.tvs[tv.id] = tv
            return tv

    async def heartbeat_tv(self, tv_id: str) -> bool:
        async with self._lock:
            tv = self.tvs.get(tv_id)
            if not tv:
                return False
            tv.last_seen = time.time()
            return True

    async def get_tv(self, tv_id: str) -> Optional[TVSession]:
        async with self._lock:
            return self.tvs.get(tv_id)

    async def get_touch(self, touch_id: str) -> Optional[TouchSession]:
        async with self._lock:
            return self.touches.get(touch_id)

    async def pair(self, code: str, touch_id: str) -> tuple[Optional[TVSession], Optional[str]]:
        async with self._lock:
            target_tv = None
            for tv in self.tvs.values():
                if tv.pairing_code and tv.pairing_code == code and not tv.paired_touch_id:
                    target_tv = tv
                    break
            if not target_tv:
                return None, "pairing code not found"
            touch = self.touches.get(touch_id)
            if not touch:
                return None, "touch session not found"
            if touch.paired_tv_id and touch.paired_tv_id != target_tv.id:
                old_tv = self.tvs.get(touch.paired_tv_id)
                if old_tv:
                    old_tv.paired_touch_id = None
                    old_tv.pairing_code = self._gen_pairing_code()
                    _fanout(old_tv, {"type": "unpair", "pairing_code": old_tv.pairing_code})
            target_tv.paired_touch_id = touch.id
            target_tv.pairing_code = ""
            touch.paired_tv_id = target_tv.id
            _fanout(target_tv, {
                "type": "pair",
                "touch_id": touch.id,
                "camera": touch.camera,
                "frame": touch.current_frame,
                "ts": touch.current_ts,
            })
            if touch.current_frame:
                _fanout(target_tv, {
                    "type": "frame",
                    "frame": touch.current_frame,
                    "camera": touch.camera,
                    "ts": touch.current_ts,
                })
            return target_tv, None

    async def unpair(self, tv_id: Optional[str] = None, touch_id: Optional[str] = None) -> bool:
        async with self._lock:
            tv: Optional[TVSession] = None
            touch: Optional[TouchSession] = None
            if tv_id:
                tv = self.tvs.get(tv_id)
                if tv and tv.paired_touch_id:
                    touch = self.touches.get(tv.paired_touch_id)
            elif touch_id:
                touch = self.touches.get(touch_id)
                if touch and touch.paired_tv_id:
                    tv = self.tvs.get(touch.paired_tv_id)
            if not tv:
                return False
            if touch:
                touch.paired_tv_id = None
            tv.paired_touch_id = None
            tv.pairing_code = self._gen_pairing_code()
            _fanout(tv, {"type": "unpair", "pairing_code": tv.pairing_code})
            return True

    async def list_sessions(self) -> dict:
        now = time.time()
        async with self._lock:
            touches = [{
                "id": t.id,
                "camera": t.camera,
                "current_frame": t.current_frame,
                "current_ts": t.current_ts,
                "range_lo_ts": t.range_lo_ts,
                "range_hi_ts": t.range_hi_ts,
                "playing": t.playing,
                "last_seen_age_sec": round(now - t.last_seen, 1),
                "paired_tv_id": t.paired_tv_id,
            } for t in self.touches.values()]
            tvs = [{
                "id": tv.id,
                "pairing_code": tv.pairing_code,
                "paired_touch_id": tv.paired_touch_id,
                "last_seen_age_sec": round(now - tv.last_seen, 1),
            } for tv in self.tvs.values()]
        touches.sort(key=lambda x: x["last_seen_age_sec"])
        tvs.sort(key=lambda x: x["last_seen_age_sec"])
        return {"touches": touches, "tvs": tvs}

    async def prune(self):
        now = time.time()
        unpair_events: list[tuple[TVSession, str]] = []
        async with self._lock:
            dead_touches = [tid for tid, t in self.touches.items() if now - t.last_seen > TOUCH_TTL_SEC]
            for tid in dead_touches:
                t = self.touches.pop(tid)
                if t.paired_tv_id:
                    tv = self.tvs.get(t.paired_tv_id)
                    if tv:
                        tv.paired_touch_id = None
                        tv.pairing_code = self._gen_pairing_code()
                        unpair_events.append((tv, tv.pairing_code))
            dead_tvs = [tid for tid, tv in self.tvs.items() if now - tv.last_seen > TV_TTL_SEC]
            for tid in dead_tvs:
                tv = self.tvs.pop(tid)
                if tv.paired_touch_id:
                    touch = self.touches.get(tv.paired_touch_id)
                    if touch:
                        touch.paired_tv_id = None
        for tv, code in unpair_events:
            _fanout(tv, {"type": "unpair", "pairing_code": code})


def _fanout(tv: TVSession, event: dict[str, Any]) -> None:
    try:
        tv.queue.put_nowait(event)
    except asyncio.QueueFull:
        try:
            tv.queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
        try:
            tv.queue.put_nowait(event)
        except asyncio.QueueFull:
            pass


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


async def sse_event_generator(tv_id: str, request, store: "SessionStore"):
    tv = await store.get_tv(tv_id)
    if not tv:
        yield _sse("error", {"detail": "tv not registered"})
        return

    yield _sse("hello", {
        "paired": tv.paired_touch_id is not None,
        "pairing_code": tv.pairing_code,
    })

    if tv.paired_touch_id:
        touch = await store.get_touch(tv.paired_touch_id)
        if touch and touch.current_frame:
            yield _sse("frame", {
                "frame": touch.current_frame,
                "camera": touch.camera,
                "ts": touch.current_ts,
            })

    while True:
        if await request.is_disconnected():
            return
        try:
            evt = await asyncio.wait_for(tv.queue.get(), timeout=KEEPALIVE_SEC)
        except asyncio.TimeoutError:
            tv.last_seen = time.time()
            yield _sse("keepalive", {"t": int(time.time())})
            continue
        evt_type = evt.pop("type", "message")
        tv.last_seen = time.time()
        yield _sse(evt_type, evt)


STORE = SessionStore()
