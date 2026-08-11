# -----------------------------------------------------------------------------
# server/google_health.py — Google Health API sync engine. ARCHITECTURE.md §6.
#
# Two things this file is NOT:
#   - It is not the interactive consent flow. That is google_health_auth.py,
#     run BY HAND, once, by Ryan. This file only ever REFRESHES an existing
#     refresh token — if one isn't on disk, it fails with a message pointing
#     at that script rather than trying to pop a browser open from a
#     background service (there is no browser to pop from SYSTEM).
#   - It is not the database. Per ARCHITECTURE.md §1.2 the browser's
#     localStorage stays the source of truth; this is a sidecar that fetches,
#     aggregates, and hands back small daily summaries via server/app.py's
#     /api/vitals endpoints. The aggregated store here
#     (server/data/vitals_daily.json) exists only so the browser doesn't have
#     to wait on a live Google Health pull for every page load.
#
# THE TWO RULES THAT SILENTLY CORRUPT DATA IF IGNORED (ARCHITECTURE.md §6):
#   1. Always follow nextPageToken. Responses cap at a few thousand rows and
#      one day of 5-second heart-rate samples is ~8,700 — see
#      fetch_data_points() below, which loops until nextPageToken is absent
#      and logs the page count so a silent truncation would be visible in
#      server/logs/sync.log instead of just looking like a short day.
#   2. Aggregate on ingest. The browser never sees a raw sample — only
#      aggregate_day()'s output. Raw pulls are cached under server/data/raw/
#      for 7 days for debugging (purge_old_raw()) and never served to the
#      client (server/app.py's /api/vitals routes read the daily store only).
#
# HONESTY NOTE ON FIELD NAMES: the Google Health API's public docs (as of
# this build — developers.google.com/health) confirm the endpoint shapes,
# pagination parameters (pageSize/pageToken/nextPageToken) and the general
# DataPoint union pattern, but do not fully specify every value field name for
# every data type, or the exact `filter` grammar per type. This file is
# written defensively as a result: _value_block()/_numeric() look for a
# typed value under a set of plausible field names rather than assuming one,
# fetch_data_points() tries two plausible filter grammars before giving up on
# a type, and every pull logs the raw shape of its first result to
# server/logs/sync.log so the *real* shape is visible and correctable the
# first time this runs against live data. Treat that log as the source of
# truth over this comment if they disagree.
# -----------------------------------------------------------------------------

import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from google.auth.exceptions import RefreshError
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2.credentials import Credentials

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(__file__).resolve().parent / "data"
DAILY_STORE = DATA_DIR / "vitals_daily.json"
RAW_DIR = DATA_DIR / "raw"
LOG_DIR = Path(__file__).resolve().parent / "logs"

CLIENT_SECRET_FILENAME = "client_secret.json"
REFRESH_TOKEN_FILENAME = "google_refresh_token.json"

# Same three scopes as test_fitbit.py's validated flow (repo root) — activity,
# health metrics/measurements, and sleep, all read-only.
SCOPES = [
    'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
    'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
    'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
]

API_BASE = "https://health.googleapis.com/v4"
TOKEN_URI = "https://oauth2.googleapis.com/token"

DEFAULT_RAW_RETENTION_DAYS = 7
MAX_RETRIES = 5
RETRY_BACKOFF_BASE = 2.0  # seconds; multiplied by attempt number

# data type key (used internally + in the filter string) -> URL path segment
# (kebab-case, per the API's own kebab-in-path / snake-in-filter convention).
DATA_TYPES = {
    'exercise': 'exercise',
    'steps': 'steps',
    'heart_rate': 'heart-rate',
    'daily_resting_heart_rate': 'daily-resting-heart-rate',
    'daily_hrv': 'daily-heart-rate-variability',
    'time_in_hr_zone': 'time-in-heart-rate-zone',
    'weight': 'weight',
    'body_fat': 'body-fat',
    'vo2_max': 'daily-vo2-max',
    'sleep': 'sleep',
}

