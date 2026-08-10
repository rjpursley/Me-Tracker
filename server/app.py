# -----------------------------------------------------------------------------
# server/app.py — Me-Tracker's server. ARCHITECTURE.md §2, §3.
#
# Two jobs, and only these two today:
#   1. Serve the client's static files (index.html, js/, styles/) so the app
#      loads at all.
#   2. Answer GET /api/health so something exists to check the server is up.
#
# Everything else (Google Health sync, the vision queue, barcode lookup) is a
# LATER task. api_router below is where that work attaches — see the comment
# at its definition. Do not build those here.
#
# BINDS 127.0.0.1:8123 ONLY. Tailscale is what exposes this externally, via
# `tailscale serve` reverse-proxying https://<hostname>.<tailnet>.ts.net into
# this loopback port (ARCHITECTURE.md §2). This process never listens on
# 0.0.0.0 and never needs to — if Tailscale is down, the app is simply
# unreachable, which is accepted (§2).
#
# Run directly: `python app.py` (or via the venv's python — see
# server/start-server.ps1, which is what the boot task actually calls).
# -----------------------------------------------------------------------------

import os
from datetime import datetime, timezone
from pathlib import Path

import uvicorn
from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

HOST = "127.0.0.1"
PORT = 8123

REPO_ROOT = Path(__file__).resolve().parent.parent
INDEX_HTML = REPO_ROOT / "index.html"
JS_DIR = REPO_ROOT / "js"
STYLES_DIR = REPO_ROOT / "styles"

app = FastAPI(title="Me-Tracker server")


# -----------------------------------------------------------------------------
# Secrets — ARCHITECTURE.md §3. Never read, print, or move the files inside.
#
# secrets_readable() checks ONLY whether the directory itself exists and is
# readable by this process. It does not open, list, or name a single file
# inside it. That is deliberate: /api/health is allowed to say "the secrets
# directory is fine" or "something's wrong with it", never anything more.
# -----------------------------------------------------------------------------
def secrets_dir() -> Path:
    override = os.environ.get("METRACKER_SECRETS_DIR")
    return Path(override) if override else Path.home() / ".metracker"


def secrets_readable() -> bool:
    try:
        d = secrets_dir()
        return d.is_dir() and os.access(d, os.R_OK)
    except OSError:
        return False


# -----------------------------------------------------------------------------
# api_router — everything under /api.
#
# /health is the only route today. THIS IS WHERE LATER TASKS ATTACH:
#   - Google Health sync   (OAuth refresh, paginated pulls, aggregation —
#     server/google_health.py, ARCHITECTURE.md §6)
#   - Vision queue          (Ollama minicpm-v job queue — server/vision.py,
#     ARCHITECTURE.md §8)
#   - Barcode lookup        (Open Food Facts — server/barcode.py, §8)
#
# Do not implement any of those here. This task only builds the skeleton they
# plug into, per explicit instruction.
# -----------------------------------------------------------------------------
api_router = APIRouter()


@api_router.get("/health")
async def health():
    return {
        "status": "ok",
        # An INSTANT, so UTC ISO per ARCHITECTURE.md §12 — the same rule the
        # client's deviation timestamps follow. Never a local calendar date.
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "secrets_readable": secrets_readable(),
    }


app.include_router(api_router, prefix="/api")


# -----------------------------------------------------------------------------
# Static client files — deliberately NOT the whole repo.
#
# Only index.html, js/, and styles/ are served, matching the exact three
# things ARCHITECTURE.md §3 calls "the client". `python -m http.server` from
# the repo root (the throwaway pattern used to test this app for months)
# serves EVERYTHING in the directory — .git/, ARCHITECTURE.md, this very
# source file, the RTF program doc. That was fine for a local-only, thrown-
# away test server; it is not fine for something that sits reachable on the
# tailnet indefinitely. Mounting exactly these three keeps every relative
# path in index.html resolving exactly as before (styles/tokens.css,
# js/app.js, js/pages/*.js) without exposing anything else in the repo.
#
# No-cache headers on .js/.css only, added by middleware below — this is
# NOT accomplished via StaticFiles' constructor (it has no per-extension
# header hook) and is why the middleware exists rather than a subclass.
# -----------------------------------------------------------------------------
@app.get("/")
async def index():
    return FileResponse(INDEX_HTML)


@app.get("/index.html")
async def index_html():
    return FileResponse(INDEX_HTML)


app.mount("/js", StaticFiles(directory=JS_DIR), name="js")
app.mount("/styles", StaticFiles(directory=STYLES_DIR), name="styles")


# -----------------------------------------------------------------------------
# No-cache headers on .js and .css — ARCHITECTURE.md §12 territory in spirit.
#
# ES module caching has cost real time across multiple sessions testing this
# app: a browser (or this app's own test harness) would keep serving a
# stale copy of a module after it was edited, with no visible sign anything
# was wrong. A plain middleware inspecting the response path is simpler and
# more robust than subclassing StaticFiles' internals (which differ across
# starlette versions) — it works the same regardless of how a response for
# a .js/.css path was produced.
# -----------------------------------------------------------------------------
@app.middleware("http")
async def no_cache_for_scripts_and_styles(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.endswith((".js", ".css")):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


if __name__ == "__main__":
    # No --reload: this runs unattended, at boot, with no one watching a
    # console. Reload's file-watcher subprocess is for local development only.
    uvicorn.run(app, host=HOST, port=PORT)
