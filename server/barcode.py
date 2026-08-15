# -----------------------------------------------------------------------------
# server/barcode.py — Open Food Facts lookup. ARCHITECTURE.md §8, §13.6.
#
# ONE JOB: turn typed barcode digits into a CANDIDATE for Ryan to review. It
# does NOT create a library item. The client shows what came back, Ryan checks
# it against the package in his hand, and only then does the existing
# POST /api/foods create anything (§13.1).
#
# ############ TYPED DIGITS ONLY ############
#
# There is NO camera here, no live scanning, and no image decoding. In
# particular A VISION MODEL MUST NEVER BE USED TO READ A BARCODE. One misread
# digit does not fail — it returns a DIFFERENT PRODUCT'S macros, with full
# confidence, and nothing downstream can tell. Deterministic lookup or nothing
# (§8: barcode -> label OCR -> plate estimate, in that order, never blurred).
#
# ############ THE SERVING-SIZE PROBLEM IS THE WHOLE FEATURE ############
#
# Open Food Facts reports nutriments PER 100 g, and only sometimes ALSO per
# serving. The Meal Tracker counter counts SERVINGS. Getting that wrong does not
# look like a bug — it silently inflates or deflates every macro Ryan eats.
#
# So this module NEVER GUESSES A SERVING SIZE. It never assumes 100 g is a
# serving, and it never returns per-100 g figures while calling them
# per-serving. It reports what OFF has, what OFF lacks, and which of four cases
# applies via `basis`; deciding what to do about a missing serving size is the
# client's job, with Ryan in the loop.
#
#   basis "converted"   serving_quantity (grams/serving) was present, so
#                       per-serving = per100g * serving_quantity / 100
#   basis "per_serving" OFF carried *_serving values directly; used as-is
#   basis "per_100g"    neither. THE NUMBERS ARE PER 100 g AND UNCONVERTED.
#                       packageGrams is filled in when OFF knows the net weight
#                       so the client can offer servings-per-container.
#
# NULL IS NOT ZERO (§1.7). A nutriment absent upstream comes back null. An OFF
# entry with half its panel missing is common and must come back half-null —
# never zero-filled, because zero is a measurement.
#
# NOTHING IS CACHED TO DISK. This module reads no file and writes no file.
# -----------------------------------------------------------------------------

import re

import requests

# The library logs to sync.log, the log file the server already keeps, for the
# same reason foods.py does — one place to look when something went quiet.
from google_health import logger

# Open Food Facts, read-only, public. NO API KEY, NO AUTH, NO SECRETS — nothing
# in this module touches .metracker/ and nothing here needs to.
OFF_PRODUCT_URL = "https://world.openfoodfacts.org/api/v2/product/{code}.json"

# OFF's stated policy asks every caller to identify itself with a descriptive
# User-Agent; generic ones get blocked. App, version, and where it lives.
# DELIBERATELY NO PERSONAL CONTACT DETAILS — this string is sent to a third
# party on every lookup, and the repo URL identifies the app without publishing
# Ryan's email to anyone who reads OFF's request logs.
USER_AGENT = ("Me-Tracker/1.0 (self-hosted personal food tracker; "
              "https://github.com/rjpursley/Me-Tracker)")

# Eight seconds. Ryan is standing in a kitchen holding a box; a lookup that
# hangs longer than that has failed as far as he is concerned, and a clear
# failure he can act on beats a spinner (§1.7).
TIMEOUT_SECONDS = 8

# Only these lengths are real retail barcodes. Anything else is a typo and is
# rejected WITHOUT calling upstream — there is no point spending a network
# round trip to be told a 9-digit number is not a product.
VALID_LENGTHS = (8, 12, 13)

# Only the fields this module actually reads. OFF asks callers to use `fields`
# so their servers do not ship a 100 KB product record to answer a question
# about seven numbers.
OFF_FIELDS = ("code,product_name,product_name_en,brands,serving_size,"
              "serving_quantity,serving_quantity_unit,product_quantity,"
              "quantity,nutriments,"
              # §13.8's flags. additives_n is fetched as a cross-check on the
              # tag list, not as the reported count.
              "additives_tags,additives_original_tags,additives_n,nova_group")

