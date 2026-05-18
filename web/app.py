import json
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import cv2
import docker
import psutil
import yaml
from astral import LocationInfo
from astral.sun import sun
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from sessions import STORE, sse_event_generator

IMAGE_DIR = Path(os.environ.get("IMAGE_DIR", "/data/images"))
VIDEO_DIR = Path(os.environ.get("VIDEO_DIR", "/data/videos"))
EVENTS_DIR = Path(os.environ.get("EVENTS_DIR", "/data/events"))
EVENTS_FILE = EVENTS_DIR / "events.json"
CAMERAS_PATH = os.environ.get("CAMERAS_PATH", "/config/cameras.json")
CONFIG_PATH = os.environ.get("CONFIG_PATH", "/config/config.yaml")
APP_START_TS = time.time()
_request_count = 0
_docker_client = None
DENVER = LocationInfo("Denver", "USA", "America/Denver", 39.7392, -104.9903)
UTC_TZ = ZoneInfo("UTC")
LOCAL_TZ = ZoneInfo("America/Denver")
TEMPLATES = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))
TIMESTAMP_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.jpg$")


def load_cameras():
    try:
        with open(CAMERAS_PATH) as f:
            return json.load(f).get("cameras", [])
    except Exception as e:
        print(f"cameras.json load failed: {e}", flush=True)
        return [{"name": "north"}]


def load_config():
    try:
        with open(CONFIG_PATH) as f:
            return yaml.safe_load(f) or {}
    except Exception as e:
        print(f"config.yaml load failed: {e}", flush=True)
        return {}


CAMERAS = load_cameras()
CAMERA_NAMES = [c["name"] for c in CAMERAS]
DEFAULT_CAMERA = CAMERA_NAMES[0] if CAMERA_NAMES else "north"
CONFIG = load_config()
MAX_AGE_DAYS = float(CONFIG.get("max_age_days", 4))
MAX_SIZE_GB = float(CONFIG.get("max_size_gb", 10))
CHECK_INTERVAL = int(CONFIG.get("check_interval_seconds", 30))
ADMIN_PASSWORD = str(CONFIG.get("admin_password", "11115"))

_events_lock = threading.Lock()


def _load_events():
    if not EVENTS_FILE.exists():
        return []
    try:
        return json.loads(EVENTS_FILE.read_text() or "[]")
    except Exception as e:
        print(f"events load error: {e}", flush=True)
        return []


def _save_events(events):
    EVENTS_DIR.mkdir(parents=True, exist_ok=True)
    EVENTS_FILE.write_text(json.dumps(events, indent=2))


app = FastAPI()
app.mount("/static", StaticFiles(directory=str(Path(__file__).parent / "static")), name="static")


@app.on_event("startup")
async def _start_session_pruner():
    await STORE.start_pruner()


@app.middleware("http")
async def _count_req(request, call_next):
    global _request_count
    _request_count += 1
    return await call_next(request)


def _require_admin(request: Request):
    if request.headers.get("X-Admin-Pin") != ADMIN_PASSWORD:
        raise HTTPException(401, "admin required")


_ENGINE_CANDIDATES = (
    ("podman", "unix:///var/run/podman.sock"),
    ("docker", "unix:///var/run/docker.sock"),
)
_engine_name = None


def _docker():
    """Connect to podman first, then docker. Cache first working client."""
    global _docker_client, _engine_name
    if _docker_client is not None:
        return _docker_client
    errors = []
    for name, url in _ENGINE_CANDIDATES:
        try:
            client = docker.DockerClient(base_url=url, timeout=3)
            client.ping()
            _docker_client = client
            _engine_name = name
            return _docker_client
        except Exception as e:
            errors.append(f"{name}: {e}")
    raise RuntimeError("no container runtime reachable — " + "; ".join(errors))


PROJECT_LABEL = os.environ.get("COMPOSE_PROJECT", "denver-skyimage")
_PROJECT_LABEL_KEYS = (
    "com.docker.compose.project",
    "io.podman.compose.project",
    "PODMAN_SYSTEMD_UNIT",
)


