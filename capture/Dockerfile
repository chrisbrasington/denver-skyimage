FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY capture.py .

ENV CONFIG_PATH=/config/config.yaml
ENV IMAGE_DIR=/data/images

CMD ["python", "-u", "capture.py"]