# OFF's taxonomy endpoint, which is the ONLY place human additive names come
# from — the product record carries bare codes like "en:e330" and nothing else.
# Measured, not assumed (2026-08-13).
OFF_TAXONOMY_URL = "https://world.openfoodfacts.org/api/v2/taxonomy"

# Me-Tracker's macro name -> OFF's nutriment base name. The suffix (_100g or
# _serving) is added at read time.
#
# CALORIES COME FROM energy-kcal, NEVER FROM energy. OFF's `energy` is
# kilojoules; using it would report a 210 kcal bar as 880.
NUTRIMENT_KEYS = {
    "protein": "proteins",
    "fat": "fat",
    # OFF spells it with a hyphen, so the read key is `saturated-fat_100g` /
    # `saturated-fat_serving`. Added 2026-08-14 (§14.1). It goes through
    # _macros() with every other macro and is therefore scaled by the SAME
    # `factor` §13.6's four cases already compute — there is deliberately no
    # second conversion path for it.
    "saturatedFat": "saturated-fat",
    "carbs": "carbohydrates",
    "sugar": "sugars",
    "fiber": "fiber",
    "calories": "energy-kcal",
}

# Sodium is handled separately — see _sodium_mg(). Every macro this module
# returns, in the order the client shows them.
MACRO_FIELDS = ("protein", "fat", "saturatedFat", "carbs", "sugar",
                "calories", "fiber", "sodium")

# Grams of salt per gram of sodium. Salt is sodium chloride; the standard
# label conversion is salt = sodium * 2.5, so sodium = salt / 2.5.
SALT_TO_SODIUM = 2.5

# ---------------------------------------------------------------------------
# GROUP A — `extras` (ARCHITECTURE.md §13.8). Six numeric fields, PER SERVING,
# reported in MILLIGRAMS.
#
# THEY CONVERT BY EXACTLY THE SAME SERVING-SIZE LOGIC AS THE MACROS. There is no
# special case for them anywhere: the same `factor` §13.6's four cases compute
# for macros is applied here. If that ever diverges, one of the two is wrong.
#
# UNITS, MEASURED NOT ASSUMED (2026-08-13): OFF normalises all six into GRAMS in
# the base nutriments object, and says so in a `<field>_unit` key. Across 800
# real products every single occurrence of all six read "g" — not one exception.
# Grams to milligrams is therefore a flat x1000, the same conversion sodium
# already makes. A value arriving in any OTHER unit returns null rather than a
# guessed conversion: a 1000x error in a caffeine figure is worse than a blank.
#
# NULL IS NOT ZERO (§1.7), exactly as for macros. Coverage is genuinely poor for
# most of these — see §13.8's measured fill rates — and a blank must read as
# "OFF does not know", never as "this product contains none".
# ---------------------------------------------------------------------------
EXTRA_FIELDS = ("caffeine", "potassium", "calcium", "iron", "magnesium", "zinc")

# Me-Tracker's field name -> OFF's nutriment base name. Identical today, but
# kept explicit so a future rename cannot silently mis-map one.
EXTRA_KEYS = {f: f for f in EXTRA_FIELDS}

EXTRA_SOURCE_UNIT = "g"
GRAMS_TO_MG = 1000.0

# ---------------------------------------------------------------------------
# GROUP B — `flags` (§13.8). Descriptive, lookup-only.
#
# FLAGS DO NOT SCALE WITH SERVING SIZE. An additive is present or it is not;
# half a serving does not contain half an E330. Nothing here is multiplied by
# anything, and a future session must not "fix" that.
#
# FLAGS ARE NEVER HAND-TYPED. A hand-entered item has UNKNOWN additives, not
# zero additives, so the client offers no way to enter them.
# ---------------------------------------------------------------------------
NOVA_GROUPS = (1, 2, 3, 4)

# code -> human name, for this process only. NOT WRITTEN TO DISK — §13.6's "no
# upstream response is cached to disk" still holds. Additive names are static
# reference data, so re-asking OFF for "en:e330" on every lookup would be pure
# waste; a bounded in-memory map is the cheapest honest answer.
_additive_name_cache = {}
_ADDITIVE_CACHE_MAX = 2000


class BarcodeFormatError(Exception):
    """The typed digits are not a barcode. app.py turns this into a 400. The
    message is safe to show Ryan — it says what is wrong and nothing more."""