# Session-shaped types (an interval with a start and an end) vs sample-shaped
# types (one instant, one value). Confirmed for exercise/sleep/steps/weight/
# heart_rate by the API's DataPoint union docs; the daily-* and
# time-in-heart-rate-zone types are a best guess (interval, since "time IN a
# zone" and "OF a day" both describe a span) — fetch_data_points() falls back
# to the other shape automatically if this guess is wrong for a given type.
SESSION_TYPES = {'exercise', 'sleep', 'steps', 'time_in_hr_zone'}

# exercise/sleep are session logs, not high-frequency samples — the API caps
# their page size at 25 regardless of what's requested. Everything else can
# ask for up to the documented 10,000; 1000 is used here to keep each logged
# page a manageable size without multiplying page count (and therefore sync
# time) unnecessarily.
MAX_PAGE_SIZE = {'exercise': 25, 'sleep': 25}
DEFAULT_PAGE_SIZE = 1000


class GoogleHealthAuthError(Exception):
    """No usable credentials. Message is safe to log/display — it never
    contains a secret value, only what's wrong and which script fixes it."""


class GoogleHealthSyncError(Exception):
    """One data type's pull could not be completed. Callers catch this per
    type so one failure doesn't block the others or touch previously stored
    days — a failed sync must leave prior data intact (ARCHITECTURE.md §6)."""


