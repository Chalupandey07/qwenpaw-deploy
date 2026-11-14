#!/usr/bin/env python3
"""Camoufox HTTP bridge (Option B) — QwenPaw agent browses via Camoufox.

Stdlib-only (no FastAPI): a persistent Camoufox/Firefox browser lives in
this process; the QwenPaw agent drives it over HTTP with a Bearer token.

DESIGN NOTE — Playwright's sync API is single-threaded (greenlets bound
to the creating thread). ALL browser calls therefore run on ONE dedicated
worker thread via a job queue; HTTP handler threads only enqueue work and
wait for the result. Calling page.* from any other thread fails with
"Cannot switch to a different thread".

Binds: 127.0.0.1:8899 (host-local) and the Docker gateway IP (so the
`qwenpaw` container reaches it at http://172.18.0.1:8899). Never publish
this port publicly — the token is the only auth.

Token: read from /data/home/camoufox/.env (BRIDGE_TOKEN=...), chmod 600.
Also accepted from env var BRIDGE_TOKEN (systemd unit reads the .env via
EnvironmentFile).

Endpoints (all POST JSON except where noted; Bearer token required
except GET /health):
  POST /goto       {url, timeout_ms?, wait_until?} -> {ok,title,url,status}
  POST /snapshot   {max_chars?}                    -> {ok,title,url,text}
  POST /screenshot {name?, include_b64?}           -> {ok,host_path,workspace_path,app_path}
  POST /click      {by: css|text|role|label|placeholder, value, name?}
  POST /fill       {by?, selector?, value}
  POST /eval       {expression}                    -> {ok,result}
  POST /state                                     -> {ok,title,url}
  POST /restart                                   -> relaunch browser
  GET  /health                                    -> {ok,browser_alive,title,url}
  GET  /latest.png?token=...                      -> latest screenshot PNG
  GET  /watch?token=...                           -> auto-refreshing watch page

Screenshots are saved to /data/home/camoufox/shots/ AND copied into the
default QwenPaw workspace media dir so the agent/user can see them in the
console: /app/working/workspaces/default/media/camoufox-<ts>.png
"""
import base64
import json
import os
import queue
import re
import secrets
import shutil
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE = "/data/home/camoufox"
SHOTS_DIR = os.path.join(BASE, "shots")
PROFILE_DIR = os.path.join(BASE, "profile")
WORKSPACE_MEDIA = "/data/home/qwenpaw/working/workspaces/default/media"
PORT = int(os.environ.get("BRIDGE_PORT", "8899"))
os.environ.setdefault("XDG_CACHE_HOME", os.path.join(BASE, "cache"))
os.environ.setdefault("CAMOUFOX_VIRTUAL_DISPLAY_SIZE", "1920x1080x24")

TOKEN = os.environ.get("BRIDGE_TOKEN", "")
if not TOKEN:
    env_path = os.path.join(BASE, ".env")
    if os.path.exists(env_path):
        for line in open(env_path):
            line = line.strip()
            if line.startswith("BRIDGE_TOKEN="):
                TOKEN = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
if not TOKEN:
    sys.stderr.write("FATAL: no BRIDGE_TOKEN in env or %s/.env\n" % BASE)
    sys.exit(2)

LATEST_SHOT = {"path": None, "ts": 0}


def log(*a):
    print("[bridge %s]" % time.strftime("%H:%M:%S"), *a, flush=True)


def launch_options():
    kw = {
        "headless": "virtual",
        "os": os.environ.get("CAMOUFOX_OS", "linux"),
        "locale": os.environ.get("CAMOUFOX_LOCALE", "en-IN"),
        "humanize": os.environ.get("CAMOUFOX_HUMANIZE", "false").lower() == "true",
        "persistent_context": True,
        "user_data_dir": PROFILE_DIR,
    }
    vd = os.environ.get("CAMOUFOX_VIRTUAL_DISPLAY", "")
    if vd:
        # Use an existing X display (e.g. TigerVNC :99) instead of Xvfb.
        kw["headless"] = False
        kw["virtual_display"] = vd
    return kw