class UpstreamError(Exception):
    """Open Food Facts could not be reached, timed out, or answered with
    something unusable. app.py turns this into a 502. NEVER a partial product:
    a lookup that failed must read as failed (§1.7)."""


# ---------------------------------------------------------------------------
# Normalisation — load-bearing
# ---------------------------------------------------------------------------

def normalise(raw):
    """The typed code as bare digits.

    Whitespace and hyphens are stripped (people read barcodes off a package in
    groups, and phone keyboards add spaces). ANYTHING ELSE LEFT OVER IS A TYPO
    and raises — silently discarding a stray character could turn one product's
    code into another's."""
    text = re.sub(r"[\s\-]", "", str(raw or ""))
    if not text:
        raise BarcodeFormatError("Type the barcode digits.")
    if not text.isdigit():
        raise BarcodeFormatError("A barcode is digits only — remove anything else and try again.")
    if len(text) not in VALID_LENGTHS:
        raise BarcodeFormatError(
            f"That is {len(text)} digits. A barcode is 8, 12 or 13 digits — check for a "
            "missed or doubled number.")
    return text


def candidate_forms(digits):
    """Every form worth asking OFF about, in the order to try them.

    THE 12-DIGIT PAD IS THE WHOLE REASON THIS FUNCTION EXISTS. Open Food Facts
    keys on 13 digits (EAN-13). A US UPC-A is 12, and the 13-digit form of it is
    the same number with a leading zero — so US products routinely come back
    "not found" for their printed 12 digits and are found immediately once
    padded. Both are tried, and the response reports which one actually hit."""
    if len(digits) == 13:
        return [(digits, "ean13")]
    if len(digits) == 12:
        return [(digits, "upc12"), ("0" + digits, "ean13-padded")]
    if len(digits) == 8:
        return [(digits, "ean8")]
    raise BarcodeFormatError("A barcode is 8, 12 or 13 digits.")


# ---------------------------------------------------------------------------
# Reading OFF's numbers — every absence stays an absence
# ---------------------------------------------------------------------------

