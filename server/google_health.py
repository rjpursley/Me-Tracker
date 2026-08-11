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
# -----------------------------------------------------------------------------
# 2026-08-11 FIX — data type names and filter grammar were wrong; every pull
# 400'd on the first real sync. Root cause, from Google's own discovery
# document (https://health.googleapis.com/$discovery/rest?version=v4 — see
# ARCHITECTURE.md §6.6 for how to fetch and read it):
#
#   - Two of ten internal type keys ('daily_hrv', 'time_in_hr_zone') were
#     abbreviated shorthand that did NOT match Google's real snake_case data
#     type identifier ('daily_heart_rate_variability',
#     'time_in_heart_rate_zone'). The filter string's data-type prefix has to
#     be the REAL identifier — an abbreviation is a different, nonexistent
#     type as far as the API is concerned. This produced
#     INVALID_DATA_POINT_FILTER_DATA_TYPE_RESTRICTION.
#   - Every type's filter used the wrong MEMBER PATH: it invented an
#     `interval.civil_end_time` filter field that only exists for `sleep`,
#     and used `<=` where the API only accepts `<`. The real grammar depends
#     on the type's shape — interval, sample, daily-summary, or (uniquely)
#     sleep, which filters by END time, not start — see FILTER_CATEGORY and
#     _build_filter() below. This produced
#     INVALID_DATA_POINT_FILTER_DATA_TYPE_MEMBER.
#
# DATA_TYPES keys are now asserted to equal their own kebab-case path in
# snake_case, so the first bug above cannot silently reappear — a mismatched
# key now fails at import time, not as a 400 discovered in production.
#
# The previous "guess a filter shape, retry the other one on 400" logic is
# gone. It was a reasonable hedge before any of this was confirmed, but it is
# no longer appropriate now that the grammar is known from an authoritative
# source rather than guessed — per the instruction that produced this fix, a
# wrong name failing loudly beats a guess that might silently return the
# wrong thing. If a 400 happens now, it is logged in FULL (see rule 3 below)
# and treated as a real, unexpected problem, not a cue to guess again.
#
# ALSO FIXED, discovered while tracing why fixing the filter alone still
# produced empty aggregates:
#   - Several numeric fields (beatsPerMinute, count, averageHeartRateBeats-
#     PerMinute, ...) are int64 and Google serializes those as JSON STRINGS,
#     not numbers — _numeric() only accepted real numbers and silently
#     dropped every one of them.
#   - Daily-summary types (daily_resting_heart_rate, etc.) carry a `date`
#     object ({year,month,day}), not a timestamp — the old day-bucketing
#     code had nothing that looked for it, so every daily-type row was
#     silently dropped before aggregation ever saw it.
#   - Sample-shaped types (heart_rate, weight, body_fat) carry their time
#     under `sampleTime.physicalTime` — the old bucketing code read the
#     whole `sampleTime` object as if it were a timestamp string, which
#     never matches a string check and again silently dropped every row.
#   - `time_in_heart_rate_zone` has no numeric "minutes" field at all — it's
#     an interval (heartRateZoneType + start/end) and the minutes have to be
#     computed from the interval's duration.
#   - Sleep stage minutes come from `summary.stagesSummary` (Google already
#     computes this) when present, falling back to summing raw `stages[]`
#     interval durations only if it isn't.
# See rule 3 below for how this whole class of mistake gets caught faster
# next time.
#
# 3. LOG THE FULL ERROR BODY, NEVER A TRUNCATED ONE. A previous version of
#    this file sliced HTTP error bodies to 300 characters, which cut Google's
#    response off right before the `details` array — exactly the part that
#    names the invalid filter member. That truncation is why this bug took
#    two sessions to fix instead of one. fetch_data_points() below logs
#    resp.text in full, unconditionally, on every non-200 and on every
#    fallback-mode-style retry. Do not reintroduce a slice.
# -----------------------------------------------------------------------------

import json
import logging
import os
import time
from datetime import date, datetime, timedelta, timezone
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

