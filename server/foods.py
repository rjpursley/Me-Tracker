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
import re
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

# §8's confidence tiers. 'exact' USED TO BE REJECTED HERE — §13.2 reserved it
# for "a future Open Food Facts hit", and that future arrived with §13.6. It is
# accepted now, but ONLY ON AN ITEM THAT CARRIES A BARCODE: a lookup is
# deterministic, a hand-typed panel is not, and without that tie any client
# could label a typed guess 'exact'. An 'exact' with no barcode is recorded as
# 'high', the same downgrade this module has always applied to a tier it does
# not believe.
ALLOWED_CONFIDENCE = ("high", "low")
BARCODE_CONFIDENCE = "exact"
DEFAULT_CONFIDENCE = "high"

# ---------------------------------------------------------------------------
# The barcode path's additive fields (§13.6, §13.7).
#
# ABSENCE IS THE BOUNDARY (§1.4). Every item created before this existed simply
# has none of these keys, and NOTHING BACKFILLS THEM — they are omitted from a
# stored record rather than written as nulls, so "hand-typed, before barcodes"
# stays distinguishable from "saved by the barcode path with nothing to report".
#
#   barcode        the CANONICAL code (§13.6), digits, or absent
#   basis          where the stored macros came from
#   servingGrams   grams in one serving
#   servingSource  'off'      OFF knew the serving (basis converted/per_serving)
#                  'label'    Ryan typed grams per serving off the panel
#                  'divided'  Ryan gave net weight and servings per container
#
# THE STORED MACROS ARE ALWAYS PER SERVING, in every case. `basis` records how
# that per-serving figure was arrived at, not what unit it is in.
# ---------------------------------------------------------------------------
BARCODE_FIELDS = ("barcode", "basis", "servingGrams", "servingSource")
ALLOWED_BASIS = ("converted", "per_serving", "per_100g")
ALLOWED_SERVING_SOURCE = ("off", "label", "divided")

# ---------------------------------------------------------------------------
# §13.8 — two more additive groups, and they behave differently.
#
# `extras`   six numeric fields in MILLIGRAMS, per serving. Auto-filled from a
#            lookup where OFF has them, TYPEABLE BY HAND otherwise (Ryan can
#            read caffeine off a can OFF has never heard of). They scale with
#            the serving exactly like macros.
#
# `flags`    descriptive, LOOKUP-ONLY, and NEVER SCALED. An additive is present
#            or it is not; half a serving does not contain half an E330.
#
# ############ flags ARE NEVER HAND-TYPED ############
#
# A hand-entered item has UNKNOWN additives, not zero additives. The client
# offers no way to type them, and this module will not record them on an item
# with no barcode — the same tie that governs 'exact' confidence, for the same
# reason: a lookup is evidence, a typed guess is not.
#
# ############ additives HAS TWO STATES THAT MUST NOT COLLAPSE ############
#
#   absent                            OFF has NO additives data. Unknown.
#   {count:0, tags:[], names:[]}      OFF positively reports NONE.
#
# Both occur in real data and they mean different things. Do not "tidy" the
# first into the second.
#
# NONE OF THIS IS SCORED (§11). Capture now, analyse later.
# ---------------------------------------------------------------------------
EXTRA_FIELDS = ("caffeine", "potassium", "calcium", "iron", "magnesium", "zinc")
CAPTURE_FIELDS = ("extras", "flags")
ALLOWED_NOVA = (1, 2, 3, 4)

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


def _clean_confidence(value, has_barcode=False):
    """Hand-typed items are 'high' (§8). 'exact' is accepted only alongside a
    barcode (§13.6) — the lookup is what makes it exact. Anything else
    unrecognised is recorded as 'high' rather than accepted."""
    v = value.strip().lower() if isinstance(value, str) else ""
    if v in ALLOWED_CONFIDENCE:
        return v
    if v == BARCODE_CONFIDENCE and has_barcode:
        return BARCODE_CONFIDENCE
    return DEFAULT_CONFIDENCE


def _clean_barcode(value):
    """The stored barcode: digits, whitespace and hyphens stripped, or None.

    Length is checked but the code is NOT re-derived here — barcode.py already
    canonicalised it (§13.6), and a second, subtly different normalisation in a
    second file is how two parts of one app start disagreeing about what the
    same product is called. 14 allows for an ITF-14 case code being typed."""
    if value is None:
        return None
    text = re.sub(r"[\s\-]", "", str(value))
    if not text:
        return None
    if not text.isdigit() or not (8 <= len(text) <= 14):
        raise FoodValidationError("barcode must be 8 to 14 digits.")
    return text