def _num(value):
    """A finite, non-negative number, or None.

    None means NOT REPORTED. Missing, blank, unparseable and negative all come
    back None rather than 0 (§1.7) — an OFF entry with half its panel missing
    must read as half-missing, and zero would be a claim the label never made.
    OFF returns some numerics as JSON strings, which is why this is not a plain
    float() call."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if num != num or num in (float("inf"), float("-inf")) or num < 0:
        return None
    return num


def _round(value, places=2):
    """A tidy number for display, or None. Kept as an int when it is one, so a
    review card shows `12` rather than `12.0`."""
    if value is None:
        return None
    r = round(value, places)
    return int(r) if float(r).is_integer() else r


def _text(value):
    """A trimmed string, or None. Empty upstream text is an absence, not ''."""
    if value is None:
        return None
    s = str(value).strip()
    return s or None


def _sodium_mg(nutriments, suffix):
    """(sodium in mg, which source it came from) — or (None, None).

    OFF usually carries SALT in grams rather than sodium, so a product whose
    label prints sodium may have none of it under that name. Sodium is used
    directly when present; otherwise it is derived from salt. WHICH ONE WAS
    USED IS REPORTED, because a derived figure is arithmetic on a label value,
    not a label value.

    Both OFF fields are in GRAMS; the app stores sodium in MILLIGRAMS."""
    grams = _num(nutriments.get("sodium" + suffix))
    if grams is not None:
        return grams * 1000.0, "sodium"
    salt = _num(nutriments.get("salt" + suffix))
    if salt is not None:
        return (salt / SALT_TO_SODIUM) * 1000.0, "salt"
    return None, None


def _macros(nutriments, suffix, factor=1.0):
    """The seven macros at one suffix, optionally scaled.

    `factor` is how case 1 converts: per100g * serving_quantity / 100. A field
    OFF does not carry stays None and is NEVER scaled into a 0."""
    out = {}
    for field, key in NUTRIMENT_KEYS.items():
        value = _num(nutriments.get(key + suffix))
        out[field] = _round(value * factor) if value is not None else None
    mg, source = _sodium_mg(nutriments, suffix)
    out["sodium"] = _round(mg * factor, 1) if mg is not None else None
    return out, source


def _extras(nutriments, suffix, factor=1.0):
    """The six `extras` at one suffix, scaled by the SAME factor as the macros.

    Grams in, milligrams out. A field OFF does not carry stays None and is never
    scaled into a 0; a field in an unexpected unit ALSO returns None, because a
    guessed conversion here is a 1000x error in a number Ryan would believe."""
    out = {}
    for field, key in EXTRA_KEYS.items():
        raw = _num(nutriments.get(key + suffix))
        if raw is None:
            out[field] = None
            continue
        # `<field>_unit` has no _100g/_serving suffix — it describes the
        # nutrient, not one reading of it. Absent is not "unexpected": the
        # _100g/_serving values are OFF's own normalised grams either way.
        unit = nutriments.get(key + "_unit")
        if unit is not None and str(unit).strip().lower() != EXTRA_SOURCE_UNIT:
            out[field] = None
            continue
        out[field] = _round(raw * GRAMS_TO_MG * factor, 2)
    return out


def _strip_lang(tag):
    """`en:e129` -> `e129`. OFF prefixes every tag with a language code; the
    prefix is about the taxonomy, not about the additive."""
    text = _text(tag)
    if text is None:
        return None
    return text.split(":", 1)[1].strip().lower() if ":" in text else text.strip().lower()


def _additives(product):
    """The additives block, or None.

    ############ TWO STATES THAT MUST NOT COLLAPSE ############

        None                              OFF HAS NO ADDITIVES DATA for this
                                          product. Unknown.
        {count: 0, tags: [], names: []}   OFF POSITIVELY REPORTS NONE.

    Those are different facts and the difference is the whole reason this
    returns None rather than an empty block. Both occur in real data: a Quest
    bar has `additives_tags: null`, Nutella has `additives_tags: []`.

    `additives_original_tags` is preferred over `additives_tags` because it is
    what OFF actually detected. `additives_tags` additionally carries broader
    parent tags — Red Bull US lists e500 AND e500ii for one additive — which
    would inflate the count. Measured: original_tags matches OFF's own
    `additives_n`, the expanded list does not."""
    tags = product.get("additives_original_tags")
    if not isinstance(tags, list):
        tags = product.get("additives_tags")
    if not isinstance(tags, list):
        return None                      # NO DATA — not "none present"
    clean = [t for t in (_strip_lang(x) for x in tags) if t]
    return {
        "count": len(clean),
        "tags": clean,
        # Filled in by _fill_additive_names() over the taxonomy endpoint. Left
        # as None here so _build() stays pure and offline.
        "names": [_additive_name_cache.get(t) for t in clean],
    }


def _nova(product):
    """1-4, or None. A string "4" is accepted — OFF carries both shapes."""
    value = _num(product.get("nova_group"))
    if value is None:
        return None
    group = int(value)
    return group if group in NOVA_GROUPS else None


def _fill_additive_names(result, session=None):
    """Resolve additive codes to human names over OFF's taxonomy endpoint.

    NAMES ARE A CONVENIENCE, NOT THE FACT. The codes are what was looked up; a
    taxonomy call that fails, times out or returns nothing leaves names null and
    NEVER fails the lookup or touches anything else. One call per lookup
    (the endpoint takes a comma-separated list), only when there are additives,
    and only for codes not already in memory."""
    flags = result.get("flags") or {}
    additives = flags.get("additives")
    if not additives or not additives.get("tags"):
        return
    unknown = [t for t in additives["tags"] if t not in _additive_name_cache]
    if unknown:
        try:
            getter = session.get if session is not None else requests.get
            res = getter(OFF_TAXONOMY_URL,
                         headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
                         params={"tagtype": "additives",
                                 "tags": ",".join("en:" + t for t in unknown),
                                 "lc": "en"},
                         timeout=TIMEOUT_SECONDS)
            body = res.json() if res.status_code == 200 else {}
            if isinstance(body, dict):
                for code, entry in body.items():
                    name = None
                    if isinstance(entry, dict) and isinstance(entry.get("name"), dict):
                        name = _text(entry["name"].get("en"))
                    if len(_additive_name_cache) < _ADDITIVE_CACHE_MAX:
                        _additive_name_cache[_strip_lang(code)] = name
        except (requests.RequestException, ValueError) as e:
            # Names stay null. This is not worth failing a lookup over.
            logger.info("additive name lookup failed (%s) — codes kept, names left blank",
                        type(e).__name__)
    additives["names"] = [_additive_name_cache.get(t) for t in additives["tags"]]


def _has_per_serving(nutriments):
    """Does OFF carry any *_serving nutriment for this product? Case 2 hinges
    on it. Salt and sodium count — a product may print only those."""
    keys = list(NUTRIMENT_KEYS.values()) + ["sodium", "salt"]
    return any(_num(nutriments.get(k + "_serving")) is not None for k in keys)


# ---------------------------------------------------------------------------
# The upstream call
# ---------------------------------------------------------------------------

def _fetch(code, session=None):
    """OFF's product record for exactly this code, or None if OFF does not have
    it. Raises UpstreamError for anything that is not a clean answer either way.

    A 404 IS A NORMAL ANSWER, NOT A FAILURE — API v2 uses it for "no such
    product", which is the single most common outcome of a real lookup."""
    url = OFF_PRODUCT_URL.format(code=code)
    getter = session.get if session is not None else requests.get
    try:
        res = getter(url,
                     headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
                     params={"fields": OFF_FIELDS},
                     timeout=TIMEOUT_SECONDS)
    except requests.Timeout:
        raise UpstreamError("Open Food Facts did not answer within 8 seconds. "
                            "Nothing was looked up — try again, or type the label in by hand.")
    except requests.RequestException as e:
        raise UpstreamError("Could not reach Open Food Facts (%s). Nothing was looked up — "
                            "try again, or type the label in by hand." % type(e).__name__)

    if res.status_code == 404:
        return None
    if res.status_code == 429:
        # Observed live against production: OFF rate-limits, and a burst of
        # lookups can hit it. Said plainly, because "wait a moment" is
        # actionable in a way "HTTP 429" is not. STILL AN ERROR, NOT A MISS —
        # falling through to "not found" here would tell Ryan the product does
        # not exist when all that happened is he scanned too fast.
        raise UpstreamError("Open Food Facts is asking for fewer requests right now. "
                            "Wait a few seconds and look it up again — nothing was saved.")
    if res.status_code != 200:
        raise UpstreamError("Open Food Facts answered with an error (HTTP %s). Nothing was "
                            "looked up — try again, or type the label in by hand." % res.status_code)
    try:
        payload = res.json()
    except ValueError:
        raise UpstreamError("Open Food Facts sent something this app could not read. "
                            "Nothing was looked up — type the label in by hand.")
    if not isinstance(payload, dict):
        raise UpstreamError("Open Food Facts sent something this app could not read. "
                            "Nothing was looked up — type the label in by hand.")
    # status 1 = found. status 0 with a 200 happens too, so both are checked.
    product = payload.get("product")
    if payload.get("status") != 1 or not isinstance(product, dict):
        return None
    return product


