import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

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
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = output_path.with_suffix(".mp4.tmp")
    if tmp.exists():
        tmp.unlink()

    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as listf:
        list_path = Path(listf.name)
        for _, p in frames:
            esc = str(p).replace("'", "'\\''")
            listf.write(f"file '{esc}'\n")

    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel", "warning",
        "-r", str(FPS),
        "-f", "concat",
        "-safe", "0",
        "-i", str(list_path),
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-f", "mp4",
        str(tmp),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True)
    finally:
        try: list_path.unlink()
        except OSError: pass

    if result.returncode != 0 or not tmp.exists():
        print(f"ERROR ffmpeg failed for {output_path.name} rc={result.returncode}", flush=True)
        if result.stderr:
            print(result.stderr.strip(), flush=True)
        if tmp.exists():
            tmp.unlink()
        return False

    tmp.replace(output_path)
    return True


def log_path(name):
    return VIDEO_DIR / name / "processed.log"


def load_processed(name):
    p = log_path(name)
    days = set()
    if not p.exists():
        return days
    try:
        for line in p.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            for tok in parts:
                if len(tok) == 10 and tok[4] == "-" and tok[7] == "-":
                    days.add(tok)
                    break
    except Exception as e:
        print(f"ERROR reading {p}: {e}", flush=True)
    return days


def mark_processed(name, day_iso, fname, frame_count):
    p = log_path(name)
    p.parent.mkdir(parents=True, exist_ok=True)
    line = f"{datetime.now(TZ).isoformat(timespec='seconds')} {day_iso} {fname} frames={frame_count}\n"
    with p.open("a") as f:
        f.write(line)


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
    processed = load_processed(name)
    for d in sorted(by_day.keys()):
        day_iso = d.isoformat()
        fname = f"{name}_{day_iso}.mp4"
        out = out_dir / fname
        if out.exists():
            if day_iso not in processed:
                mark_processed(name, day_iso, fname, len(by_day[d]))
            continue
        if day_iso in processed:
            print(f"[{now_local()}] [{name}] {fname} in processed.log, skip (file may have been pulled)", flush=True)
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
            mark_processed(name, day_iso, fname, len(by_day[d]))
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