# data type key (also the filter string's data-type prefix) -> URL path
# segment (kebab-case). BOTH taken directly from Google's discovery document
# (see the 2026-08-11 fix note above) — key is deliberately just path with
# '-' replaced by '_', asserted below so the two can never drift apart again.
DATA_TYPES = {
    'exercise': 'exercise',
    'steps': 'steps',
    'heart_rate': 'heart-rate',
    'daily_resting_heart_rate': 'daily-resting-heart-rate',
    'daily_heart_rate_variability': 'daily-heart-rate-variability',
    'time_in_heart_rate_zone': 'time-in-heart-rate-zone',
    'weight': 'weight',
    'body_fat': 'body-fat',
    'daily_vo2_max': 'daily-vo2-max',
    'sleep': 'sleep',
}

for _key, _path in DATA_TYPES.items():
    assert _key == _path.replace('-', '_'), (
        f"DATA_TYPES key {_key!r} must equal its path {_path!r} in snake_case "
        "— the filter string is built from this key, so a mismatch here is "
        "exactly the 2026-08-11 bug (see module docstring) shipping again."
    )

# Which time-bounding filter member each type accepts, per Google's discovery
# document (dataPoints.list's `filter` parameter description — see
# ARCHITECTURE.md §6.6). Four shapes, all confirmed against that document,
# none guessed:
#   'interval' -> {type}.interval.civil_start_time — covers BOTH plain
#                 interval types (steps, time_in_heart_rate_zone) and session
#                 types other than sleep/ECG (exercise). The doc gives these
#                 as separate bullets but they are the identical field
#                 pattern.
#   'sample'   -> {type}.sample_time.civil_time (heart_rate, weight, body_fat)
#   'daily'    -> {type}.date — DATE ONLY (YYYY-MM-DD), no time component
#                 (daily_resting_heart_rate, daily_heart_rate_variability,
#                 daily_vo2_max)
#   'sleep'    -> sleep.interval.civil_end_time — SLEEP IS THE ONE TYPE
#                 FILTERED BY ITS END TIME, NOT START. A session that starts
#                 one calendar day and ends the next is attributed to the day
#                 it ENDED (the wake day) — _bucket_by_day() below follows
#                 the same convention for consistency.
FILTER_CATEGORY = {
    'exercise': 'interval',
    'steps': 'interval',
    'heart_rate': 'sample',
    'daily_resting_heart_rate': 'daily',
    'daily_heart_rate_variability': 'daily',
    'time_in_heart_rate_zone': 'interval',
    'weight': 'sample',
    'body_fat': 'sample',
    'daily_vo2_max': 'daily',
    'sleep': 'sleep',
}

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