# ---------------------------------------------------------------------------
# Building the candidate
# ---------------------------------------------------------------------------

def _canonical_code(requested, product):
    """The code to REPORT and store, which is not always the code we asked with.

    MEASURED, NOT ASSUMED (2026-08-13): Open Food Facts stores US products under
    their 13-digit EAN form and answers a 12-digit UPC-A request with the
    canonical 13-digit `code` — asking for 857777004096 returns
    code 0857777004096. Storing the 12 typed digits would mean the same product
    looked up later in its 13-digit form did not match the item already in the
    library, which is exactly the duplicate the client's guard exists to catch.

    ONLY ADOPTED WHEN IT IS THE SAME NUMBER. An int comparison makes leading
    zeros irrelevant while still refusing a code that is genuinely different —
    if OFF ever answered with some other product's code, that is not something
    to silently accept."""
    reported = _text(product.get("code"))
    if reported and reported.isdigit():
        try:
            if int(reported) == int(requested):
                return reported
        except ValueError:
            pass
    return requested


def _build(code, matched_as, product):
    """One reviewable candidate. THE FOUR CASES LIVE HERE, and the response
    always says which one applied."""
    nutriments = product.get("nutriments")
    if not isinstance(nutriments, dict):
        nutriments = {}

    # Grams in one serving, per OFF. <= 0 is not a serving size; treat it as
    # absent rather than dividing by it.
    serving_grams = _num(product.get("serving_quantity"))
    if serving_grams is not None and serving_grams <= 0:
        serving_grams = None

    # Net grams in the package. Reported whenever OFF has it — it is a fact
    # about the product — but it is only ACTED on in the per_100g case, where
    # it saves Ryan re-typing the net weight for servings-per-container.
    package_grams = _num(product.get("product_quantity"))
    if package_grams is not None and package_grams <= 0:
        package_grams = None

    if serving_grams is not None:
        # CASE 1 — grams per serving known. Convert from per-100 g.
        macros, sodium_source = _macros(nutriments, "_100g", serving_grams / 100.0)
        extras = _extras(nutriments, "_100g", serving_grams / 100.0)
        basis = "converted"
        reported_serving_grams = _round(serving_grams)
    elif _has_per_serving(nutriments):
        # CASE 2 — OFF carries per-serving values directly. Use them as-is.
        # servingGrams stays null: knowing the macros of a serving is not the
        # same as knowing what it weighs, and inventing a weight is exactly
        # what this module refuses to do.
        macros, sodium_source = _macros(nutriments, "_serving")
        extras = _extras(nutriments, "_serving")
        basis = "per_serving"
        reported_serving_grams = None
    else:
        # CASES 3 AND 4 — neither. THE NUMBERS BELOW ARE PER 100 g AND ARE NOT
        # CONVERTED. Case 3 is this with packageGrams present, case 4 is this
        # with it null; the client offers the two serving-size routes either
        # way and cannot save until one of them produces a number.
        macros, sodium_source = _macros(nutriments, "_100g")
        extras = _extras(nutriments, "_100g")
        basis = "per_100g"
        reported_serving_grams = None

    name = _text(product.get("product_name")) or _text(product.get("product_name_en"))
    brands = _text(product.get("brands"))
    brand = _text(brands.split(",")[0]) if brands else None

    return {
        "found": True,
        # The canonical code, which may be the 13-digit form of a 12-digit
        # request. `matchedAs` still reports the form actually asked with.
        "barcode": _canonical_code(code, product),
        "matchedAs": matched_as,
        "name": name,
        "brand": brand,
        "servingText": _text(product.get("serving_size")),
        "servingGrams": reported_serving_grams,
        "packageGrams": _round(package_grams),
        "basis": basis,
        "macros": {f: macros.get(f) for f in MACRO_FIELDS},
        "sodiumSource": sodium_source,
        # §13.8. `extras` scales with the serving exactly like macros; `flags`
        # never scales at all.
        "extras": {f: extras.get(f) for f in EXTRA_FIELDS},
        "flags": {"additives": _additives(product), "novaGroup": _nova(product)},
    }


