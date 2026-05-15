import json
import os
import re
import shutil
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import cv2

CAMERAS_PATH = os.environ.get("CAMERAS_PATH", "/config/cameras.json")
IMAGE_DIR = Path(os.environ.get("IMAGE_DIR", "/data/images"))
VIDEO_DIR = Path(os.environ.get("VIDEO_DIR", "/data/videos"))
FPS = int(os.environ.get("VIDEO_FPS", "10"))
TIMESTAMP_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.jpg$")
TZ = ZoneInfo("America/Denver")
UTC = ZoneInfo("UTC")
MIN_FREE_BYTES = 2 * 1024 ** 3


def now_local():
    return datetime.now(TZ)


def load_cameras():
    try:
        with open(CAMERAS_PATH) as f:
            return json.load(f).get("cameras", [])
    except Exception as e:
        print(f"ERROR cameras.json: {e}", flush=True)
        return []


def camera_image_dir(cam, is_first):
    return IMAGE_DIR if is_first else IMAGE_DIR / cam["name"]


def list_frames(d):
    frames = []
    if not d.exists():
        return frames
    for p in d.iterdir():
        if not p.is_file():
            continue
        m = TIMESTAMP_RE.match(p.name)
        if not m:
            continue
        try:
            ts_utc = datetime.strptime(m.group(1), "%Y-%m-%d_%H-%M-%S").replace(tzinfo=UTC)
        except ValueError:
            continue
        ts_local = ts_utc.astimezone(TZ).replace(tzinfo=None)
        frames.append((ts_local, p))
    frames.sort(key=lambda x: x[0])
    return frames


def free_bytes():
    try:
        return shutil.disk_usage(VIDEO_DIR).free
    except Exception as e:
        print(f"ERROR disk usage: {e}", flush=True)
        return 0


def encode_day(frames, output_path):
    if not frames:
        return False
    first = cv2.imread(str(frames[0][1]))
    if first is None:
        return False
    h, w, _ = first.shape
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = output_path.with_suffix(".mp4.tmp")
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(tmp), fourcc, FPS, (w, h))
    written = 0
    try:
        for ts, p in frames:
            img = cv2.imread(str(p))
            if img is None:
                continue
            if img.shape[0] != h or img.shape[1] != w:
                img = cv2.resize(img, (w, h))
            writer.write(img)
            written += 1
    finally:
        writer.release()
    if written == 0:
        if tmp.exists():
            tmp.unlink()
        return False
    tmp.replace(output_path)
    return True


def process_camera(cam, is_first):
    name = cam["name"]
    src = camera_image_dir(cam, is_first)
    frames = list_frames(src)
    if not frames:
        print(f"[{now_local()}] [{name}] no frames", flush=True)
        return
    today = now_local().date()
    by_day = {}
    for ts, p in frames:
        d = ts.date()
        if d == today:
            continue
        by_day.setdefault(d, []).append((ts, p))
    out_dir = VIDEO_DIR / name
    out_dir.mkdir(parents=True, exist_ok=True)
    for d in sorted(by_day.keys()):
        fname = f"{name}_{d.isoformat()}.mp4"
        out = out_dir / fname
        if out.exists():
            continue
        free = free_bytes()
        if free < MIN_FREE_BYTES:
            print(
                f"ERROR [{name}] free space {free} bytes < {MIN_FREE_BYTES}; skipping {fname} and remaining",
                flush=True,
            )
            return
        print(
            f"[{now_local()}] [{name}] encoding {fname} ({len(by_day[d])} frames)",
            flush=True,
        )
        if encode_day(by_day[d], out):
            print(f"[{now_local()}] [{name}] saved {fname}", flush=True)
        else:
            print(f"[{now_local()}] [{name}] encode failed {fname}", flush=True)


def run_once():
    cams = load_cameras()
    if not cams:
        print("no cameras configured", flush=True)
        return
    for i, cam in enumerate(cams):
        process_camera(cam, i == 0)


def seconds_to_next_run():
    now = now_local()
    target = now.replace(hour=1, minute=0, second=0, microsecond=0)
    if now >= target:
        target += timedelta(days=1)
    return (target - now).total_seconds()


def main():
    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    print(
        f"videogen start IMAGE_DIR={IMAGE_DIR} VIDEO_DIR={VIDEO_DIR} fps={FPS} min_free_gb={MIN_FREE_BYTES / 1024 ** 3:.1f}",
        flush=True,
    )
    print("running once on startup", flush=True)
    run_once()
    while True:
        wait = seconds_to_next_run()
        print(f"sleeping {wait:.0f}s until next 01:00 MTN", flush=True)
        time.sleep(wait)
        run_once()


if __name__ == "__main__":
    main()
