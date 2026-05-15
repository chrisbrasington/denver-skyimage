import hashlib
import os
import re
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests
import yaml
from PIL import Image

CONFIG_PATH = os.environ.get("CONFIG_PATH", "/config/config.yaml")
IMAGE_DIR = Path(os.environ.get("IMAGE_DIR", "/data/images"))
TIMESTAMP_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.jpg$")


def load_config():
    with open(CONFIG_PATH) as f:
        return yaml.safe_load(f)


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


def list_timestamped():
    files = []
    for p in IMAGE_DIR.iterdir():
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


def prune(max_age_days, max_size_gb):
    files = list_timestamped()
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
        print(f"[{datetime.now()}] pruned {removed_age} by age", flush=True)

    files = list_timestamped()
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
        print(f"[{datetime.now()}] pruned {removed_size} by size", flush=True)


def main():
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    cfg = load_config()
    url = cfg["image_url"]
    interval = int(cfg.get("check_interval_seconds", 30))
    max_age_days = float(cfg.get("max_age_days", 4))
    max_size_gb = float(cfg.get("max_size_gb", 10))

    temp = IMAGE_DIR / ".temp.jpg"
    last = IMAGE_DIR / ".last.jpg"
    print(f"start watcher url={url} interval={interval}s age={max_age_days}d size={max_size_gb}GB", flush=True)

    prune_counter = 0
    while True:
        if download(url, temp):
            if looks_corrupt(temp):
                print(f"[{datetime.now()}] corrupt/partial image, skip", flush=True)
                if temp.exists():
                    temp.unlink()
                time.sleep(interval)
                continue
            new_hash = sha256(temp)
            old_hash = sha256(last) if last.exists() else None
            if new_hash != old_hash:
                name = datetime.now().strftime("%Y-%m-%d_%H-%M-%S.jpg")
                dest = IMAGE_DIR / name
                os.replace(temp, dest)
                last.write_bytes(dest.read_bytes())
                print(f"[{datetime.now()}] saved {name}", flush=True)
            else:
                if temp.exists():
                    temp.unlink()

        prune_counter += 1
        if prune_counter >= 10:
            prune(max_age_days, max_size_gb)
            prune_counter = 0

        time.sleep(interval)


if __name__ == "__main__":
    main()