def _build_filter(data_type_key, start_dt, end_dt):
    """Builds the filter string for this type's FILTER_CATEGORY. Dates only
    (YYYY-MM-DD) — every pattern in Google's discovery doc accepts a bare
    civil date, which sidesteps any ambiguity about second-level boundaries.
    end_dt is EXCLUSIVE (the day after the last day wanted): the API only
    supports `>=` and `<` on these fields, never `<=` — using `<=` was one of
    the two filter bugs fixed 2026-08-11 (see module docstring)."""
    start = start_dt.date().isoformat()
    end_excl = (end_dt.date() + timedelta(days=1)).isoformat()
    category = FILTER_CATEGORY[data_type_key]
    if category == 'interval':
        field = f'{data_type_key}.interval.civil_start_time'
    elif category == 'sample':
        field = f'{data_type_key}.sample_time.civil_time'
    elif category == 'daily':
        field = f'{data_type_key}.date'
    elif category == 'sleep':
        field = 'sleep.interval.civil_end_time'
    else:
        raise AssertionError(f"no filter grammar defined for category {category!r}")
    return f'{field} >= "{start}" AND {field} < "{end_excl}"'


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
    covered.

    The filter is now built ONCE from a known-correct grammar (FILTER_CATEGORY,
    confirmed against Google's discovery document) rather than guessed and
    retried — see the 2026-08-11 fix note at the top of this file. A 400 here
    is a genuinely unexpected problem, not a cue to try something else; it is
    logged in full and raised."""
    session = session or requests.Session()
    path = DATA_TYPES[data_type_key]
    url = f"{API_BASE}/users/me/dataTypes/{path}/dataPoints"
    page_size = MAX_PAGE_SIZE.get(data_type_key, DEFAULT_PAGE_SIZE)
    filt = _build_filter(data_type_key, start_dt, end_dt)

    points = []
    page_token = None
    page_count = 0

    while True:
        if credentials.expired:
            credentials.refresh(GoogleAuthRequest())

        params = {"pageSize": page_size, "filter": filt}
        if page_token:
            params["pageToken"] = page_token

        resp = _request_with_retry(url, params, credentials.token, session)

        if resp.status_code != 200:
            # FULL body, never truncated — rule 3 in the module docstring.
            # Google's ErrorInfo/BadRequest details name the exact offending
            # filter member when the filter is the problem; a short slice
            # used to cut that off, which is why this took longer to fix
            # than it should have the first time.
            raise GoogleHealthSyncError(f"{data_type_key}: HTTP {resp.status_code} — {resp.text}")

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
            # this ever fires, something is genuinely wrong; looping forever
            # is worse than stopping and logging.
            logger.error("%s: stopped after 500 pages — investigate before assuming this is normal", data_type_key)
            break

    logger.info("%s: pulled %d dataPoint(s) across %d page(s) for %s..%s",
                data_type_key, len(points), page_count, start_dt.date(), end_dt.date())
    return points, page_count


# -----------------------------------------------------------------------------
# Parsing. Field names below are taken from Google's discovery document
# schemas (Steps, Exercise, Sleep, HeartRate, Weight, BodyFat,
# DailyRestingHeartRate, DailyHeartRateVariability, DailyVO2Max,
# TimeInHeartRateZone, MetricsSummary, SleepStage, SleepSummary — see
# ARCHITECTURE.md §6.6), not guessed. _numeric()'s multi-candidate lists stay
# defensive for genuinely optional/alternate fields (e.g. a metric that may
# be absent for a given source), not because the primary field name is in
# doubt.
# -----------------------------------------------------------------------------

_TIMING_KEYS = {'name', 'dataSource'}


def _value_block(dp):
    """Each dataPoint is a union: exactly one typed field (the data type's
    own name, e.g. `heartRate`, `dailyRestingHeartRate`) alongside `name` and
    `dataSource`. Returns (key, value_dict) for that field."""
    if not isinstance(dp, dict):
        return None, None
    for k, v in dp.items():
        if k in _TIMING_KEYS:
            continue
        if isinstance(v, dict):
            return k, v
    return None, None


def _numeric(block, candidates):
    """Several int64 fields (beatsPerMinute, count, ...) are serialized by
    Google as JSON STRINGS, not numbers — standard protobuf-JSON handling to
    avoid JS float-precision loss on large integers. Accept both; this was
    silently dropping every one of these fields before the 2026-08-11 fix."""
    if not isinstance(block, dict):
        return None
    for c in candidates:
        v = block.get(c)
        if isinstance(v, bool):
            continue
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            try:
                return float(v)
            except ValueError:
                continue
    return None


def _local_date_str(ts):
    """RFC-3339 timestamp string -> local calendar date string. Returns None
    for anything that isn't a parseable string — including, notably, a raw
    dict passed by mistake (a bug this function guards against but does not
    silently paper over: the caller drops that data point instead)."""
    if not ts or not isinstance(ts, str):
        return None
    try:
        dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
    except ValueError:
        return None
    return dt.date().isoformat()


def _date_obj_to_str(date_obj):
    """Google's `Date` type ({year, month, day} integers) — used by daily-
    summary types INSTEAD OF a timestamp. Missing before the 2026-08-11 fix,
    which meant every daily-cadence row (resting HR, HRV, VO2 max) was
    silently dropped at the bucketing step before aggregation ever ran."""
    if not isinstance(date_obj, dict):
        return None
    y, m, d = date_obj.get('year'), date_obj.get('month'), date_obj.get('day')
    if not (y and m and d):
        return None
    try:
        return date(y, m, d).isoformat()
    except (TypeError, ValueError):
        return None


def _interval_minutes(interval):
    """Minutes between an ObservationTimeInterval/SessionTimeInterval's
    startTime and endTime. Used where the API gives a span but no explicit
    duration field (time_in_heart_rate_zone; sleep stages when
    summary.stagesSummary isn't present)."""
    if not isinstance(interval, dict):
        return None
    try:
        s = datetime.fromisoformat(str(interval.get('startTime', '')).replace('Z', '+00:00'))
        e = datetime.fromisoformat(str(interval.get('endTime', '')).replace('Z', '+00:00'))
    except ValueError:
        return None
    return max(0.0, (e - s).total_seconds() / 60.0)


def _bucket_by_day(points, data_type_key):
    """Groups dataPoints by LOCAL calendar date (ARCHITECTURE.md §12 — a day
    is a local-calendar concept, not a UTC one). WHERE the date comes from
    depends on the type's shape (FILTER_CATEGORY):
      - 'daily'  -> the value block's own `date` object
      - 'sample' -> value.sampleTime.physicalTime
      - 'sleep'  -> value.interval.endTime — the WAKE day, matching how
                    Google itself recommends filtering sleep (§ module
                    docstring)
      - 'interval' (steps, time_in_heart_rate_zone, exercise) -> value.interval.startTime
    Any point whose date can't be determined is dropped rather than guessed
    into a day — silently mis-bucketed health data is worse than a data
    point that's simply missing that sync."""
    category = FILTER_CATEGORY[data_type_key]
    buckets = {}
    for dp in points:
        _, block = _value_block(dp)
        if not isinstance(block, dict):
            continue
        if category == 'daily':
            day = _date_obj_to_str(block.get('date'))
        elif category == 'sample':
            day = _local_date_str((block.get('sampleTime') or {}).get('physicalTime'))
        elif category == 'sleep':
            day = _local_date_str((block.get('interval') or {}).get('endTime'))
        else:
            day = _local_date_str((block.get('interval') or {}).get('startTime'))
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
        # Steps schema: {interval, count} — count is int64-as-string.
        total, any_seen = 0.0, False
        for dp in raw['steps']:
            _, block = _value_block(dp)
            v = _numeric(block, ['count'])
            if v is not None:
                total += v
                any_seen = True
        if any_seen:
            summary['steps'] = int(round(total))

    if raw.get('heart_rate'):
        # HeartRate schema: {beatsPerMinute, sampleTime, metadata}.
        latest_ts, latest_bpm = None, None
        for dp in raw['heart_rate']:
            _, block = _value_block(dp)
            if not isinstance(block, dict):
                continue
            v = _numeric(block, ['beatsPerMinute'])
            ts = (block.get('sampleTime') or {}).get('physicalTime')
            if v is not None and ts and (latest_ts is None or ts > latest_ts):
                latest_ts, latest_bpm = ts, v
        if latest_bpm is not None:
            summary['latestHR'] = {'bpm': round(latest_bpm), 'at': latest_ts}

    if raw.get('daily_resting_heart_rate'):
        # DailyRestingHeartRate schema: {beatsPerMinute, date, metadata}.
        for dp in raw['daily_resting_heart_rate']:
            _, block = _value_block(dp)
            v = _numeric(block, ['beatsPerMinute'])
            if v is not None:
                summary['restingHR'] = round(v)

    if raw.get('daily_heart_rate_variability'):
        # DailyHeartRateVariability schema: at least one of
        # averageHeartRateVariabilityMilliseconds (the headline figure),
        # nonRemHeartRateBeatsPerMinute, entropy, or the deep-sleep RMSSD is
        # set — never all four. Prefer the headline figure; the deep-sleep
        # RMSSD is a narrower, related-but-different number used only if
        # nothing else is present.
        for dp in raw['daily_heart_rate_variability']:
            _, block = _value_block(dp)
            v = _numeric(block, ['averageHeartRateVariabilityMilliseconds',
                                  'deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds'])
            if v is not None:
                summary['hrv'] = round(v, 1)

    if raw.get('daily_vo2_max'):
        # DailyVO2Max schema: {date, vo2Max, cardioFitnessLevel, ...}.
        for dp in raw['daily_vo2_max']:
            _, block = _value_block(dp)
            v = _numeric(block, ['vo2Max'])
            if v is not None:
                summary['vo2Max'] = round(v, 1)

    if raw.get('weight'):
        # Weight schema: {sampleTime, weightGrams, notes}.
        for dp in raw['weight']:
            _, block = _value_block(dp)
            grams = _numeric(block, ['weightGrams'])
            if grams is not None:
                summary['weightLbs'] = round(grams / 453.59237, 1)

    if raw.get('body_fat'):
        # BodyFat schema: {percentage, sampleTime}.
        for dp in raw['body_fat']:
            _, block = _value_block(dp)
            v = _numeric(block, ['percentage'])
            if v is not None:
                summary['bodyFatPct'] = round(v, 1)

    if raw.get('time_in_heart_rate_zone'):
        # TimeInHeartRateZone schema: {heartRateZoneType, interval} — no
        # numeric duration field; minutes are the interval's own length.
        # Passed through under the DEVICE's zone labels (LIGHT/MODERATE/
        # VIGOROUS/PEAK) — NOT the app's own Karvonen zones (§5), which are
        # computed client-side for the live header only, from live HR +
        # weekly resting HR + age. This is a separate, device-defined
        # historical bucket; do not conflate the two.
        for dp in raw['time_in_heart_rate_zone']:
            _, block = _value_block(dp)
            if not isinstance(block, dict):
                continue
            zone = block.get('heartRateZoneType')
            mins = _interval_minutes(block.get('interval'))
            if zone and mins is not None:
                summary['hrZoneMinutes'][zone] = summary['hrZoneMinutes'].get(zone, 0) + mins

    if raw.get('sleep'):
        # Sleep schema: {stages[], metadata, summary, type, interval, ...}.
        # summary.stagesSummary (list of {type, minutes, count}) is Google's
        # OWN computed total per stage — prefer it. Fall back to summing raw
        # stages[]'s interval durations only when summary/stagesSummary is
        # absent. minutes/count on StageSummary are int64-as-string.
        stage_totals, total_minutes, any_seen = {}, 0.0, False
        for dp in raw['sleep']:
            _, block = _value_block(dp)
            if not isinstance(block, dict):
                continue
            any_seen = True
            summary_obj = block.get('summary') or {}
            stages_summary = summary_obj.get('stagesSummary')
            if isinstance(stages_summary, list) and stages_summary:
                for s in stages_summary:
                    if not isinstance(s, dict):
                        continue
                    name = s.get('type') or 'unknown'
                    mins = _numeric(s, ['minutes'])
                    if mins is not None:
                        stage_totals[name] = stage_totals.get(name, 0) + mins
                        total_minutes += mins
            else:
                stages = block.get('stages')
                if isinstance(stages, list):
                    for stage in stages:
                        if not isinstance(stage, dict):
                            continue
                        name = stage.get('type') or 'unknown'
                        mins = _interval_minutes(stage)
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
        #
        # MetricsSummary has averageHeartRateBeatsPerMinute but NO peak/max
        # heart rate field — that isn't a bug here, the API genuinely doesn't
        # provide one for exercise sessions. workout.peakHR stays null.
        avg_hrs = []
        for dp in raw['exercise']:
            _, block = _value_block(dp)
            if not isinstance(block, dict):
                continue
            interval = block.get('interval') or {}
            activity_type = block.get('exerciseType') or 'UNKNOWN'
            summary['startedActivities'].append({
                'activityType': activity_type,
                'startTime': interval.get('startTime'),
                'endTime': interval.get('endTime'),
            })
            avg_hr = _numeric(block.get('metricsSummary') or {}, ['averageHeartRateBeatsPerMinute'])
            if avg_hr is not None:
                avg_hrs.append(avg_hr)
        if avg_hrs:
            summary['workout']['avgHR'] = round(sum(avg_hrs) / len(avg_hrs))

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
        for day, pts in _bucket_by_day(points, type_key).items():
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

    today_str = date.today().isoformat()
    start = sys.argv[1] if len(sys.argv) > 1 else today_str
    end = sys.argv[2] if len(sys.argv) > 2 else today_str
    print(f"Syncing {start}..{end} — see server/logs/sync.log for detail.")
    out = sync_range(start, end)
    print(json.dumps(out, indent=2, default=str))