def _list_project_containers(client):
    """Return project containers across docker + podman compose label schemes.

    Falls back to container-name prefix (docker compose uses `proj-svc-N`,
    podman-compose uses `proj_svc_N`) so videogen is detectable under podman.
    """
    found = {}
    for key in _PROJECT_LABEL_KEYS:
        try:
            for c in client.containers.list(all=True, filters={"label": f"{key}={PROJECT_LABEL}"}):
                found[c.id] = c
        except Exception:
            pass
    if found:
        return list(found.values())
    prefixes = (f"{PROJECT_LABEL}-", f"{PROJECT_LABEL}_")
    for c in client.containers.list(all=True):
        if c.name.startswith(prefixes):
            found[c.id] = c
    return list(found.values())


def _stats_to_metrics(s):
    """Extract cpu/mem from docker- or podman-compat stats. Both return 0 if shape unknown."""
    cpu_pct = 0.0
    mem = 0
    mem_lim = 1
    cpu = s.get("cpu_stats") or {}
    pre = s.get("precpu_stats") or {}
    if cpu and "cpu_usage" in cpu:
        cd = cpu["cpu_usage"].get("total_usage", 0) - (pre.get("cpu_usage") or {}).get("total_usage", 0)
        sd = cpu.get("system_cpu_usage", 0) - pre.get("system_cpu_usage", 0)
        ncpu = cpu.get("online_cpus") or len(cpu["cpu_usage"].get("percpu_usage") or [1])
        if sd > 0:
            cpu_pct = (cd / sd) * ncpu * 100.0
    mstats = s.get("memory_stats") or {}
    if mstats:
        mem = mstats.get("usage", 0) or 0
        mem_lim = mstats.get("limit", 1) or 1
    # podman docker-compat sometimes returns {"Stats":[{...}]} shape
    pod = s.get("Stats")
    if (not mem or not cpu_pct) and isinstance(pod, list) and pod:
        p = pod[0]
        cpu_pct = cpu_pct or float(p.get("CPU", 0) or 0)
        mem = mem or int(p.get("MemUsage", 0) or 0)
        mem_lim = mem_lim if mem_lim > 1 else int(p.get("MemLimit", 1) or 1)
    return cpu_pct, mem, mem_lim


def _container_stats():
    """Return (containers, error, engine). Error non-empty if no runtime reachable."""
    out = []
    try:
        client = _docker()
        cs = _list_project_containers(client)
    except Exception as e:
        msg = f"container runtime unreachable ({e})"
        print(f"docker/podman stats failed: {e}", flush=True)
        return out, msg, None
    for c in cs:
        if c.status != "running":
            out.append({"name": c.name, "status": c.status, "cpu_pct": 0.0, "mem_mb": 0.0, "mem_pct": 0.0})
            continue
        try:
            s = c.stats(stream=False)
            cpu_pct, mem, mem_lim = _stats_to_metrics(s)
            out.append({
                "name": c.name, "status": c.status,
                "cpu_pct": round(cpu_pct, 1),
                "mem_mb": round(mem / 1024 / 1024, 1),
                "mem_pct": round(mem / mem_lim * 100.0, 1) if mem_lim else 0.0,
            })
        except Exception as e:
            out.append({"name": c.name, "status": c.status, "cpu_pct": 0.0, "mem_mb": 0.0, "mem_pct": 0.0, "error": str(e)})
    err = "" if cs else "no project containers found (checked docker + podman compose labels and name prefix)"
    return out, err, _engine_name


VIDEO_RE = re.compile(r"^(.+?)_(\d{4}-\d{2}-\d{2})\.mp4$")


def list_videos():
    """Return list of dicts: {camera, day, name, size_bytes, mtime} sorted desc by day."""
    out = []
    if not VIDEO_DIR.exists():
        return out
    for cam_dir in VIDEO_DIR.iterdir():
        if not cam_dir.is_dir():
            continue
        for p in cam_dir.iterdir():
            if not p.is_file():
                continue
            m = VIDEO_RE.match(p.name)
            if not m:
                continue
            try:
                st = p.stat()
            except OSError:
                continue
            out.append({
                "camera": cam_dir.name,
                "day": m.group(2),
                "name": p.name,
                "size_bytes": st.st_size,
                "mtime": st.st_mtime,
            })
    out.sort(key=lambda v: (v["day"], v["camera"]), reverse=True)
    return out