def _setup_logger():
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log = logging.getLogger("google_health")
    if log.handlers:
        return log  # avoid duplicate handlers if this module is imported twice
    log.setLevel(logging.INFO)
    handler = logging.FileHandler(LOG_DIR / "sync.log", encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    log.addHandler(handler)
    return log


logger = _setup_logger()


# -----------------------------------------------------------------------------
# Secrets — NEVER read, print, log or return the contents beyond the two
# specific fields pulled out below to build a Credentials object in memory.
# -----------------------------------------------------------------------------

def secrets_dir() -> Path:
    override = os.environ.get("METRACKER_SECRETS_DIR")
    return Path(override) if override else Path.home() / ".metracker"


def _read_client_id_secret():
    d = secrets_dir()
    f = d / CLIENT_SECRET_FILENAME
    if not f.is_file():
        raise GoogleHealthAuthError(
            f"No {CLIENT_SECRET_FILENAME} in {d}. Put the Google OAuth client "
            f"file there (or point METRACKER_SECRETS_DIR at the folder that has it)."
        )
    try:
        raw = json.loads(f.read_text())
    except (OSError, json.JSONDecodeError) as e:
        raise GoogleHealthAuthError(f"Could not parse {f} as JSON: {e}") from e
    block = raw.get("installed") or raw.get("web") or raw
    client_id = block.get("client_id")
    client_secret = block.get("client_secret")
    token_uri = block.get("token_uri", TOKEN_URI)
    if not client_id or not client_secret:
        raise GoogleHealthAuthError(
            f"{f} does not look like a valid OAuth client file "
            f"(missing client_id/client_secret)."
        )
    return client_id, client_secret, token_uri


def _read_refresh_token() -> str:
    d = secrets_dir()
    f = d / REFRESH_TOKEN_FILENAME
    if not f.is_file():
        raise GoogleHealthAuthError(
            "No refresh token on file yet. Run the one-time consent flow by hand:\n"
            "    server\\.venv\\Scripts\\python.exe server\\google_health_auth.py\n"
            "Sign in and grant access when the browser opens — this only needs "
            "to be done once (and again later if Google expires it; the app is "
            "in Testing status, so that's expected maintenance, not a bug — "
            "ARCHITECTURE.md §6)."
        )
    try:
        raw = json.loads(f.read_text())
    except (OSError, json.JSONDecodeError) as e:
        raise GoogleHealthAuthError(f"Could not parse {f} as JSON: {e}") from e
    token = raw.get("refresh_token")
    if not token:
        raise GoogleHealthAuthError(
            f"{f} exists but has no refresh_token field. Re-run google_health_auth.py."
        )
    return token


def get_credentials() -> Credentials:
    """Loads the client id/secret and refresh token from .metracker/ and
    exchanges the refresh token for a fresh access token. Raises
    GoogleHealthAuthError with a plain-language fix if anything is missing or
    Google rejects the refresh token — never attempts an interactive browser
    flow itself (there is no browser to show it to from a background
    service)."""
    client_id, client_secret, token_uri = _read_client_id_secret()
    refresh_token = _read_refresh_token()
    creds = Credentials(
        token=None,
        refresh_token=refresh_token,
        client_id=client_id,
        client_secret=client_secret,
        token_uri=token_uri,
        scopes=SCOPES,
    )
    try:
        creds.refresh(GoogleAuthRequest())
    except RefreshError as e:
        raise GoogleHealthAuthError(
            "Google rejected the refresh token (expired or revoked — expected "
            "maintenance for an app kept in Testing status, ARCHITECTURE.md §6, "
            "not a bug). Re-run:\n"
            "    server\\.venv\\Scripts\\python.exe server\\google_health_auth.py"
        ) from e
    except requests.RequestException as e:
        raise GoogleHealthSyncError(f"Network error refreshing the access token: {e}") from e
    return creds


# -----------------------------------------------------------------------------
# HTTP + pagination.
# -----------------------------------------------------------------------------

def _iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%S')


def _build_filter(data_type_key, start_dt, end_dt, mode):
    if mode == 'interval':
        return (f'{data_type_key}.interval.civil_start_time >= "{_iso(start_dt)}" AND '
                f'{data_type_key}.interval.civil_end_time <= "{_iso(end_dt)}"')
    return (f'{data_type_key}.sample_time.civil_time >= "{_iso(start_dt)}" AND '
            f'{data_type_key}.sample_time.civil_time <= "{_iso(end_dt)}"')


def _request_with_retry(url, params, access_token, session):
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    last_exc = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = session.get(url, headers=headers, params=params, timeout=30)
        except requests.RequestException as e:
            last_exc = e
            logger.warning("network error on %s (attempt %d/%d): %s", url, attempt, MAX_RETRIES, e)
            time.sleep(RETRY_BACKOFF_BASE * attempt)
            continue
        if resp.status_code == 429 or resp.status_code >= 500:
            logger.warning("HTTP %s from %s (attempt %d/%d) — backing off", resp.status_code, url, attempt, MAX_RETRIES)
            time.sleep(RETRY_BACKOFF_BASE * attempt)
            continue
        return resp
    raise GoogleHealthSyncError(f"Exhausted {MAX_RETRIES} retries against {url}: {last_exc}")


def fetch_data_points(data_type_key, start_dt, end_dt, credentials, session=None):
    """Pulls every dataPoint for one data type across [start_dt, end_dt),
    following nextPageToken TO EXHAUSTION — see the module docstring, rule 1.
    Returns (points, page_count). Raises GoogleHealthSyncError if the pull
    could not be completed; callers must treat that as "unknown", never as
    "empty", and must not overwrite previously stored data for days this call
    covered."""
    session = session or requests.Session()
    path = DATA_TYPES[data_type_key]
    url = f"{API_BASE}/users/me/dataTypes/{path}/dataPoints"
    page_size = MAX_PAGE_SIZE.get(data_type_key, DEFAULT_PAGE_SIZE)

    filter_mode = 'interval' if data_type_key in SESSION_TYPES else 'sample'
    points = []
    page_token = None
    page_count = 0
    tried_fallback_mode = False

    while True:
        if credentials.expired:
            credentials.refresh(GoogleAuthRequest())

        params = {"pageSize": page_size, "filter": _build_filter(data_type_key, start_dt, end_dt, filter_mode)}
        if page_token:
            params["pageToken"] = page_token

        resp = _request_with_retry(url, params, credentials.token, session)

        if resp.status_code == 400 and not tried_fallback_mode and not page_token:
            # The filter grammar for this data type may not match our first
            # guess (see the module docstring's honesty note). Try the other
            # shape once, from the start, before giving up on this type.
            tried_fallback_mode = True
            filter_mode = 'sample' if filter_mode == 'interval' else 'interval'
            logger.warning("%s: filter rejected (400) in mode=%s, retrying as mode=%s",
                            data_type_key, 'sample' if filter_mode == 'interval' else 'interval', filter_mode)
            continue

        if resp.status_code != 200:
            raise GoogleHealthSyncError(f"{data_type_key}: HTTP {resp.status_code} — {resp.text[:300]}")

        try:
            body = resp.json()
        except ValueError as e:
            raise GoogleHealthSyncError(f"{data_type_key}: response was not JSON: {e}") from e

        page_count += 1
        page_points = body.get("dataPoints", [])
        points.extend(page_points)

        if page_count == 1 and page_points:
            logger.info("%s: sample dataPoint shape (page 1, first row): %s",
                        data_type_key, json.dumps(page_points[0], default=str)[:500])

        page_token = body.get("nextPageToken")
        if not page_token:
            break
        if page_count > 500:
            # A real safety valve, not an expected outcome — 500 pages at
            # 1000/page is 500,000 rows for one type in one sync window. If
            # this ever fires it means either the filter isn't bounding the
            # range (see the honesty note) or something is genuinely wrong;
            # either way, looping forever is worse than stopping and logging.
            logger.error("%s: stopped after 500 pages — filter may not be bounding the range correctly", data_type_key)
            break

    logger.info("%s: pulled %d dataPoint(s) across %d page(s) for %s..%s",
                data_type_key, len(points), page_count, start_dt.date(), end_dt.date())
    return points, page_count


# -----------------------------------------------------------------------------
# Parsing — defensive on purpose. See the module docstring's honesty note.
# -----------------------------------------------------------------------------

_TIMING_KEYS = {'name', 'dataSource', 'startTime', 'endTime', 'startUtcOffset',
                'endUtcOffset', 'physicalTime', 'utcOffset'}


def _value_block(dp):
    """Each dataPoint is a union: exactly one typed field alongside timing/
    metadata fields. Returns (key, value_dict) for the first field that isn't
    a known timing/metadata key."""
    if not isinstance(dp, dict):
        return None, None
    for k, v in dp.items():
        if k in _TIMING_KEYS:
            continue
        if isinstance(v, dict):
            return k, v
    return None, None


def _numeric(block, candidates):
    if not isinstance(block, dict):
        return None
    for c in candidates:
        v = block.get(c)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return float(v)
    return None


def _local_date_str(ts):
    if not ts or not isinstance(ts, str):
        return None
    try:
        dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
    except ValueError:
        return None
    return dt.date().isoformat()


def _bucket_by_day(points):
    """Groups dataPoints by their LOCAL calendar date (ARCHITECTURE.md §12 —
    a day is a local-calendar concept, not a UTC one). Looks for a start/
    sample time at the top level first, then inside the value block's own
    interval/sampleTime, since the union means we don't know the field name
    for a given type in advance."""
    buckets = {}
    for dp in points:
        ts = dp.get('startTime') or dp.get('physicalTime')
        if not ts:
            _, block = _value_block(dp)
            if isinstance(block, dict):
                interval = block.get('interval') or {}
                ts = interval.get('startTime') or block.get('sampleTime') or block.get('physicalTime')
        day = _local_date_str(ts)
        if day is None:
            continue
        buckets.setdefault(day, []).append(dp)
    return buckets


def aggregate_day(date_str, raw):
    """Turns one day's raw pulls into the small summary the browser is
    allowed to see (ARCHITECTURE.md §6, module docstring rule 2). Every field
    defaults to null/empty rather than 0 when nothing was pulled — a 0 on a
    health console reads as a measurement, not an absence (§1.7)."""
    summary = {
        'date': date_str,
        'restingHR': None,
        # The one exception to "no raw samples reach the client": the single
        # most-recent heart-rate sample of the day, reduced to one bpm number
        # + its timestamp. This is what the client's vitals header shows as
        # "live" HR (ARCHITECTURE.md §4) — it is only ever as fresh as the
        # last sync, never a real-time stream, but it is a genuinely small
        # daily summary field, not the raw intraday series.
        'latestHR': None,
        'hrv': None,
        'vo2Max': None,
        'weightLbs': None,
        'bodyFatPct': None,
        'steps': None,
        'hrZoneMinutes': {},
        'sleep': {'totalMinutes': None, 'stageMinutes': {}},
        'workout': {'avgHR': None, 'peakHR': None},
        'startedActivities': [],
    }

    if raw.get('steps'):
        total, any_seen = 0.0, False
        for dp in raw['steps']:
            _, block = _value_block(dp)
            v = _numeric(block, ['count', 'steps', 'value'])
            if v is not None:
                total += v
                any_seen = True
        if any_seen:
            summary['steps'] = int(round(total))

    if raw.get('heart_rate'):
        latest_ts, latest_bpm = None, None
        for dp in raw['heart_rate']:
            _, block = _value_block(dp)
            v = _numeric(block, ['beatsPerMinute', 'bpm', 'value'])
            ts = dp.get('physicalTime') or dp.get('startTime')
            if v is not None and ts and (latest_ts is None or ts > latest_ts):
                latest_ts, latest_bpm = ts, v
        if latest_bpm is not None:
            summary['latestHR'] = {'bpm': round(latest_bpm), 'at': latest_ts}

    if raw.get('daily_resting_heart_rate'):
        for dp in raw['daily_resting_heart_rate']:
            _, block = _value_block(dp)
            v = _numeric(block, ['beatsPerMinute', 'bpm', 'value'])
            if v is not None:
                summary['restingHR'] = round(v)

    if raw.get('daily_hrv'):
        for dp in raw['daily_hrv']:
            _, block = _value_block(dp)
            v = _numeric(block, ['milliseconds', 'rmssdMillis', 'value'])
            if v is not None:
                summary['hrv'] = round(v, 1)

    if raw.get('vo2_max'):
        for dp in raw['vo2_max']:
            _, block = _value_block(dp)
            v = _numeric(block, ['vo2Max', 'mlPerKgMin', 'score', 'value'])
            if v is not None:
                summary['vo2Max'] = round(v, 1)

    if raw.get('weight'):
        for dp in raw['weight']:
            _, block = _value_block(dp)
            grams = _numeric(block, ['weightGrams', 'grams'])
            if grams is not None:
                summary['weightLbs'] = round(grams / 453.59237, 1)
            else:
                lbs = _numeric(block, ['weightLbs', 'lbs', 'value'])
                if lbs is not None:
                    summary['weightLbs'] = round(lbs, 1)

    if raw.get('body_fat'):
        for dp in raw['body_fat']:
            _, block = _value_block(dp)
            v = _numeric(block, ['percentage', 'percent', 'value'])
            if v is not None:
                summary['bodyFatPct'] = round(v, 1)

    if raw.get('time_in_hr_zone'):
        # Passed through under whatever zone labels the device/API uses.
        # NOT the app's own Karvonen zones (§5) — those are computed
        # client-side for the live header only, from live HR + weekly resting
        # HR + age. This is a separate, device-defined historical bucket.
        for dp in raw['time_in_hr_zone']:
            _, block = _value_block(dp)
            if isinstance(block, dict):
                for zk, zv in block.items():
                    if isinstance(zv, (int, float)) and not isinstance(zv, bool):
                        summary['hrZoneMinutes'][zk] = summary['hrZoneMinutes'].get(zk, 0) + zv

    if raw.get('sleep'):
        stage_totals, total_minutes, any_seen = {}, 0.0, False
        for dp in raw['sleep']:
            _, block = _value_block(dp)
            if not isinstance(block, dict):
                continue
            any_seen = True
            stages = block.get('stages')
            if isinstance(stages, list):
                for stage in stages:
                    if not isinstance(stage, dict):
                        continue
                    name = stage.get('type') or stage.get('stage') or 'unknown'
                    mins = _numeric(stage, ['durationMinutes'])
                    if mins is None:
                        ms = _numeric(stage, ['durationMillis', 'durationMs'])
                        if ms is not None:
                            mins = ms / 60000.0
                    if mins is not None:
                        stage_totals[name] = stage_totals.get(name, 0) + mins
                        total_minutes += mins
        if any_seen:
            summary['sleep']['totalMinutes'] = round(total_minutes) if total_minutes else None
            summary['sleep']['stageMinutes'] = {k: round(v) for k, v in stage_totals.items()}

    if raw.get('exercise'):
        # THE started-activity signal (ARCHITECTURE.md §9.5 / derive.js
        # hasStartedActivity). A dataPoint existing here at all means a
        # tracked session was actively started — that is the whole rule.
        # NO DURATION OR HEART-RATE THRESHOLD IS APPLIED HERE OR ANYWHERE
        # DOWNSTREAM. Do not add one; see the block comment on
        # hasStartedActivity() in js/derive.js for why.
        avg_hrs, peak_hrs = [], []
        for dp in raw['exercise']:
            _, block = _value_block(dp)
            if not isinstance(block, dict):
                continue
            interval = block.get('interval') or {}
            activity_type = block.get('exerciseType') or block.get('activityType') or 'UNKNOWN'
            summary['startedActivities'].append({
                'activityType': activity_type,
                'startTime': dp.get('startTime') or interval.get('startTime'),
                'endTime': dp.get('endTime') or interval.get('endTime'),
            })
            metrics = block.get('metricsSummary') or {}
            avg_hr = _numeric(metrics, ['averageHeartRateBeatsPerMinute', 'avgHeartRate', 'averageHeartRate'])
            peak_hr = _numeric(metrics, ['maxHeartRateBeatsPerMinute', 'peakHeartRate', 'maxHeartRate'])
            if avg_hr is not None:
                avg_hrs.append(avg_hr)
            if peak_hr is not None:
                peak_hrs.append(peak_hr)
        if avg_hrs:
            summary['workout']['avgHR'] = round(sum(avg_hrs) / len(avg_hrs))
        if peak_hrs:
            summary['workout']['peakHR'] = round(max(peak_hrs))

    return summary


# -----------------------------------------------------------------------------
# Server-side store — the aggregated daily summaries. NOT metracker_v2 (§1.2);
# this is the sidecar's own cache so /api/vitals doesn't block on a live pull.
# -----------------------------------------------------------------------------

def _load_daily_store():
    if not DAILY_STORE.is_file():
        return {}
    try:
        return json.loads(DAILY_STORE.read_text())
    except (OSError, json.JSONDecodeError) as e:
        logger.error("vitals_daily.json unreadable (%s) — leaving the file untouched; "
                      "this run will merge new days into an EMPTY in-memory copy rather "
                      "than risk writing over a file it can't parse", e)
        return {}


def _save_daily_store(store):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = DAILY_STORE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(store, indent=2, sort_keys=True))
    tmp.replace(DAILY_STORE)  # atomic rename — a crash mid-write can't corrupt the previous file