class BrowserWorker(threading.Thread):
    """Owns the Camoufox browser. Every page call runs on this thread."""

    def __init__(self):
        super().__init__(daemon=True, name="camoufox-worker")
        self.jobs = queue.Queue()
        self.browser = None   # Camoufox instance
        self.page = None

    def call(self, fn, timeout=180):
        """Run fn() on the worker thread, return its value or raise."""
        out = queue.Queue(maxsize=1)
        self.jobs.put((fn, out))
        ok, val = out.get(timeout=timeout)
        if ok:
            return val
        raise val

    def run(self):
        while True:
            fn, out = self.jobs.get()
            try:
                out.put((True, fn()))
            except BaseException as e:  # noqa: BLE001 - re-raised to caller
                out.put((False, e))

    # -- the following methods run ONLY on the worker thread --
    def start_browser(self):
        from camoufox.sync_api import Camoufox
        log("launching Camoufox", launch_options())
        self.browser = Camoufox(**launch_options())
        ctx = self.browser.__enter__()
        try:
            pages = ctx.pages
            self.page = pages[0] if pages else ctx.new_page()
        except Exception:
            self.page = ctx.new_page()
        self.page.set_default_timeout(60000)
        log("browser up, page:", self.page.url if self.page else None)
        return True

    def stop_browser(self):
        self.page = None
        if self.browser is not None:
            try:
                self.browser.__exit__(None, None, None)
            except Exception as e:
                log("browser close error:", e)
            self.browser = None

    def ensure_browser(self):
        if self.page is None:
            self.start_browser()
        return self.page

    def health(self):
        if self.page is None:
            return {"ok": True, "browser_alive": False}
        return {"ok": True, "browser_alive": True,
                "title": self.page.title(), "url": self.page.url}

    def goto(self, body):
        page = self.ensure_browser()
        url = body.get("url")
        if not url:
            raise ValueError("url required")
        resp = page.goto(url, timeout=int(body.get("timeout_ms", 60000)),
                         wait_until=body.get("wait_until", "load"))
        time.sleep(float(body.get("settle_s", 2)))
        return {"ok": True, "title": page.title(), "url": page.url,
                "status": resp.status if resp else None}

    def snapshot(self, body):
        page = self.ensure_browser()
        try:
            text = page.inner_text("body")
        except Exception:
            text = ""
        if not text.strip():
            try:
                text = page.content()[:20000]
            except Exception:
                pass
        mx = int(body.get("max_chars", 20000))
        return {"ok": True, "title": page.title(), "url": page.url,
                "text": text[:mx], "chars": len(text)}

    def screenshot(self, body):
        page = self.ensure_browser()
        os.makedirs(SHOTS_DIR, exist_ok=True)
        ts = time.strftime("%Y%m%d-%H%M%S")
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", body.get("name") or "shot")[:60]
        host_path = os.path.join(SHOTS_DIR, "%s-%s.png" % (ts, safe))
        page.screenshot(path=host_path)
        LATEST_SHOT["path"] = host_path
        LATEST_SHOT["ts"] = time.time()
        ws_path, app_path = None, None
        try:
            os.makedirs(WORKSPACE_MEDIA, exist_ok=True)
            ws_path = os.path.join(WORKSPACE_MEDIA, os.path.basename(host_path))
            shutil.copyfile(host_path, ws_path)
            app_path = "/app/working/workspaces/default/media/" + os.path.basename(host_path)
        except Exception as e:
            log("workspace copy failed:", e)
        out = {"ok": True, "title": page.title(), "url": page.url,
               "host_path": host_path, "workspace_path": ws_path,
               "app_path": app_path}
        if body.get("include_b64"):
            with open(host_path, "rb") as f:
                out["b64"] = base64.b64encode(f.read()).decode()
        return out

    def click(self, body):
        page = self.ensure_browser()
        loc = self._locator(page, body.get("by", "css"), body.get("value"),
                            body.get("name"))
        loc.first.click(timeout=int(body.get("timeout_ms", 15000)))
        time.sleep(float(body.get("settle_s", 1)))
        return {"ok": True, "title": page.title(), "url": page.url}

    def fill(self, body):
        page = self.ensure_browser()
        value = body.get("value", "")
        if body.get("selector") or body.get("by") in (None, "css"):
            loc = page.locator(body.get("selector") or body.get("value"))
        else:
            loc = self._locator(page, body.get("by"), body.get("value"))
        loc.first.fill(value, timeout=int(body.get("timeout_ms", 15000)))
        return {"ok": True, "title": page.title(), "url": page.url}

    def eval(self, body):
        page = self.ensure_browser()
        expr = body.get("expression", "")
        if not expr:
            raise ValueError("expression required")
        return {"ok": True, "result": page.evaluate(expr)}

    def state(self, body):
        page = self.ensure_browser()
        return {"ok": True, "title": page.title(), "url": page.url}

    def restart(self, body):
        self.stop_browser()
        self.start_browser()
        return {"ok": True, "title": self.page.title(), "url": self.page.url}

    @staticmethod
    def _locator(page, by, value, name=None):
        by = (by or "css").lower()
        if by == "css":
            return page.locator(value)
        if by == "text":
            return page.get_by_text(value)
        if by == "role":
            return page.get_by_role(value, name=name) if name else page.get_by_role(value)
        if by == "label":
            return page.get_by_label(value)
        if by == "placeholder":
            return page.get_by_placeholder(value)
        raise ValueError("unknown locator by=%r" % by)


WORKER = BrowserWorker()


