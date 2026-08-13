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

import asyncio
import os
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import uvicorn
from fastapi import APIRouter, FastAPI, Query, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import google_health

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


# -----------------------------------------------------------------------------
# Google Health sync — ARCHITECTURE.md §6. All real work lives in
# google_health.py; these routes are thin wrappers that return its already-
# aggregated daily summaries (never a raw sample — see that module's
# docstring) and never anything read from .metracker/ directly.
#
# SYNC_RANGE_DAYS controls how many trailing days a sync (manual or nightly)
# re-pulls, not just "today". Fitbit/Google often finish settling a day's
# sleep and HRV only once Ryan's phone itself syncs overnight, sometimes past
# midnight — a sync that only ever asked for "today" could permanently miss a
# late-settling yesterday. Re-pulling a small trailing window is cheap
# (aggregate_day() just overwrites that day's summary with whatever is now
# available) and makes that class of miss self-correcting within days.
# -----------------------------------------------------------------------------
SYNC_RANGE_DAYS = 3


@api_router.get("/vitals/{day}")
async def vitals_day(day: str):
    summary = google_health.get_day(day)
    if summary is None:
        return {"date": day, "found": False}
    return {**summary, "found": True}


@api_router.get("/vitals")
async def vitals_range(from_date: str = Query(..., alias="from"), to_date: str = Query(..., alias="to")):
    return {"from": from_date, "to": to_date, "days": google_health.get_range(from_date, to_date)}


@api_router.post("/sync")
async def trigger_sync():
    end = date.today()
    start = end - timedelta(days=SYNC_RANGE_DAYS - 1)
    # sync_range() makes real, possibly slow, blocking HTTP calls — run it off
    # the event loop so a manual sync can't stall /api/health or the static
    # file routes for whoever else is loading the app at the same moment.
    #
    # Every type, whole-day overwrite — a manual sync is a FULL sync, the same
    # as the nightly. Only the hourly loop below pulls a subset.
    return await asyncio.to_thread(
        google_health.sync_range, start.isoformat(), end.isoformat(), None, 'manual')


@api_router.get("/sync/status")
async def sync_status():
    return google_health.last_sync_info()


app.include_router(api_router, prefix="/api")


# -----------------------------------------------------------------------------
# Nightly automatic sync — ARCHITECTURE.md §6.
#
# 04:15 LOCAL, CHOSEN DELIBERATELY:
#   - The Ollama vision window (ARCHITECTURE.md §8) runs 20:30-03:55 and
#     shares the Alienware's GPU/VRAM with a trading bot. 04:15 sits a clean
#     20 minutes past the end of that window, so a sync never overlaps it.
#   - Fitbit/Google generally finish settling the previous day's sleep and
#     HRV only after Ryan's phone itself syncs overnight — running earlier
#     risks pulling an incomplete "yesterday". 04:15 is late enough that this
#     has almost always already happened.
#   - It is well before Ryan is normally awake, so the pull's network burst
#     is never competing with anything he's actively doing on the app.
#
# Every attempt and its outcome is logged to server/logs/sync.log by
# google_health.py itself — same reasoning as boot.log (ARCHITECTURE.md §2.3):
# a sync that silently never fires should leave a visible gap in that log,
# not just an app that quietly never has today's numbers.
# -----------------------------------------------------------------------------
NIGHTLY_SYNC_HOUR = 4
NIGHTLY_SYNC_MINUTE = 15


async def _nightly_sync_loop():
    while True:
        now = datetime.now()
        target = now.replace(hour=NIGHTLY_SYNC_HOUR, minute=NIGHTLY_SYNC_MINUTE, second=0, microsecond=0)
        if target <= now:
            target += timedelta(days=1)
        await asyncio.sleep((target - now).total_seconds())
        try:
            end = date.today()
            start = end - timedelta(days=SYNC_RANGE_DAYS - 1)
            result = await asyncio.to_thread(
                google_health.sync_range, start.isoformat(), end.isoformat(), None, 'nightly')
            google_health.logger.info("nightly sync fired: %s", result)
        except Exception as e:
            # A scheduler loop must never die from one bad night — that would
            # silently turn into "never syncs again until the process
            # restarts," which is exactly the kind of silent failure §2.3's
            # boot.log and this file's sync.log both exist to avoid.
            google_health.logger.error("nightly sync loop raised unexpectedly: %s", e)


