FROM python:3-alpine

ENV PORT=8000 SCAN_DIR=/scans
WORKDIR /app
COPY . .

RUN adduser -D -u 10001 app && mkdir -p /scans && chown -R app /scans
USER app

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/')"

CMD ["python3", "server.py"]
