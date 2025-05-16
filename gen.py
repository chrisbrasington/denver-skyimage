import cv2
import os
from pathlib import Path

# Configuration
image_folder = 'downloaded_images'
output_video = 'output.mp4'
frame_rate = 1  # 1 frame per second

# Supported image extensions
image_extensions = {'.jpg', '.jpeg', '.png', '.bmp', '.webp'}

# Get list of image files sorted by name
image_files = sorted([
    f for f in Path(image_folder).iterdir()
    if f.suffix.lower() in image_extensions
])

if not image_files:
    print("No images found in the folder.")
    exit(1)

# Read the first image to get size
first_image = cv2.imread(str(image_files[0]))
height, width, _ = first_image.shape

# Define the video codec and create VideoWriter
fourcc = cv2.VideoWriter_fourcc(*'mp4v')  # for .mp4
video_writer = cv2.VideoWriter(output_video, fourcc, frame_rate, (width, height))

# Write each image to the video
for image_path in image_files:
    img = cv2.imread(str(image_path))
    if img.shape[0] != height or img.shape[1] != width:
        img = cv2.resize(img, (width, height))
    video_writer.write(img)
    print(f"Added {image_path.name}")

video_writer.release()
print(f"Video saved to {output_video}")