def purge_old_raw(retention_days=DEFAULT_RAW_RETENTION_DAYS):
    """Raw intraday samples are for debugging only and are discarded after
    about a week (ARCHITECTURE.md §6, module docstring rule 2)."""
    if not RAW_DIR.is_dir():
        return
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).date()
    for f in RAW_DIR.glob("*.json"):
        try:
            day = datetime.strptime(f.stem, "%Y-%m-%d").date()
        except ValueError:
            continue
        if day < cutoff:
            try:
                f.unlink()
            except OSError as e:
                logger.warning("could not purge stale raw cache %s: %s", f, e)


def sync_range(start_date: str, end_date: str) -> dict:
    """Pulls every data type for [start_date, end_date] (inclusive, local
    calendar dates), aggregates per day, and merges into the daily store.

    A failure pulling one data type does NOT block the others, and does not
    touch previously stored days — only days this call actually produced new
    data for are written. If every type fails (e.g. no credentials), the
    store file is not opened at all, so an unreadable/missing store can never
    look like "correctly synced to nothing."

    Returns a plain dict — counts, page counts, errors — safe to log and to
    hand back from POST /api/sync. Never contains a secret."""
    result = {'start': start_date, 'end': end_date, 'types': {}, 'errors': [], 'daysWritten': []}
    logger.info("sync_range(%s, %s) starting", start_date, end_date)

    try:
        creds = get_credentials()
    except GoogleHealthAuthError as e:
        logger.error("sync aborted before any pull: %s", e)
        result['errors'].append(str(e))
        return result

    start_dt = datetime.fromisoformat(start_date + 'T00:00:00')
    end_dt = datetime.fromisoformat(end_date + 'T23:59:59')
    session = requests.Session()

    raw_by_day = {}
    for type_key in DATA_TYPES:
        try:
            points, pages = fetch_data_points(type_key, start_dt, end_dt, creds, session)
        except GoogleHealthSyncError as e:
            logger.error("%s: pull failed, leaving prior data for this type untouched: %s", type_key, e)
            result['errors'].append(f"{type_key}: {e}")
            continue
        result['types'][type_key] = {'count': len(points), 'pages': pages}
        for day, pts in _bucket_by_day(points).items():
            raw_by_day.setdefault(day, {})[type_key] = pts

    if not raw_by_day:
        logger.warning("sync_range(%s, %s): every data type failed or returned nothing — store untouched", start_date, end_date)
        return result

    store = _load_daily_store()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    for day, raw in raw_by_day.items():
        store[day] = aggregate_day(day, raw)
        result['daysWritten'].append(day)
        try:
            (RAW_DIR / f"{day}.json").write_text(json.dumps(raw, default=str))
        except OSError as e:
            logger.warning("could not write raw debug cache for %s: %s", day, e)

    _save_daily_store(store)
    purge_old_raw()
    logger.info("sync_range(%s, %s) done — wrote %d day(s), %d type error(s)",
                start_date, end_date, len(result['daysWritten']), len(result['errors']))
    return result


def get_day(date_str):
    return _load_daily_store().get(date_str)


def get_range(start_date, end_date):
    store = _load_daily_store()
    return {d: v for d, v in store.items() if start_date <= d <= end_date}


def last_sync_info():
    """When the daily store file was last written, and how many days it
    holds — the fastest way to answer "did the last sync actually run"
    without reading the full log (ARCHITECTURE.md §6)."""
    if not DAILY_STORE.is_file():
        return {'lastWriteUtc': None, 'daysStored': 0}
    stat = DAILY_STORE.stat()
    store = _load_daily_store()
    return {
        'lastWriteUtc': datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        'daysStored': len(store),
    }


if __name__ == "__main__":
    import sys
    from datetime import date

    today = date.today().isoformat()
    start = sys.argv[1] if len(sys.argv) > 1 else today
    end = sys.argv[2] if len(sys.argv) > 2 else today
    print(f"Syncing {start}..{end} — see server/logs/sync.log for detail.")
    out = sync_range(start, end)
    print(json.dumps(out, indent=2, default=str))
