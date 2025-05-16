import cv2
import re
from pathlib import Path
from datetime import datetime

# Configuration
image_folder = 'downloaded_images'
frame_duration = 0.1  # seconds per image
frame_rate = int(1 / frame_duration)  # e.g. 10 FPS for 0.1s per image
image_extensions = {'.jpg', '.jpeg', '.png', '.bmp', '.webp'}

# Regex pattern for timestamped filenames like 2025-05-16_13-48-39.jpg
timestamp_pattern = re.compile(r'^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})')

# Parse timestamp from filename
def extract_timestamp(filename: str) -> datetime | None:
    match = timestamp_pattern.match(Path(filename).stem)
    if not match:
        return None
    return datetime.strptime(match.group(1), "%Y-%m-%d_%H-%M-%S")

# Filter and sort valid images
image_files = [
    f for f in Path(image_folder).iterdir()
    if f.suffix.lower() in image_extensions and extract_timestamp(f.name)
]
image_files.sort(key=lambda f: extract_timestamp(f.name))

if not image_files:
    print("No timestamped images found.")
    exit(1)

# Determine video filename from timestamps
start_time = extract_timestamp(image_files[0].name)
end_time = extract_timestamp(image_files[-1].name)
output_video = f"timelapse_{start_time.strftime('%Y%m%d_%H%M%S')}_to_{end_time.strftime('%Y%m%d_%H%M%S')}.mp4"

# Get frame size from first image
first_image = cv2.imread(str(image_files[0]))
if first_image is None:
    print("Failed to read first image.")
    exit(1)

height, width, _ = first_image.shape

# Create video writer
fourcc = cv2.VideoWriter_fourcc(*'mp4v')
video_writer = cv2.VideoWriter(output_video, fourcc, frame_rate, (width, height))

# Write each image as 1 frame
for image_path in image_files:
    img = cv2.imread(str(image_path))
    if img is None:
        print(f"Warning: Could not read {image_path.name}, skipping.")
        continue
    if img.shape[0] != height or img.shape[1] != width:
        img = cv2.resize(img, (width, height))
    video_writer.write(img)
    print(f"Added {image_path.name}")

video_writer.release()
print(f"Video saved as {output_video}")