def lookup(raw_code, session=None):
    """The whole feature. Typed digits in, a reviewable candidate out.

    Returns {"found": False, ...} — NOT an error — when OFF simply does not
    have the product. That is a normal, frequent outcome and the client turns
    it straight into a manual entry with the barcode kept.

    Raises BarcodeFormatError (a typo) or UpstreamError (OFF unreachable,
    timed out, or broken). NEVER RETURNS A PARTIAL OR FABRICATED PRODUCT."""
    digits = normalise(raw_code)
    tried = []
    for code, matched_as in candidate_forms(digits):
        tried.append(code)
        product = _fetch(code, session=session)
        if product is not None:
            result = _build(code, matched_as, product)
            # Names only. A failure here leaves them null and changes nothing
            # else — the codes are the fact.
            _fill_additive_names(result, session=session)
            add = result["flags"]["additives"]
            logger.info("barcode lookup: %s found as %s (%s) — basis %s, sodium from %s, "
                        "additives %s, nova %s",
                        digits, code, matched_as, result["basis"], result["sodiumSource"],
                        "unknown" if add is None else add["count"],
                        result["flags"]["novaGroup"])
            return result

    logger.info("barcode lookup: %s not found upstream (tried %s)", digits, ", ".join(tried))
    reason = ("Open Food Facts has no product with that barcode "
              f"(tried {' and '.join(tried)}). It is not in their database — "
              "type the label in by hand and the code will be kept with it.")
    return {"found": False, "barcode": digits, "reason": reason}
