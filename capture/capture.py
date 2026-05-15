import hashlib
import json
import os
import re
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests
import yaml
from PIL import Image

CONFIG_PATH = os.environ.get("CONFIG_PATH", "/config/config.yaml")
CAMERAS_PATH = os.environ.get("CAMERAS_PATH", "/config/cameras.json")
IMAGE_DIR = Path(os.environ.get("IMAGE_DIR", "/data/images"))
TIMESTAMP_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.jpg$")


def load_config():
    with open(CONFIG_PATH) as f:
        return yaml.safe_load(f)


def load_cameras():
    with open(CAMERAS_PATH) as f:
        return json.load(f).get("cameras", [])


def camera_dir(cam, is_first):
    return IMAGE_DIR if is_first else IMAGE_DIR / cam["name"]


def download(url, path):
    try:
        r = requests.get(url, timeout=10)
        r.raise_for_status()
        path.write_bytes(r.content)
        return True
    except Exception as e:
        print(f"[{datetime.now()}] download failed: {e}", flush=True)
        return False


def looks_corrupt(path, white_threshold=240, ratio=0.9):
    try:
        with Image.open(path) as im:
            im.load()
            rgb = im.convert("RGB")
            w, h = rgb.size
            row = [rgb.getpixel((x, h - 1)) for x in range(w)]
    except Exception as e:
        print(f"[{datetime.now()}] image unreadable, skipping: {e}", flush=True)
        return True
    white = sum(1 for r, g, b in row if r >= white_threshold and g >= white_threshold and b >= white_threshold)
    return white / len(row) >= ratio


def sha256(path):
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


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


def prune(target_dir, max_age_days, max_size_gb, label):
    files = list_timestamped(target_dir)
    cutoff = datetime.now() - timedelta(days=max_age_days)
    removed_age = 0
    for ts, p in files:
        if ts < cutoff:
            try:
                p.unlink()
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
            p.unlink()
            total -= size
            removed_size += 1
        except OSError as e:
            print(f"unlink fail {p}: {e}", flush=True)
        i += 1
    if removed_size:
        print(f"[{datetime.now()}] [{label}] pruned {removed_size} by size", flush=True)


def process_camera(cam, is_first, max_age_days, max_size_gb, do_prune):
    target = camera_dir(cam, is_first)
    target.mkdir(parents=True, exist_ok=True)
    temp = target / ".temp.jpg"
    last = target / ".last.jpg"
    url = cam["url"]
    label = cam["name"]

    if download(url, temp):
        if looks_corrupt(temp):
            print(f"[{datetime.now()}] [{label}] corrupt/partial, skip", flush=True)
            if temp.exists():
                temp.unlink()
        else:
            new_hash = sha256(temp)
            old_hash = sha256(last) if last.exists() else None
            if new_hash != old_hash:
                name = datetime.now().strftime("%Y-%m-%d_%H-%M-%S.jpg")
                dest = target / name
                os.replace(temp, dest)
                last.write_bytes(dest.read_bytes())
                print(f"[{datetime.now()}] [{label}] saved {name}", flush=True)
            elif temp.exists():
                temp.unlink()

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

    prune_counter = 0
    while True:
        do_prune = prune_counter >= 10
        for i, cam in enumerate(cameras):
            process_camera(cam, i == 0, max_age_days, max_size_gb, do_prune)
        prune_counter = 0 if do_prune else prune_counter + 1
        time.sleep(interval)


if __name__ == "__main__":
    main()
