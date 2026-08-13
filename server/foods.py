# -----------------------------------------------------------------------------
# server/foods.py — the food library. ARCHITECTURE.md §13.
#
# A persistent store of the items Ryan eats often, each carrying the macros
# printed on its package label. The Meal Tracker page (§13, client side) reads
# it, and every ADD there counts a serving of one of these items.
#
# ############ THE OWNERSHIP RULE — A DELIBERATE EXCEPTION TO §1.2 ############
#
# §1.2 says localStorage is the source of truth and the server is a sidecar
# that owns nothing. THIS MODULE IS THE ONE EXCEPTION, agreed with Ryan, and it
# is recorded as an exception rather than quietly softening the rule:
#
#   - THE SERVER OWNS THE FOOD LIBRARY. It is authoritative and it persists
#     indefinitely. A phone that loses its localStorage still has the library.
#   - The phone keeps a READ-ONLY MIRROR (d.foodLibrary) so the Meal Tracker
#     page opens instantly and still works with this server unreachable. The
#     mirror is a cache. It is never a second source of truth, and a client
#     must never queue writes into it while the server is down.
#   - THE DAILY COUNTS ARE NOT SERVER DATA. How many of an item Ryan ate today
#     lives in localStorage with everything else that feeds the score (§1.2),
#     and is never sent here. THERE IS NO COUNTS ENDPOINT AND MUST NOT BE ONE.
#
# Why the exception is safe: the library is a reference table, not a
# measurement. Losing it costs Ryan some retyping. Losing a day's counts would
# change his score, which is exactly what §1.2 exists to protect.
#
# ############ WHAT THIS MODULE MUST NOT DO ############
#
# NO SCORING. protein/fat/carbs/sugar are the four the client's Dietary score
# reads; calories, fiber and sodium are stored and displayed but never scored.
# Nothing here computes a score, and §11 protects the weights.
#
# NULL IS NOT ZERO (§1.7). A macro field may be null, meaning "not printed on
# the label". Zero means a measured zero. Never coerce one into the other.
# -----------------------------------------------------------------------------

import json
import os
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

# The library logs to sync.log, the log file the server already keeps, rather
# than opening a new one — a purge that silently removed something should show
# up in the same place a sync that silently never fired does (§2.3, §6.5).
from google_health import logger

DATA_DIR = Path(__file__).resolve().parent / "data"
FOODS_FILE = DATA_DIR / "foods.json"

# ---------------------------------------------------------------------------
# THE 120-DAY PURGE — a named constant, never a literal at the call site.
#
# An item Ryan has not eaten in four months is not part of the rotation any
# more. Purging is SAFE ONLY BECAUSE the client snapshots an item's macros into
# each day's count the first time it is added that day (§13, d.foodCounts), so
# a past day's numbers are computed from its own snapshot and never by looking
# the item up here. If that ever stops being true, this purge starts rewriting
# history and must be turned off first.
# ---------------------------------------------------------------------------
FOOD_PURGE_DAYS = 120

# The seven fields stored per item. The first four are what the client's
# Dietary score reads; the last three are stored and displayed only.
MACRO_FIELDS = ("protein", "fat", "carbs", "sugar", "calories", "fiber", "sodium")
SCORED_MACRO_FIELDS = ("protein", "fat", "carbs", "sugar")

# 'exact' is reserved for a future Open Food Facts barcode hit (§8) and is
# never emitted by this module — everything created here is hand-typed, which
# §8 tiers as 'high'.
ALLOWED_CONFIDENCE = ("high", "low")
DEFAULT_CONFIDENCE = "high"

# Serialises read-modify-write. The purge runs on a worker thread out of the
# nightly loop while request handlers run on FastAPI's threadpool; without this
# two of them could each read the file, each edit their own copy, and the
# second os.replace() would silently drop the first one's change.
_lock = threading.Lock()


class FoodNotFound(Exception):
    """No item with that id. app.py turns this into a 404."""


class FoodValidationError(Exception):
    """The submitted item is not usable. app.py turns this into a 400. The
    message is safe to show a user — it says what is wrong, nothing more."""


# ---------------------------------------------------------------------------
# Reading and writing the store
# ---------------------------------------------------------------------------

