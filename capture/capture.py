import hashlib
import json
import os
import re
import shutil
import time
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path

import requests
import yaml
from PIL import Image

CONFIG_PATH = os.environ.get("CONFIG_PATH", "/config/config.yaml")
CAMERAS_PATH = os.environ.get("CAMERAS_PATH", "/config/cameras.json")
IMAGE_DIR = Path(os.environ.get("IMAGE_DIR", "/data/images"))
TIMESTAMP_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.jpg$")
THUMB_DIRNAME = ".thumbs"  # written by web/app.py ensure_thumb()
LEGACY_THUMB_DIRNAME = "thumbs"


def load_config():
    with open(CONFIG_PATH) as f:
        return yaml.safe_load(f)


def load_cameras():
    with open(CAMERAS_PATH) as f:
        return json.load(f).get("cameras", [])


def camera_dir(cam, is_first):
    return IMAGE_DIR if is_first else IMAGE_DIR / cam["name"]


SESSION = requests.Session()


def download(url):
    try:
        r = SESSION.get(url, timeout=10)
        r.raise_for_status()
        return r.content
    except Exception as e:
        print(f"[{datetime.now()}] download failed: {e}", flush=True)
        return None


def looks_corrupt(data, white_threshold=240, ratio=0.9):
    try:
        with Image.open(BytesIO(data)) as im:
            im.load()
            w, h = im.size
            row = list(im.crop((0, h - 1, w, h)).convert("RGB").getdata())
    except Exception as e:
        print(f"[{datetime.now()}] image unreadable, skipping: {e}", flush=True)
        return True
    white = sum(1 for r, g, b in row if r >= white_threshold and g >= white_threshold and b >= white_threshold)
    return white / len(row) >= ratio


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def list_timestamped(target_dir):
    files = []
    if not target_dir.exists():
        return files
    for p in target_dir.iterdir():
        if not p.is_file():
            continue
        m = TIMESTAMP_RE.match(p.name)
        if not m:
            continue
        try:
            ts = datetime.strptime(m.group(1), "%Y-%m-%d_%H-%M-%S")
        except ValueError:
            continue
        files.append((ts, p))
    files.sort(key=lambda x: x[0])
    return files


def thumb_path_for(p):
    """Must match web/app.py thumb_path_for()."""
    return p.parent / THUMB_DIRNAME / p.name


def remove_image(p):
    """Delete an image and its cached thumbnail (if any)."""
    p.unlink()
    thumb_path_for(p).unlink(missing_ok=True)


def cleanup_orphans(target_dir, label):
    """Remove thumbnails whose source image is gone, plus temp files left by interrupted writes."""
    removed = 0
    thumbs = target_dir / THUMB_DIRNAME
    if thumbs.is_dir():
        for t in thumbs.iterdir():
            if not t.is_file():
                continue
            # Stray "<name>.jpg.tmp.<pid>.<uuid>" from an interrupted thumb write, or a thumb with no image.
            if ".tmp." in t.name or not (target_dir / t.name).exists():
                try:
                    t.unlink()
                    removed += 1
                except OSError as e:
                    print(f"unlink fail {t}: {e}", flush=True)
    temp = target_dir / ".temp.jpg"
    if temp.exists():
        temp.unlink(missing_ok=True)
        removed += 1
    if removed:
        print(f"[{datetime.now()}] [{label}] removed {removed} orphaned thumbs/temp files", flush=True)


def cleanup_legacy(camera_names):
    """Remove the old non-hidden thumbs/ folder that earlier versions wrote; nothing uses it now."""
    legacy = IMAGE_DIR / LEGACY_THUMB_DIRNAME
    if LEGACY_THUMB_DIRNAME in camera_names or not legacy.is_dir():
        return
    try:
        shutil.rmtree(legacy)
        print(f"[{datetime.now()}] removed legacy {legacy}", flush=True)
    except OSError as e:
        print(f"legacy cleanup fail {legacy}: {e}", flush=True)


def prune(target_dir, max_age_days, max_size_gb, label):
    files = list_timestamped(target_dir)
    cutoff = datetime.now() - timedelta(days=max_age_days)
    removed_age = 0
    for ts, p in files:
        if ts < cutoff:
            try:
                remove_image(p)
                removed_age += 1
            except OSError as e:
                print(f"unlink fail {p}: {e}", flush=True)
    if removed_age:
        print(f"[{datetime.now()}] [{label}] pruned {removed_age} by age", flush=True)

    files = list_timestamped(target_dir)
    max_bytes = int(max_size_gb * (1024 ** 3))
    total = sum(p.stat().st_size for _, p in files)
    removed_size = 0
    i = 0
    while total > max_bytes and i < len(files):
        ts, p = files[i]
        size = p.stat().st_size
        try:
            remove_image(p)
            total -= size
            removed_size += 1
        except OSError as e:
            print(f"unlink fail {p}: {e}", flush=True)
        i += 1
    if removed_size:
        print(f"[{datetime.now()}] [{label}] pruned {removed_size} by size", flush=True)


def initial_hash(target_dir):
    """Seed the in-memory hash from the newest saved frame so a restart doesn't re-save a duplicate."""
    stale = target_dir / ".last.jpg"  # no longer used; hash is kept in memory
    if stale.exists():
        stale.unlink()
    files = list_timestamped(target_dir)
    return sha256(files[-1][1].read_bytes()) if files else None


def process_camera(cam, is_first, max_age_days, max_size_gb, do_prune, last_hashes):
    target = camera_dir(cam, is_first)
    target.mkdir(parents=True, exist_ok=True)
    label = cam["name"]
    if label not in last_hashes:
        last_hashes[label] = initial_hash(target)

    data = download(cam["url"])
    if data is not None:
        if looks_corrupt(data):
            print(f"[{datetime.now()}] [{label}] corrupt/partial, skip", flush=True)
        else:
            new_hash = sha256(data)
            if new_hash != last_hashes[label]:
                name = datetime.now().strftime("%Y-%m-%d_%H-%M-%S.jpg")
                temp = target / ".temp.jpg"
                temp.write_bytes(data)
                os.replace(temp, target / name)  # atomic so web never sees a partial file
                last_hashes[label] = new_hash
                print(f"[{datetime.now()}] [{label}] saved {name}", flush=True)

    if do_prune:
        prune(target, max_age_days, max_size_gb, label)


def main():
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    cfg = load_config()
    interval = int(cfg.get("check_interval_seconds", 30))
    max_age_days = float(cfg.get("max_age_days", 4))
    max_size_gb = float(cfg.get("max_size_gb", 10))

    cameras = load_cameras()
    if not cameras:
        print("no cameras configured", flush=True)
        return
    print(f"start watcher cameras={[c['name'] for c in cameras]} interval={interval}s age={max_age_days}d size={max_size_gb}GB", flush=True)

    # Startup sweep: apply retention first, then drop thumbs/temp files left without a source image.
    cleanup_legacy({c["name"] for c in cameras})
    for i, cam in enumerate(cameras):
        target = camera_dir(cam, i == 0)
        if target.is_dir():
            prune(target, max_age_days, max_size_gb, cam["name"])
            cleanup_orphans(target, cam["name"])

    prune_counter = 0
    last_hashes = {}
    while True:
        do_prune = prune_counter >= 10
        for i, cam in enumerate(cameras):
            process_camera(cam, i == 0, max_age_days, max_size_gb, do_prune, last_hashes)
        prune_counter = 0 if do_prune else prune_counter + 1
        time.sleep(interval)


if __name__ == "__main__":
    main()