def _dir_size(p: Path):
    total = 0
    if p.exists():
        for f in p.iterdir():
            if f.is_file() and TIMESTAMP_RE.match(f.name):
                try:
                    total += f.stat().st_size
                except OSError:
                    pass
    return total


_FRAME_CACHE_MAX = int(os.environ.get("FRAME_CACHE_MAX", "2000"))
_frame_cache: "OrderedDict[str, bytes]" = OrderedDict()
_frame_cache_lock = threading.Lock()


def _read_frame_cached(path: Path) -> bytes:
    key = str(path)
    with _frame_cache_lock:
        data = _frame_cache.get(key)
        if data is not None:
            _frame_cache.move_to_end(key)
            return data
    data = path.read_bytes()
    with _frame_cache_lock:
        _frame_cache[key] = data
        _frame_cache.move_to_end(key)
        while len(_frame_cache) > _FRAME_CACHE_MAX:
            _frame_cache.popitem(last=False)
    return data


def resolve_camera(camera, cam):
    name = camera or cam
    if not name or name == DEFAULT_CAMERA:
        return None
    if name not in CAMERA_NAMES:
        raise HTTPException(404, f"unknown camera: {name}")
    return name


def camera_image_dir(subdir):
    return IMAGE_DIR if subdir is None else IMAGE_DIR / subdir


def list_frames(subdir=None):
    frames = []
    d = camera_image_dir(subdir)
    if not d.exists():
        return frames
    for p in d.iterdir():
        if not p.is_file():
            continue
        m = TIMESTAMP_RE.match(p.name)
        if not m:
            continue
        try:
            ts_utc = datetime.strptime(m.group(1), "%Y-%m-%d_%H-%M-%S").replace(tzinfo=UTC_TZ)
        except ValueError:
            continue
        ts_local = ts_utc.astimezone(LOCAL_TZ).replace(tzinfo=None)
        frames.append((ts_local, p.name))
    frames.sort(key=lambda x: x[0])
    return frames


def parse_ts(s):
    try:
        return datetime.strptime(s, "%Y-%m-%d_%H-%M-%S")
    except (ValueError, TypeError):
        return None


def _check_camera_name(name: str) -> str:
    if name not in CAMERA_NAMES:
        raise HTTPException(404, f"unknown camera: {name}")
    return name


@app.post("/api/admin-auth")
async def api_admin_auth(req: Request):
    body = await req.json()
    pin = str(body.get("pin", ""))
    if pin != ADMIN_PASSWORD:
        return JSONResponse({"ok": False}, status_code=401)
    return JSONResponse({"ok": True})


@app.post("/api/sessions/touch")
async def api_touch_register(req: Request):
    body = {}
    try:
        body = await req.json()
    except Exception:
        pass
    camera = body.get("camera") if isinstance(body, dict) else None
    ua = req.headers.get("User-Agent", "")
    t = await STORE.register_touch(camera=camera, user_agent=ua)
    return {"id": t.id, "kind": t.kind, "camera": t.camera}


@app.post("/api/sessions/touch/{touch_id}/heartbeat")
async def api_touch_heartbeat(touch_id: str):
    ok = await STORE.heartbeat_touch(touch_id)
    if not ok:
        raise HTTPException(404, "touch not registered")
    return {"ok": True}


@app.post("/api/sessions/touch/{touch_id}/state")
async def api_touch_state(touch_id: str, req: Request):
    body = await req.json()
    ok, paired = await STORE.publish_touch_state(touch_id, body or {})
    if not ok:
        raise HTTPException(404, "touch not registered")
    return {"ok": True, "paired": paired}


@app.post("/api/sessions/touch/{touch_id}/delete")
async def api_touch_delete(touch_id: str):
    await STORE.delete_touch(touch_id)
    return {"ok": True}


@app.post("/api/sessions/tv")
async def api_tv_register(req: Request):
    body = {}
    try:
        body = await req.json()
    except Exception:
        pass
    tv_id = body.get("id") if isinstance(body, dict) else None
    ua = req.headers.get("User-Agent", "")
    tv = await STORE.register_tv(tv_id=tv_id, user_agent=ua)
    return {"id": tv.id, "pairing_code": tv.pairing_code, "paired_touch_id": tv.paired_touch_id}