def _now_iso():
    """A UTC ISO instant. An instant, not a calendar day, so UTC is correct
    here — the same split util.js documents on the client (§12)."""
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(value):
    """A stored timestamp as an aware UTC datetime, or None if it is missing or
    unparseable. Returning None rather than raising is deliberate: the purge
    treats "I cannot read this timestamp" as a reason to KEEP an item, never as
    a reason to delete it."""
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def load_items():
    """Every stored item, oldest first by createdAt.

    A MISSING OR MALFORMED foods.json YIELDS AN EMPTY LIBRARY, NEVER AN ERROR.
    The Meal Tracker page must open on a server that has never had a food saved
    to it, and a file that cannot be parsed must not take the endpoint down —
    same reasoning as _load_daily_store() in google_health.py.
    """
    if not FOODS_FILE.is_file():
        return []
    try:
        raw = json.loads(FOODS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        logger.error("foods.json unreadable (%s) — serving an EMPTY library "
                     "rather than failing, and leaving the file untouched", e)
        return []
    items = raw.get("items") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        logger.error("foods.json has an unexpected shape — serving an EMPTY library")
        return []
    clean = [_normalise_stored(it) for it in items if isinstance(it, dict) and it.get("id")]
    clean.sort(key=lambda it: it.get("createdAt") or "")
    return clean


def _save_items(items):
    """ATOMIC WRITE. The new content goes to a temp file IN THE SAME DIRECTORY
    (so the replace is a same-filesystem rename, which is what makes it atomic)
    and os.replace() swaps it in. A crash, a power cut or a full disk mid-write
    leaves the PREVIOUS foods.json intact rather than a truncated one — the
    same pattern _save_daily_store() uses for vitals_daily.json."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = FOODS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"items": items}, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, FOODS_FILE)


def library_updated_at(items):
    """The newest updatedAt across the library, or None when it is empty. This
    is what GET /api/foods reports, so a client can tell at a glance whether
    its mirror is behind without diffing the whole list."""
    stamps = [it.get("updatedAt") for it in items if it.get("updatedAt")]
    return max(stamps) if stamps else None


def snapshot():
    """{items, updatedAt} — the envelope every endpoint returns."""
    items = load_items()
    return {"items": items, "updatedAt": library_updated_at(items)}


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _clean_text(value, field, required=False, limit=200):
    if value is None:
        value = ""
    if not isinstance(value, (str, int, float)):
        raise FoodValidationError(f"{field} must be text.")
    text = str(value).strip()
    if required and not text:
        raise FoodValidationError(f"{field} is required.")
    return text[:limit]


def _clean_macro(value, field):
    """A macro is a non-negative number, or None meaning NOT ON THE LABEL.

    Blank and missing both mean None. A value that is present but not a
    non-negative number is an error, not a silent None — quietly discarding a
    typo would store "no data" for something Ryan believes he entered."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        raise FoodValidationError(f"{field} must be a number, or left blank if it is not on the label.")
    if num != num or num in (float("inf"), float("-inf")):
        raise FoodValidationError(f"{field} must be a real number.")
    if num < 0:
        raise FoodValidationError(f"{field} cannot be negative.")
    return int(num) if float(num).is_integer() else round(num, 2)


def _clean_macros(payload):
    src = payload.get("macros")
    if src is None:
        src = {}
    if not isinstance(src, dict):
        raise FoodValidationError("macros must be an object.")
    return {f: _clean_macro(src.get(f), f) for f in MACRO_FIELDS}


def _clean_confidence(value):
    """Hand-typed items are 'high' (§8). 'exact' belongs to a future barcode
    lookup and is never emitted here, so anything unrecognised — including a
    client that sent 'exact' — is recorded as 'high' rather than accepted."""
    if isinstance(value, str) and value.strip().lower() in ALLOWED_CONFIDENCE:
        return value.strip().lower()
    return DEFAULT_CONFIDENCE


def _normalise_stored(item):
    """One stored record, with every field this module promises present. Fills
    gaps in an older or hand-edited file without rewriting it on disk."""
    macros = item.get("macros") if isinstance(item.get("macros"), dict) else {}
    return {
        "id": str(item.get("id")),
        "name": item.get("name") or "",
        "servingText": item.get("servingText") or "",
        "macros": {f: macros.get(f, None) for f in MACRO_FIELDS},
        "confidence": _clean_confidence(item.get("confidence")),
        "createdAt": item.get("createdAt"),
        "updatedAt": item.get("updatedAt"),
        "lastUsedAt": item.get("lastUsedAt", None),
    }


def new_id():
    return "fd_" + uuid.uuid4().hex[:12]


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

def create_item(payload):
    """Creates one item. THE SERVER GENERATES id, createdAt AND updatedAt — a
    client cannot set them, so two phones can never disagree about when an item
    was made. lastUsedAt starts null: created is not used."""
    if not isinstance(payload, dict):
        raise FoodValidationError("Expected an object.")
    name = _clean_text(payload.get("name"), "name", required=True)
    serving = _clean_text(payload.get("servingText"), "servingText")
    macros = _clean_macros(payload)
    confidence = _clean_confidence(payload.get("confidence"))
    now = _now_iso()
    item = {
        "id": new_id(),
        "name": name,
        "servingText": serving,
        "macros": macros,
        "confidence": confidence,
        "createdAt": now,
        "updatedAt": now,
        "lastUsedAt": None,
    }
    with _lock:
        items = load_items()
        items.append(item)
        _save_items(items)
    logger.info("food library: created %s (%s)", item["name"], item["id"])
    return item


def update_item(item_id, payload):
    """Replaces the editable fields of one item and BUMPS updatedAt ONLY.
    createdAt and lastUsedAt are carried through untouched — an edit is not a
    use, and it is certainly not a re-creation."""
    if not isinstance(payload, dict):
        raise FoodValidationError("Expected an object.")
    name = _clean_text(payload.get("name"), "name", required=True)
    serving = _clean_text(payload.get("servingText"), "servingText")
    macros = _clean_macros(payload)
    confidence = _clean_confidence(payload.get("confidence"))
    with _lock:
        items = load_items()
        for it in items:
            if it["id"] == item_id:
                it["name"] = name
                it["servingText"] = serving
                it["macros"] = macros
                it["confidence"] = confidence
                it["updatedAt"] = _now_iso()
                _save_items(items)
                logger.info("food library: updated %s (%s)", it["name"], it["id"])
                return it
    raise FoodNotFound(item_id)


def delete_item(item_id):
    with _lock:
        items = load_items()
        keep = [it for it in items if it["id"] != item_id]
        if len(keep) == len(items):
            raise FoodNotFound(item_id)
        gone = next(it for it in items if it["id"] == item_id)
        _save_items(keep)
    logger.info("food library: deleted %s (%s)", gone["name"], gone["id"])
    return gone


def mark_used(item_id):
    """Called on every ADD from the Meal Tracker page. Sets lastUsedAt and
    NOTHING ELSE — updatedAt describes the label, not the eating, and bumping
    it here would make every mirror look stale after lunch.

    THE CLIENT TREATS THIS AS FIRE-AND-FORGET. The count it just incremented is
    local data (§1.2) and has already succeeded; a failure here must never undo
    it. All this endpoint buys is a later purge date."""
    with _lock:
        items = load_items()
        for it in items:
            if it["id"] == item_id:
                it["lastUsedAt"] = _now_iso()
                _save_items(items)
                return it
    raise FoodNotFound(item_id)


# ---------------------------------------------------------------------------
# The 120-day purge
# ---------------------------------------------------------------------------

def _purge_reference(item):
    """Which timestamp decides an item's age: lastUsedAt when it has one,
    otherwise createdAt (a food saved and never eaten). Returns None when
    neither can be read, which KEEPS the item."""
    return _parse_iso(item.get("lastUsedAt")) or _parse_iso(item.get("createdAt"))


def select_stale(items, now=None, days=FOOD_PURGE_DAYS):
    """The items a purge would remove, without removing anything. Exposed
    separately so the selection can be tested against a spread of ages without
    touching the real file.

    STRICTLY OLDER THAN the cutoff. An item last used exactly `days` ago
    survives; one used a day earlier does not."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=days)
    stale = []
    for it in items:
        ref = _purge_reference(it)
        if ref is None:
            # Both timestamps unreadable. Keep it and say so — deleting on
            # ambiguity is how a silent data loss starts.
            logger.warning("food library: %s (%s) has no readable timestamp — keeping it",
                           it.get("name"), it.get("id"))
            continue
        if ref < cutoff:
            stale.append(it)
    return stale


def purge_stale(now=None, days=FOOD_PURGE_DAYS):
    """Deletes everything select_stale() picks and logs each removal BY NAME
    AND ID, so a deletion is never silent. Returns the removed items."""
    with _lock:
        items = load_items()
        stale = select_stale(items, now=now, days=days)
        if not stale:
            logger.info("food library purge: nothing older than %s days (%s item%s in library)",
                        days, len(items), "" if len(items) == 1 else "s")
            return []
        gone_ids = {it["id"] for it in stale}
        _save_items([it for it in items if it["id"] not in gone_ids])
    for it in stale:
        logger.info("food library purge: removed %s (%s) — last used %s, created %s",
                    it.get("name"), it.get("id"), it.get("lastUsedAt"), it.get("createdAt"))
    logger.info("food library purge: removed %s of %s item%s (older than %s days)",
                len(stale), len(items), "" if len(items) == 1 else "s", days)
    return stale
