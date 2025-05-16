import os
import time
import requests
import hashlib
from datetime import datetime

IMAGE_URL = "https://econtent.dmns.org/images/skyimage.jpg"
DOWNLOAD_DIR = "downloaded_images"
TEMP_FILE = os.path.join(DOWNLOAD_DIR, "temp.jpg")
LAST_FILE = os.path.join(DOWNLOAD_DIR, "last.jpg")
CHECK_INTERVAL = 30  # seconds

os.makedirs(DOWNLOAD_DIR, exist_ok=True)

def download_image(url, path):
    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        with open(path, "wb") as f:
            f.write(response.content)
        return True
    except Exception as e:
        print(f"[{datetime.now()}] Failed to download image: {e}")
        return False

def hash_file(path):
    hasher = hashlib.sha256()
    with open(path, 'rb') as f:
        hasher.update(f.read())
    return hasher.hexdigest()

def images_differ(path1, path2):
    if not os.path.exists(path2):
        return True
    return hash_file(path1) != hash_file(path2)

def timestamped_filename():
    return os.path.join(DOWNLOAD_DIR, datetime.now().strftime("%Y-%m-%d_%H-%M-%S.jpg"))

def main():
    print("Starting image watcher...")
    while True:
        if download_image(IMAGE_URL, TEMP_FILE):
            if images_differ(TEMP_FILE, LAST_FILE):
                new_file = timestamped_filename()
                os.replace(TEMP_FILE, new_file)
                # Copy to last.jpg for future comparisons
                with open(new_file, 'rb') as src, open(LAST_FILE, 'wb') as dst:
                    dst.write(src.read())
                print(f"[{datetime.now()}] New image saved: {new_file}")
            else:
                print(f"[{datetime.now()}] Image unchanged. Skipping save.")
        time.sleep(CHECK_INTERVAL)

if __name__ == "__main__":
    main()
