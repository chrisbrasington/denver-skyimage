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
DENVER = LocationInfo("Denver", "USA", "America/Denver", 39.7392, -104.9903)
UTC_TZ = ZoneInfo("UTC")
LOCAL_TZ = ZoneInfo("America/Denver")
TEMPLATES = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))
TIMESTAMP_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.jpg$")

app = FastAPI()


def list_frames():
    frames = []
    if not IMAGE_DIR.exists():
        return frames
    for p in IMAGE_DIR.iterdir():
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


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return TEMPLATES.TemplateResponse(request, "index.html")


@app.get("/browse", response_class=HTMLResponse)
def browse(request: Request):
    return TEMPLATES.TemplateResponse(request, "browse.html")


@app.get("/live", response_class=HTMLResponse)
@app.get("/touch", response_class=HTMLResponse)
def live(request: Request):
    return TEMPLATES.TemplateResponse(request, "live.html")


@app.get("/api/frames")
def api_frames(since: str | None = None):
    frames = list_frames()
    if since:
        frames = [f for f in frames if f[0].strftime("%Y-%m-%d_%H-%M-%S") > since]
    return JSONResponse([
        {"name": name, "ts": ts.isoformat()} for ts, name in frames
    ])


@app.get("/api/anchors")
def api_anchors():
    frames = list_frames()
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
def api_days():
    frames = list_frames()
    counts = {}
    for ts, _ in frames:
        day = ts.strftime("%Y-%m-%d")
        counts[day] = counts.get(day, 0) + 1
    days = sorted(counts.items(), key=lambda x: x[0], reverse=True)
    return [{"day": d, "count": c} for d, c in days]


@app.get("/api/list")
def api_list(page: int = 1, per_page: int = 60):
    frames = list_frames()
    frames.reverse()
    total = len(frames)
    start = (page - 1) * per_page
    end = start + per_page
    chunk = frames[start:end]
    return {
        "total": total,
        "page": page,
        "per_page": per_page,
        "items": [{"name": name, "ts": ts.isoformat()} for ts, name in chunk],
    }


@app.get("/image/{name}")
def image(name: str, download: int = 0):
    if not TIMESTAMP_RE.match(name):
        raise HTTPException(400, "bad name")
    p = IMAGE_DIR / name
    if not p.exists():
        raise HTTPException(404, "not found")
    headers = {"Content-Disposition": f'attachment; filename="{name}"'} if download else None
    return FileResponse(p, media_type="image/jpeg", headers=headers)


@app.delete("/image/{name}")
def delete_image(name: str):
    if not TIMESTAMP_RE.match(name):
        raise HTTPException(400, "bad name")
    p = IMAGE_DIR / name
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
):
    frames = list_frames()
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

    first = cv2.imread(str(IMAGE_DIR / frames[0][1]))
    if first is None:
        raise HTTPException(500, "cannot read first frame")
    h, w, _ = first.shape

    tmp = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
    tmp.close()
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(tmp.name, fourcc, fps, (w, h))
    try:
        for ts, name in frames:
            img = cv2.imread(str(IMAGE_DIR / name))
            if img is None:
                continue
            if img.shape[0] != h or img.shape[1] != w:
                img = cv2.resize(img, (w, h))
            writer.write(img)
    finally:
        writer.release()

    start_label = frames[0][0].strftime("%Y%m%d_%H%M%S")
    end_label = frames[-1][0].strftime("%Y%m%d_%H%M%S")
    filename = f"timelapse_{start_label}_to_{end_label}.mp4"

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
