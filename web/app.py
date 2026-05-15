import json
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import cv2
from astral import LocationInfo
from astral.sun import sun
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.templating import Jinja2Templates

IMAGE_DIR = Path(os.environ.get("IMAGE_DIR", "/data/images"))
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

app = FastAPI()


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
    headers = {"Content-Disposition": f'attachment; filename="{name}"'} if download else None
    return FileResponse(p, media_type="image/jpeg", headers=headers)


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
    return {"deleted": name}


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