def _clean_choice(value, allowed, field):
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    v = str(value).strip().lower()
    if v not in allowed:
        raise FoodValidationError(f"{field} must be one of: {', '.join(allowed)}.")
    return v


def _clean_serving_grams(value):
    """Grams in one serving. STRICTLY POSITIVE — unlike a macro, 0 is not a
    measurement here, it is a serving that does not exist and would make every
    conversion meaningless."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        raise FoodValidationError("servingGrams must be a number.")
    if num != num or num in (float("inf"), float("-inf")) or num <= 0:
        raise FoodValidationError("servingGrams must be a number greater than zero.")
    return int(num) if float(num).is_integer() else round(num, 2)


def _clean_extras(payload):
    """The six `extras`, or None when not one of them is known.

    Reuses _clean_macro()'s rules exactly: blank and missing mean None, a
    present-but-unusable value is a 400 rather than a silent null, and a
    genuine 0 is kept as 0. An all-blank block is returned as None so the item
    simply has no `extras` key — absence stays the boundary."""
    src = payload.get("extras")
    if src is None:
        return None
    if not isinstance(src, dict):
        raise FoodValidationError("extras must be an object.")
    out = {f: _clean_macro(src.get(f), f) for f in EXTRA_FIELDS}
    return out if any(v is not None for v in out.values()) else None


def _clean_additives(src):
    """The additives block, preserving BOTH states (see the header above).

    `count` is always derived from the tags actually stored, never taken from
    the client — a count that disagreed with its own list would be worse than
    no count at all."""
    if src is None:
        return None                      # unknown — NOT "none present"
    if not isinstance(src, dict):
        raise FoodValidationError("flags.additives must be an object or null.")
    tags_src = src.get("tags")
    if not isinstance(tags_src, list):
        raise FoodValidationError("flags.additives.tags must be a list.")
    tags = []
    for t in tags_src:
        text = str(t).strip().lower() if t is not None else ""
        if text:
            # Strip OFF's language prefix if a client ever sends it unstripped.
            tags.append(text.split(":", 1)[1] if ":" in text else text)
    names_src = src.get("names") if isinstance(src.get("names"), list) else []
    names = []
    for i in range(len(tags)):
        raw = names_src[i] if i < len(names_src) else None
        text = str(raw).strip() if raw is not None else ""
        names.append(text or None)       # an unresolved name is null, not ''
    return {"count": len(tags), "tags": tags, "names": names}


def _clean_flags(payload, has_barcode):
    """The flags block, or None.

    RETURNS None WITHOUT A BARCODE, whatever was sent. Flags describe what a
    lookup found; an item typed by hand has unknown additives."""
    src = payload.get("flags")
    if src is None:
        return None
    if not isinstance(src, dict):
        raise FoodValidationError("flags must be an object.")
    if not has_barcode:
        return None
    nova = src.get("novaGroup")
    if nova is not None and (isinstance(nova, str) and not nova.strip()):
        nova = None
    if nova is not None:
        try:
            nova = int(float(nova))
        except (TypeError, ValueError):
            raise FoodValidationError("flags.novaGroup must be 1, 2, 3, 4 or null.")
        if nova not in ALLOWED_NOVA:
            raise FoodValidationError("flags.novaGroup must be 1, 2, 3, 4 or null.")
    additives = _clean_additives(src.get("additives"))
    if additives is None and nova is None:
        return None
    return {"additives": additives, "novaGroup": nova}


def _clean_capture_fields(payload, existing=None, has_barcode=False):
    """`extras` and `flags`, merged over what is already stored.

    Same "a key the payload does not MENTION is left alone" rule as the barcode
    fields — the plain Edit form sends no `flags`, and a PUT that wiped an
    item's additives because that form never heard of them would be exactly the
    silent data loss already fixed once for `barcode`."""
    merged = {k: (existing or {}).get(k) for k in CAPTURE_FIELDS}
    if "extras" in payload:
        merged["extras"] = _clean_extras(payload)
    if "flags" in payload:
        merged["flags"] = _clean_flags(payload, has_barcode)
    # Clearing the barcode clears the flags with it — they were only ever
    # admissible because a lookup produced them.
    if not has_barcode:
        merged["flags"] = None
    return {k: v for k, v in merged.items() if v is not None}


def _clean_barcode_fields(payload, existing=None):
    """The four additive fields, merged over whatever is already stored.

    A KEY THE PAYLOAD DOES NOT MENTION IS LEFT ALONE, rather than cleared. These
    are provenance, not label text: the Meal Tracker's plain Edit form knows
    nothing about them and posts a payload without them, and a PUT that dropped
    an item's barcode because the edit form never heard of it would be silent
    data loss. Same reasoning that carries createdAt through an update."""
    merged = {k: (existing or {}).get(k) for k in BARCODE_FIELDS}
    if "barcode" in payload:
        merged["barcode"] = _clean_barcode(payload.get("barcode"))
    if "basis" in payload:
        merged["basis"] = _clean_choice(payload.get("basis"), ALLOWED_BASIS, "basis")
    if "servingGrams" in payload:
        merged["servingGrams"] = _clean_serving_grams(payload.get("servingGrams"))
    if "servingSource" in payload:
        merged["servingSource"] = _clean_choice(
            payload.get("servingSource"), ALLOWED_SERVING_SOURCE, "servingSource")

    # THE ONE CROSS-FIELD RULE, enforced here as well as in the UI. A per-100g
    # candidate whose serving size is unknown has no per-serving macros to
    # store, so saving it would put per-100g numbers behind a counter that
    # counts servings (§8.0) — the exact silent inflation §13.6 exists to
    # prevent. The client also disables Save; that is the UI, this is the
    # guarantee (same split as §9.4's same-day lock).
    if merged["basis"] == "per_100g" and merged["servingGrams"] is None:
        raise FoodValidationError(
            "A per-100g item needs a serving size in grams before it can be saved.")

    return {k: v for k, v in merged.items() if v is not None}


def _normalise_stored(item):
    """One stored record, with every field this module promises present. Fills
    gaps in an older or hand-edited file without rewriting it on disk."""
    macros = item.get("macros") if isinstance(item.get("macros"), dict) else {}
    out = {
        "id": str(item.get("id")),
        "name": item.get("name") or "",
        "servingText": item.get("servingText") or "",
        "macros": {f: macros.get(f, None) for f in MACRO_FIELDS},
        "confidence": _clean_confidence(item.get("confidence"),
                                        has_barcode=bool(item.get("barcode"))),
        "createdAt": item.get("createdAt"),
        "updatedAt": item.get("updatedAt"),
        "lastUsedAt": item.get("lastUsedAt", None),
    }
    # ABSENT STAYS ABSENT. Unlike the fields above, these four are NOT filled in
    # with nulls — an item that predates the barcode path must keep reading as
    # one, and materialising `barcode: null` on every old record would be the
    # backfill §1.4 and §13.6 both rule out. Passed through unvalidated on
    # purpose: load_items() must never raise over a hand-edited file.
    for f in BARCODE_FIELDS + CAPTURE_FIELDS:
        if item.get(f) is not None:
            out[f] = item.get(f)
    return out


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
    extra = _clean_barcode_fields(payload)
    extra.update(_clean_capture_fields(payload, has_barcode=bool(extra.get("barcode"))))
    confidence = _clean_confidence(payload.get("confidence"),
                                   has_barcode=bool(extra.get("barcode")))
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
        **extra,
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
    with _lock:
        items = load_items()
        for it in items:
            if it["id"] == item_id:
                extra = _clean_barcode_fields(payload, existing=it)
                extra.update(_clean_capture_fields(
                    payload, existing=it, has_barcode=bool(extra.get("barcode"))))
                it["name"] = name
                it["servingText"] = serving
                it["macros"] = macros
                # Confidence follows the same "not mentioned means leave it
                # alone" rule as the four fields below. The Meal Tracker's Edit
                # form has never sent a confidence, so for a hand-typed item
                # this is identical to the old behaviour ('high' either way) —
                # but without it, fixing a typo in an Open Food Facts item's
                # name silently demoted it from 'exact' to 'high'. It is still
                # re-checked against the MERGED barcode, so clearing the
                # barcode still downgrades the tier.
                conf_src = payload["confidence"] if "confidence" in payload else it.get("confidence")
                it["confidence"] = _clean_confidence(
                    conf_src, has_barcode=bool(extra.get("barcode")))
                for f in BARCODE_FIELDS + CAPTURE_FIELDS:
                    # Set what survived the merge, and genuinely remove what did
                    # not, so a cleared field leaves no null behind.
                    if f in extra:
                        it[f] = extra[f]
                    else:
                        it.pop(f, None)
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