def handle(method, path, body):
    """Returns (status, payload_dict_or_bytes, content_type). No browser
    calls here directly — everything goes through WORKER.call()."""
    if method == "GET" and path == "/health":
        try:
            return 200, WORKER.call(WORKER.health, timeout=30), "json"
        except Exception as e:
            return 200, {"ok": True, "browser_alive": False,
                         "error": "%s: %s" % (type(e).__name__, str(e)[:200])}, "json"

    if method == "GET" and path == "/latest.png":
        p = LATEST_SHOT["path"]
        if not p or not os.path.exists(p):
            return 404, {"ok": False, "error": "no screenshot yet"}, "json"
        with open(p, "rb") as f:
            return 200, f.read(), "image/png"

    if method == "GET" and path == "/watch":
        html = """<!doctype html><meta charset=utf-8><title>Camoufox live view</title>
<style>body{background:#111;color:#ddd;font-family:sans-serif;margin:0;padding:12px}
img{max-width:100%;border:1px solid #444} small{color:#888}</style>
<h2>Camoufox browser — latest screenshot</h2>
<p><small>Auto-refreshes every 5s. This is a screenshot feed, not a live
desktop stream (no public VNC port on InstaBox Free). Take a fresh one
with POST /screenshot.</small></p>
<img id=shot src="/latest.png?token=TOKENQ"><script>
setInterval(()=>{document.getElementById('shot').src='/latest.png?token=TOKENQ&t='+Date.now()},5000);
</script>"""
        return 200, html.encode(), "text/html"

    if method != "POST":
        return 404, {"ok": False, "error": "unknown endpoint %s %s" % (method, path)}, "json"
    routes = {
        "/goto": WORKER.goto, "/snapshot": WORKER.snapshot,
        "/screenshot": WORKER.screenshot, "/click": WORKER.click,
        "/fill": WORKER.fill, "/eval": WORKER.eval,
        "/state": WORKER.state, "/restart": WORKER.restart,
    }
    fn = routes.get(path)
    if fn is None:
        return 404, {"ok": False, "error": "unknown endpoint %s %s" % (method, path)}, "json"
    try:
        return 200, WORKER.call(lambda: fn(body)), "json"
    except ValueError as e:
        return 400, {"ok": False, "error": str(e)}, "json"
    except Exception as e:
        log("handler error:", type(e).__name__, str(e)[:300])
        return 500, {"ok": False,
                     "error": "%s: %s" % (type(e).__name__, str(e)[:500])}, "json"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _auth(self, qs):
        # Bearer header, or ?token= for <img>/browser GETs.
        auth = self.headers.get("Authorization", "")
        if auth == "Bearer " + TOKEN:
            return True
        tok = qs.get("token", [None])[0]
        return tok is not None and secrets.compare_digest(tok, TOKEN)

    def _send(self, status, payload, ctype):
        if ctype == "json":
            data = json.dumps(payload).encode()
            ctype = "application/json"
        elif isinstance(payload, str):
            data = payload.encode()
        else:
            data = payload
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _route(self, method):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        path = u.path.rstrip("/") or "/"
        if path == "/health" and method == "GET":
            status, payload, ctype = handle(method, path, {})
            return self._send(status, payload, ctype)
        if not self._auth(qs):
            return self._send(401, {"ok": False, "error": "unauthorized"}, "json")
        body = {}
        if method == "POST":
            try:
                ln = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                ln = 0
            raw = self.rfile.read(ln) if ln else b""
            if raw:
                try:
                    body = json.loads(raw)
                except Exception:
                    return self._send(400, {"ok": False, "error": "bad json"}, "json")
        try:
            status, payload, ctype = handle(method, path, body)
        except Exception as e:
            log("handler error:", type(e).__name__, str(e)[:300])
            status, payload, ctype = 500, {"ok": False,
                                           "error": "%s: %s" % (type(e).__name__, str(e)[:500])}, "json"
        if ctype == "text/html" and isinstance(payload, bytes):
            payload = payload.replace(b"TOKENQ", qs.get("token", [""])[0].encode())
        self._send(status, payload, ctype)

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")


def gateway_ip():
    # Docker bridge gateway (container -> host). Find the host address on
    # the 172.18.0.0/16 network (the qwenpaw container network); fall back
    # to any 172.x bridge address.
    try:
        import subprocess
        out = subprocess.check_output(["ip", "-4", "addr", "show"],
                                      text=True, timeout=5)
        addrs = re.findall(r"inet (\d+\.\d+\.\d+\.\d+)/\d+", out)
        for a in addrs:
            if a.startswith("172.18."):
                return a
        for a in addrs:
            if a.startswith("172.") and a != "127.0.0.1":
                return a
    except Exception as e:
        log("gateway detect failed:", e)
    return None


def main():
    os.makedirs(SHOTS_DIR, exist_ok=True)
    os.makedirs(PROFILE_DIR, exist_ok=True)
    WORKER.start()
    WORKER.call(WORKER.start_browser, timeout=120)
    hosts = ["127.0.0.1"]
    gw = gateway_ip()
    if gw and gw != "127.0.0.1":
        hosts.append(gw)
    servers = []
    for h in hosts:
        srv = ThreadingHTTPServer((h, PORT), Handler)
        srv.daemon_threads = True
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        servers.append(srv)
        log("listening on http://%s:%d" % (h, PORT))
    log("bridge ready; token set:", bool(TOKEN))
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            WORKER.call(WORKER.stop_browser, timeout=30)
        except Exception:
            pass


if __name__ == "__main__":
    main()