@app.get("/api/sse/tv/{tv_id}")
async def api_sse_tv(tv_id: str, request: Request):
    tv = await STORE.get_tv(tv_id)
    if not tv:
        raise HTTPException(404, "tv not registered")
    return StreamingResponse(
        sse_event_generator(tv_id, request, STORE),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.get("/api/sessions")
async def api_sessions_list(request: Request):
    _require_admin(request)
    return await STORE.list_sessions()


@app.post("/api/sessions/pair")
async def api_sessions_pair(request: Request):
    _require_admin(request)
    body = await request.json()
    code = str(body.get("code", "")).strip()
    touch_id = str(body.get("touch_id", "")).strip()
    if not code or not touch_id:
        raise HTTPException(400, "code and touch_id required")
    tv, err = await STORE.pair(code, touch_id)
    if not tv:
        raise HTTPException(404, err or "pair failed")
    return {"ok": True, "tv_id": tv.id, "touch_id": touch_id}


@app.post("/api/sessions/unpair")
async def api_sessions_unpair(request: Request):
    _require_admin(request)
    body = await request.json()
    tv_id = body.get("tv_id")
    touch_id = body.get("touch_id")
    if not tv_id and not touch_id:
        raise HTTPException(400, "tv_id or touch_id required")
    await STORE.unpair(tv_id=tv_id, touch_id=touch_id)
    return {"ok": True}


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return TEMPLATES.TemplateResponse(request, "home.html", {"cameras": CAMERA_NAMES})


@app.get("/camera/{name}", response_class=HTMLResponse)
def index_for_camera(name: str, request: Request):
    _check_camera_name(name)
    return TEMPLATES.TemplateResponse(request, "index.html", {"camera_name": name})


@app.get("/browse", response_class=HTMLResponse)
def browse(request: Request):
    return TEMPLATES.TemplateResponse(request, "browse.html", {"camera_name": None})


@app.get("/browse/{name}", response_class=HTMLResponse)
def browse_for_camera(name: str, request: Request):
    _check_camera_name(name)
    return TEMPLATES.TemplateResponse(request, "browse.html", {"camera_name": name})


@app.get("/events", response_class=HTMLResponse)
def events_page(request: Request):
    return TEMPLATES.TemplateResponse(request, "events.html")


@app.get("/live", response_class=HTMLResponse)
def live(request: Request):
    return TEMPLATES.TemplateResponse(request, "live.html", {"touch_mode": False})


@app.get("/live/{name}", response_class=HTMLResponse)
def live_for_camera(name: str, request: Request):
    _check_camera_name(name)
    return TEMPLATES.TemplateResponse(request, "live.html", {"touch_mode": False, "camera_name": name})


@app.get("/touch", response_class=HTMLResponse)
def touch(request: Request, days: int = 2):
    return TEMPLATES.TemplateResponse(request, "live.html", {"touch_mode": True, "days": max(1, days)})


@app.get("/touch/{name}", response_class=HTMLResponse)
def touch_for_camera(name: str, request: Request, days: int = 2):
    _check_camera_name(name)
    return TEMPLATES.TemplateResponse(request, "live.html",
                                      {"touch_mode": True, "camera_name": name, "days": max(1, days)})


@app.get("/camera/{name}/last-hour", response_class=HTMLResponse)
def camera_last_hour(name: str, request: Request):
    _check_camera_name(name)
    return TEMPLATES.TemplateResponse(request, "last_hour.html", {"camera_name": name})


@app.get("/touch/{name}/last-hour", response_class=HTMLResponse)
def touch_last_hour(name: str, request: Request):
    _check_camera_name(name)
    return TEMPLATES.TemplateResponse(request, "last_hour.html", {"camera_name": name})


@app.get("/last", response_class=HTMLResponse)
def last_live(request: Request):
    return TEMPLATES.TemplateResponse(request, "last_live.html", {"camera_name": DEFAULT_CAMERA})


@app.get("/last/{name}", response_class=HTMLResponse)
def last_live_for_camera(name: str, request: Request):
    _check_camera_name(name)
    return TEMPLATES.TemplateResponse(request, "last_live.html", {"camera_name": name})


@app.get("/tv", response_class=HTMLResponse)
def tv_page(request: Request):
    return TEMPLATES.TemplateResponse(request, "tv.html", {})


@app.get("/connect", response_class=HTMLResponse)
def connect_page(request: Request):
    return TEMPLATES.TemplateResponse(request, "connect.html", {})


@app.get("/api/cameras")
def api_cameras():
    return {"default": DEFAULT_CAMERA, "cameras": CAMERA_NAMES}


@app.get("/api/latest/{name}")
def api_latest(name: str):
    _check_camera_name(name)
    sub = None if name == DEFAULT_CAMERA else name
    frames = list_frames(sub)
    if not frames:
        raise HTTPException(404, "no frames")
    ts, fname = frames[-1]
    return {"name": fname, "ts": ts.isoformat()}


@app.get("/api/frames")
def api_frames(since: str | None = None, camera: str | None = None, cam: str | None = None):
    sub = resolve_camera(camera, cam)
    frames = list_frames(sub)
    if since:
        frames = [f for f in frames if f[0].strftime("%Y-%m-%d_%H-%M-%S") > since]
    return JSONResponse([
        {"name": name, "ts": ts.isoformat()} for ts, name in frames
    ])


@app.get("/api/anchors")
def api_anchors(camera: str | None = None, cam: str | None = None):
    sub = resolve_camera(camera, cam)
    frames = list_frames(sub)
    days = sorted({ts.date() for ts, _ in frames})
    out = []
    for d in days:
        try:
            s = sun(DENVER.observer, date=d, tzinfo=DENVER.timezone)
            out.append({
                "day": d.isoformat(),
                "sunrise": s["sunrise"].strftime("%H:%M"),
                "sunset": s["sunset"].strftime("%H:%M"),
            })
        except Exception:
            continue
    return out


@app.get("/api/days")
def api_days(camera: str | None = None, cam: str | None = None):
    sub = resolve_camera(camera, cam)
    frames = list_frames(sub)
    counts = {}
    for ts, _ in frames:
        day = ts.strftime("%Y-%m-%d")
        counts[day] = counts.get(day, 0) + 1
    days = sorted(counts.items(), key=lambda x: x[0], reverse=True)
    return [{"day": d, "count": c} for d, c in days]


@app.get("/api/list")
def api_list(
    page: int = 1,
    per_page: int = 60,
    camera: str | None = None,
    cam: str | None = None,
    start: str | None = None,
):
    sub = resolve_camera(camera, cam)
    frames = list_frames(sub)
    if start:
        s = parse_ts(start)
        if s:
            frames = [f for f in frames if f[0] >= s]
    else:
        frames.reverse()
    total = len(frames)
    a = (page - 1) * per_page
    b = a + per_page
    chunk = frames[a:b]
    return {
        "total": total,
        "page": page,
        "per_page": per_page,
        "items": [{"name": name, "ts": ts.isoformat()} for ts, name in chunk],
    }


@app.get("/image/{name}")
def image(name: str, download: int = 0, camera: str | None = None, cam: str | None = None):
    if not TIMESTAMP_RE.match(name):
        raise HTTPException(400, "bad name")
    sub = resolve_camera(camera, cam)
    p = camera_image_dir(sub) / name
    if not p.exists():
        raise HTTPException(404, "not found")
    if download:
        return FileResponse(p, media_type="image/jpeg",
                            headers={"Content-Disposition": f'attachment; filename="{name}"'})
    data = _read_frame_cached(p)
    return Response(content=data, media_type="image/jpeg",
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.delete("/image/{name}")
def delete_image(name: str, camera: str | None = None, cam: str | None = None):
    if not TIMESTAMP_RE.match(name):
        raise HTTPException(400, "bad name")
    sub = resolve_camera(camera, cam)
    p = camera_image_dir(sub) / name
    if not p.exists():
        raise HTTPException(404, "not found")
    try:
        p.unlink()
    except OSError as e:
        raise HTTPException(500, f"unlink failed: {e}")
    with _frame_cache_lock:
        _frame_cache.pop(str(p), None)
    return {"deleted": name}


@app.get("/api/events")
def api_events(camera: str | None = None, cam: str | None = None, everywhere: int = 0):
    with _events_lock:
        events = _load_events()
    if everywhere:
        return events
    name = camera or cam or DEFAULT_CAMERA
    if name not in CAMERA_NAMES:
        raise HTTPException(404, f"unknown camera: {name}")
    return [e for e in events if e.get("camera") == name]


@app.post("/api/events")
async def api_create_event(req: Request):
    body = await req.json()
    cam_name = body.get("camera") or DEFAULT_CAMERA
    if cam_name not in CAMERA_NAMES:
        raise HTTPException(400, f"unknown camera: {cam_name}")
    try:
        x = float(body["x_pct"])
        y = float(body["y_pct"])
        message = str(body["message"]).strip()[:200]
        start_ts = str(body["start_ts"]).strip()
        end_ts = str(body["end_ts"]).strip()
    except (KeyError, TypeError, ValueError) as e:
        raise HTTPException(400, f"bad payload: {e}")
    if not message:
        raise HTTPException(400, "message required")
    if not (0.0 <= x <= 1.0) or not (0.0 <= y <= 1.0):
        raise HTTPException(400, "x_pct and y_pct must be 0..1")
    if start_ts > end_ts:
        raise HTTPException(400, "start_ts must be <= end_ts")
    ev = {
        "id": uuid.uuid4().hex[:12],
        "camera": cam_name,
        "x_pct": x,
        "y_pct": y,
        "message": message,
        "start_ts": start_ts,
        "end_ts": end_ts,
        "created_ts": datetime.now().isoformat(timespec="seconds"),
    }
    with _events_lock:
        events = _load_events()
        events.append(ev)
        _save_events(events)
    return ev


@app.delete("/api/events/{event_id}")
def api_delete_event(event_id: str):
    with _events_lock:
        events = _load_events()
        new_events = [e for e in events if e.get("id") != event_id]
        if len(new_events) == len(events):
            raise HTTPException(404, "event not found")
        _save_events(new_events)
    return {"deleted": event_id}


@app.patch("/api/events/{event_id}")
async def api_update_event(event_id: str, req: Request):
    body = await req.json()
    with _events_lock:
        events = _load_events()
        for e in events:
            if e.get("id") != event_id:
                continue
            if "message" in body:
                msg = str(body["message"]).strip()[:200]
                if not msg:
                    raise HTTPException(400, "message required")
                e["message"] = msg
            if "start_ts" in body:
                e["start_ts"] = str(body["start_ts"]).strip()
            if "end_ts" in body:
                e["end_ts"] = str(body["end_ts"]).strip()
            if "x_pct" in body:
                v = float(body["x_pct"])
                if 0 <= v <= 1: e["x_pct"] = v
            if "y_pct" in body:
                v = float(body["y_pct"])
                if 0 <= v <= 1: e["y_pct"] = v
            if e["start_ts"] > e["end_ts"]:
                raise HTTPException(400, "start_ts must be <= end_ts")
            _save_events(events)
            return e
    raise HTTPException(404, "event not found")


@app.delete("/api/events")
def api_delete_events(camera: str | None = None, cam: str | None = None):
    name = camera or cam
    with _events_lock:
        events = _load_events()
        if name:
            if name not in CAMERA_NAMES:
                raise HTTPException(404, f"unknown camera: {name}")
            kept = [e for e in events if e.get("camera") != name]
        else:
            kept = []
        deleted = len(events) - len(kept)
        _save_events(kept)
    return {"deleted": deleted}


@app.get("/status", response_class=HTMLResponse)
def status_page(request: Request):
    return TEMPLATES.TemplateResponse(request, "status.html")


@app.get("/api/status")
def api_status():
    now = datetime.now(LOCAL_TZ).replace(tzinfo=None)
    max_size_bytes = MAX_SIZE_GB * (1024 ** 3)
    max_age_seconds = MAX_AGE_DAYS * 86400
    cams = []
    total_size = 0
    for i, c in enumerate(CAMERAS):
        sub = None if i == 0 else c["name"]
        d = camera_image_dir(sub)
        frames = list_frames(sub)
        size = _dir_size(d)
        total_size += size
        per_day = {}
        for ts, _ in frames:
            k = ts.strftime("%Y-%m-%d")
            per_day[k] = per_day.get(k, 0) + 1
        oldest = frames[0][0] if frames else None
        newest = frames[-1][0] if frames else None
        age_s = (now - oldest).total_seconds() if oldest else 0
        since_last = (now - newest).total_seconds() if newest else None
        cams.append({
            "name": c["name"], "is_default": i == 0,
            "count": len(frames),
            "size_bytes": size,
            "size_pct_of_limit": round(size / max_size_bytes * 100.0, 1),
            "oldest_ts": oldest.isoformat() if oldest else None,
            "oldest_age_seconds": round(age_s),
            "age_pct_of_limit": round(age_s / max_age_seconds * 100.0, 1) if oldest else 0,
            "newest_ts": newest.isoformat() if newest else None,
            "since_last_seconds": round(since_last) if since_last is not None else None,
            "cadence_stale": (since_last is not None and since_last > 2 * CHECK_INTERVAL),
            "per_day": sorted(
                [{"day": k, "count": v} for k, v in per_day.items()],
                key=lambda x: x["day"], reverse=True,
            ),
        })
    du = shutil.disk_usage(str(IMAGE_DIR))
    la = os.getloadavg()
    with _events_lock:
        ev_count = len(_load_events())

    container_block, containers_error, container_engine = _container_stats()
    vm = psutil.virtual_memory()
    app_mem_bytes = int(sum(c.get("mem_mb", 0) for c in container_block) * 1024 * 1024)
    app_mem_pct = round(app_mem_bytes / vm.total * 100.0, 1) if vm.total else 0.0
    app_cpu_pct = round(sum(c.get("cpu_pct", 0) for c in container_block), 1)
    videos = list_videos()
    videos_block = None
    if VIDEO_DIR.exists():
        v_total = sum(v["size_bytes"] for v in videos)
        by_cam = {}
        for v in videos:
            by_cam.setdefault(v["camera"], []).append({"day": v["day"], "name": v["name"], "size_bytes": v["size_bytes"]})
        if containers_error:
            videogen_running = None  # unknown — runtime not reachable
        else:
            videogen_running = any(
                c.get("status") == "running" and "videogen" in c.get("name", "")
                for c in container_block
            )
        videos_block = {
            "total_size_bytes": v_total,
            "count": len(videos),
            "videogen_running": videogen_running,
            "containers_error": containers_error or None,
            "naming": "{camera}_{YYYY-MM-DD}.mp4",
            "by_camera": [
                {"camera": k, "items": sorted(items, key=lambda x: x["day"], reverse=True)}
                for k, items in sorted(by_cam.items())
            ],
        }

    return {
        "ts": now.isoformat(timespec="seconds"),
        "limits": {
            "max_age_days": MAX_AGE_DAYS,
            "max_size_gb": MAX_SIZE_GB,
            "check_interval_seconds": CHECK_INTERVAL,
        },
        "web": {"uptime_seconds": round(time.time() - APP_START_TS), "requests": _request_count},
        "system": {
            "loadavg": [round(x, 2) for x in la],
            "cpu_pct": psutil.cpu_percent(interval=None),
            "mem_pct": vm.percent,
            "mem_total_gb": round(vm.total / (1024 ** 3), 1),
            "disk_free_gb": round(du.free / (1024 ** 3), 1),
            "disk_total_gb": round(du.total / (1024 ** 3), 1),
            "disk_used_bytes": du.total - du.free,
            "disk_total_bytes": du.total,
        },
        "app": {"mem_pct": app_mem_pct, "mem_mb": round(app_mem_bytes / 1024 / 1024, 1), "cpu_pct": app_cpu_pct},
        "containers": container_block,
        "containers_error": containers_error or None,
        "container_engine": container_engine,
        "events_count": ev_count,
        "cameras": cams,
        "totals": {
            "size_bytes": total_size,
            "size_pct_of_limit": round(total_size / max_size_bytes * 100.0, 1),
        },
        "videos": videos_block,
    }


@app.get("/api/videos")
def api_videos():
    return list_videos()


@app.get("/api/videos/file/{camera}/{name}")
def api_video_file(camera: str, name: str, download: int = 0):
    if not VIDEO_RE.match(name):
        raise HTTPException(400, "bad name")
    p = VIDEO_DIR / camera / name
    if not p.exists() or not p.is_file():
        raise HTTPException(404, "not found")
    headers = {}
    if download:
        headers["Content-Disposition"] = f'attachment; filename="{name}"'
    return FileResponse(p, media_type="video/mp4", headers=headers)


@app.post("/api/videos/delete")
async def api_videos_delete(req: Request):
    body = await req.json()
    items = body.get("items") or []
    if not isinstance(items, list) or not items:
        raise HTTPException(400, "items list required")
    deleted = []
    errors = []
    for it in items:
        cam = it.get("camera")
        name = it.get("name")
        if not cam or not name or not VIDEO_RE.match(name):
            errors.append({"item": it, "error": "bad item"})
            continue
        p = VIDEO_DIR / cam / name
        try:
            p.unlink()
            deleted.append({"camera": cam, "name": name})
        except OSError as e:
            errors.append({"item": it, "error": str(e)})
    return {"deleted": deleted, "errors": errors}


@app.post("/api/images/delete-day")
async def api_images_delete_day(req: Request):
    body = await req.json()
    cam_name = body.get("camera")
    day = body.get("day")
    if not cam_name or cam_name not in CAMERA_NAMES:
        raise HTTPException(400, f"unknown camera: {cam_name}")
    if not day or not re.match(r"^\d{4}-\d{2}-\d{2}$", day):
        raise HTTPException(400, "day must be YYYY-MM-DD")
    sub = None if cam_name == DEFAULT_CAMERA else cam_name
    frames = list_frames(sub)
    target = [name for ts, name in frames if ts.strftime("%Y-%m-%d") == day]
    d = camera_image_dir(sub)
    deleted = 0
    errors = []
    for name in target:
        p = d / name
        try:
            p.unlink()
            with _frame_cache_lock:
                _frame_cache.pop(str(p), None)
            deleted += 1
        except OSError as e:
            errors.append({"name": name, "error": str(e)})
    return {"camera": cam_name, "day": day, "deleted": deleted, "errors": errors}


@app.get("/save")
def save(
    start: str | None = Query(None),
    end: str | None = Query(None),
    fps: int = Query(10, ge=1, le=60),
    camera: str | None = Query(None),
    cam: str | None = Query(None),
):
    sub = resolve_camera(camera, cam)
    base = camera_image_dir(sub)
    frames = list_frames(sub)
    if start:
        s = parse_ts(start)
        if s:
            frames = [f for f in frames if f[0] >= s]
    if end:
        e = parse_ts(end)
        if e:
            frames = [f for f in frames if f[0] <= e]
    if not frames:
        raise HTTPException(404, "no frames in range")

    first = cv2.imread(str(base / frames[0][1]))
    if first is None:
        raise HTTPException(500, "cannot read first frame")
    h, w, _ = first.shape

    tmp = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
    tmp.close()
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(tmp.name, fourcc, fps, (w, h))
    try:
        for ts, name in frames:
            img = cv2.imread(str(base / name))
            if img is None:
                continue
            if img.shape[0] != h or img.shape[1] != w:
                img = cv2.resize(img, (w, h))
            writer.write(img)
    finally:
        writer.release()

    cam_label = (sub or DEFAULT_CAMERA)
    start_label = frames[0][0].strftime("%Y%m%d_%H%M%S")
    end_label = frames[-1][0].strftime("%Y%m%d_%H%M%S")
    filename = f"timelapse_{cam_label}_{start_label}_to_{end_label}.mp4"

    def iter_file():
        with open(tmp.name, "rb") as f:
            while chunk := f.read(1024 * 1024):
                yield chunk
        os.unlink(tmp.name)

    return StreamingResponse(
        iter_file(),
        media_type="video/mp4",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
