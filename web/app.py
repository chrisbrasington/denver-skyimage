import os
import re
import tempfile
from datetime import datetime
from pathlib import Path

import cv2
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.templating import Jinja2Templates

IMAGE_DIR = Path(os.environ.get("IMAGE_DIR", "/data/images"))
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
            ts = datetime.strptime(m.group(1), "%Y-%m-%d_%H-%M-%S")
        except ValueError:
            continue
        frames.append((ts, p.name))
    frames.sort(key=lambda x: x[0])
    return frames


def parse_ts(s):
    try:
        return datetime.strptime(s, "%Y-%m-%d_%H-%M-%S")
    except (ValueError, TypeError):
        return None


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return TEMPLATES.TemplateResponse("index.html", {"request": request})


@app.get("/browse", response_class=HTMLResponse)
def browse(request: Request):
    return TEMPLATES.TemplateResponse("browse.html", {"request": request})


@app.get("/api/frames")
def api_frames(since: str | None = None):
    frames = list_frames()
    if since:
        frames = [f for f in frames if f[0].strftime("%Y-%m-%d_%H-%M-%S") > since]
    return JSONResponse([
        {"name": name, "ts": ts.isoformat()} for ts, name in frames
    ])


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
def image(name: str):
    if not TIMESTAMP_RE.match(name):
        raise HTTPException(400, "bad name")
    p = IMAGE_DIR / name
    if not p.exists():
        raise HTTPException(404, "not found")
    return FileResponse(p, media_type="image/jpeg")


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