# -----------------------------------------------------------------------------
# Hourly today-only sync — ARCHITECTURE.md §6.3.
#
# THE PROBLEM THIS SOLVES: before it existed, 04:15 was the only sync that ever
# fired. Its trailing 3-day window includes "today", but at 04:15 today is four
# hours old and nearly empty — measured 2026-08-12 at 21:15 local, the stored
# day read 8 steps with a latest heart rate from 04:04. Today's numbers were
# blank all day, every day.
#
# WHY THIS IS NOT JUST "RUN THE NIGHTLY MORE OFTEN":
#   - TODAY ONLY, not a trailing 3 days. Re-pulling two settled days eighteen
#     times a day is pure waste; the nightly already owns that window and the
#     late-settling reasoning behind it (§6.3) is untouched.
#   - THREE DATA TYPES ONLY. steps, heart_rate and exercise are the values that
#     actually move during a waking day (exercise is what feeds §9.5's
#     hasStartedActivity). Sleep, HRV, resting HR, weight, body fat and VO2 max
#     are daily-settling figures that Google finishes computing overnight —
#     pulling them hourly would cost pages and return the same answer.
#   - Because it pulls a subset, it writes a subset. sync_range(type_keys=...)
#     merges field-by-field (google_health.merge_day) instead of overwriting the
#     day, so the sleep and resting HR the nightly wrote for today at 04:15 are
#     still there at 22:00. Overwriting them with the nulls of a three-type
#     aggregate would be the classic "clobbered good data" failure.
#
# 06:00-23:00 LOCAL, ON THE HOUR — 18 runs a day. Nothing useful changes while
# Ryan is asleep, and stopping at 23:00 keeps the loop clear of the 04:15
# nightly and of the Ollama vision window (20:30-03:55, §8) having anything to
# contend with at the moment the nightly runs.
#
# LOCAL CIVIL TIME, AND IT MUST SURVIVE DST (§12). Every iteration re-reads the
# local wall clock and computes the next boundary from it; nothing assumes that
# the time actually slept equals the time scheduled. On the two nights a year
# the clock jumps, the long 23:00->06:00 sleep lands an hour early or an hour
# late, and the loop simply corrects itself on the next pass instead of drifting
# permanently. The window is checked against the wall clock at wake-up, never
# computed from UTC.
#
# FAILURE IS NON-FATAL AND NEVER DESTRUCTIVE. sync_range() already leaves the
# store untouched when a pull fails (§6.5's forced-credential-failure test), and
# the except below keeps the loop alive for the next hour. Every attempt is
# logged to sync.log with the same per-type page/row detail as the nightly, so a
# loop that silently stops leaves a visible gap in the log rather than just
# numbers that quietly stop moving.
# -----------------------------------------------------------------------------
HOURLY_SYNC_START_HOUR = 6
HOURLY_SYNC_END_HOUR = 23
HOURLY_SYNC_TYPES = ('steps', 'heart_rate', 'exercise')


def _in_hourly_window(now):
    """Is this local wall-clock time inside the hourly sync's window?"""
    return HOURLY_SYNC_START_HOUR <= now.hour <= HOURLY_SYNC_END_HOUR


def _next_hourly_run(now):
    """The next local wall-clock instant the hourly sync should fire, strictly
    after `now`. Pure function of a naive LOCAL datetime — no UTC anywhere, and
    no hidden clock read, so the schedule can be tested directly instead of by
    waiting an hour."""
    nxt = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    if nxt.hour < HOURLY_SYNC_START_HOUR:
        # Overnight: the 00:00-05:00 stretch folds forward to the day's first run.
        return nxt.replace(hour=HOURLY_SYNC_START_HOUR)
    if nxt.hour > HOURLY_SYNC_END_HOUR:
        # Unreachable while END_HOUR is 23 (there is no later hour), kept so the
        # function stays correct if the window is ever narrowed.
        return (nxt + timedelta(days=1)).replace(hour=HOURLY_SYNC_START_HOUR)
    return nxt


async def _hourly_sync_loop():
    while True:
        now = datetime.now()
        await asyncio.sleep(max(0.0, (_next_hourly_run(now) - now).total_seconds()))
        try:
            # Re-read the clock rather than trusting the sleep: see the DST note
            # above. If the wake-up landed outside the window, skip this pass
            # and let the next iteration schedule properly.
            if not _in_hourly_window(datetime.now()):
                continue
            today_str = date.today().isoformat()
            result = await asyncio.to_thread(
                google_health.sync_range, today_str, today_str,
                list(HOURLY_SYNC_TYPES), 'hourly')
            google_health.logger.info("hourly sync fired: %s", result)
        except Exception as e:
            google_health.logger.error("hourly sync loop raised unexpectedly: %s", e)


@app.on_event("startup")
async def _start_nightly_sync():
    asyncio.create_task(_nightly_sync_loop())
    asyncio.create_task(_hourly_sync_loop())


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
# No-cache headers on index.html, .js and .css — ARCHITECTURE.md §12 territory
# in spirit.
#
# ES module caching has cost real time across multiple sessions testing this
# app: a browser (or this app's own test harness) would keep serving a
# stale copy of a module after it was edited, with no visible sign anything
# was wrong. index.html carries the same risk and was originally left out of
# this list — FileResponse sets no Cache-Control of its own, so a browser is
# free to cache the HTML shell on heuristics alone and never even ask the
# server again. Confirmed directly during the 2026-08-11 PIN-removal session:
# a test browser kept serving a cached index.html with the just-deleted PIN
# block still in it, across brand-new tabs, with zero corresponding request
# in the server's own access log — proof the browser never revalidated.
# A plain middleware inspecting the response path is simpler and more robust
# than subclassing StaticFiles' internals (which differ across starlette
# versions) — it works the same regardless of how a response for one of
# these paths was produced.
# -----------------------------------------------------------------------------
@app.middleware("http")
async def no_cache_for_shell_scripts_and_styles(request: Request, call_next):
    response = await call_next(request)
    if request.url.path in ("/", "/index.html") or request.url.path.endswith((".js", ".css")):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


if __name__ == "__main__":
    # No --reload: this runs unattended, at boot, with no one watching a
    # console. Reload's file-watcher subprocess is for local development only.
    uvicorn.run(app, host=HOST, port=PORT)
