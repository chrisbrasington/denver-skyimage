FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY videogen.py .

ENV IMAGE_DIR=/data/images
ENV VIDEO_DIR=/data/videos
ENV CAMERAS_PATH=/config/cameras.json

CMD ["python", "-u", "videogen.py"]
