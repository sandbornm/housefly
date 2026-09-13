#!/usr/bin/env python3
from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/health":
            self.send_json({"ok": True, "service": "housefly", "controller": "typescript-odds-worker"})
        elif path == "/api/connectome":
            manifest_path = RAW / "manifest.json"
            manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"files": {}}
            files = [
                {**details, "name": name, "present": (RAW / name).is_file()}
                for name, details in manifest["files"].items()
            ]
            self.send_json({"dataset": "MaleCNS v1.0", "neuralSimulation": False, "files": files})
        elif path == "/api/odds":
            self.send_json({"error": "Odds moved to the shared TypeScript worker; this endpoint is retired."}, 410)
        else:
            self.send_error(404)

    def send_json(self, payload: dict[str, object], status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8787), Handler)
    print("Housefly data service listening on http://127.0.0.1:8787")
    server.serve_forever()
