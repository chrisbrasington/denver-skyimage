import json
import os
import re
import tempfile
import threading
import uuid
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import cv2
from astral import LocationInfo
from astral.sun import sun
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

IMAGE_DIR = Path(os.environ.get("IMAGE_DIR", "/data/images"))
EVENTS_DIR = Path(os.environ.get("EVENTS_DIR", "/data/events"))
EVENTS_FILE = EVENTS_DIR / "events.json"
CAMERAS_PATH = os.environ.get("CAMERAS_PATH", "/config/cameras.json")
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


CAMERAS = load_cameras()
CAMERA_NAMES = [c["name"] for c in CAMERAS]
DEFAULT_CAMERA = CAMERA_NAMES[0] if CAMERA_NAMES else "north"

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


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return TEMPLATES.TemplateResponse(request, "index.html")


@app.get("/camera/{name}", response_class=HTMLResponse)
def index_for_camera(name: str, request: Request):
    _check_camera_name(name)
    return TEMPLATES.TemplateResponse(request, "index.html", {"camera_name": name})


@app.get("/browse", response_class=HTMLResponse)
def browse(request: Request):
    return TEMPLATES.TemplateResponse(request, "browse.html")


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
def touch(request: Request):
    return TEMPLATES.TemplateResponse(request, "live.html", {"touch_mode": True})


@app.get("/touch/{name}", response_class=HTMLResponse)
def touch_for_camera(name: str, request: Request):
    _check_camera_name(name)
    return TEMPLATES.TemplateResponse(request, "live.html", {"touch_mode": True, "camera_name": name})


@app.get("/camera/{name}/last-hour", response_class=HTMLResponse)
def camera_last_hour(name: str, request: Request):
    _check_camera_name(name)
    return TEMPLATES.TemplateResponse(request, "last_hour.html", {"camera_name": name})


@app.get("/api/cameras")
def api_cameras():
    return {"default": DEFAULT_CAMERA, "cameras": CAMERA_NAMES}


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
