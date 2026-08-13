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
              "quantity,nutriments")

# Me-Tracker's macro name -> OFF's nutriment base name. The suffix (_100g or
# _serving) is added at read time.
#
# CALORIES COME FROM energy-kcal, NEVER FROM energy. OFF's `energy` is
# kilojoules; using it would report a 210 kcal bar as 880.
NUTRIMENT_KEYS = {
    "protein": "proteins",
    "fat": "fat",
    "carbs": "carbohydrates",
    "sugar": "sugars",
    "fiber": "fiber",
    "calories": "energy-kcal",
}

# Sodium is handled separately — see _sodium_mg(). Every macro this module
# returns, in the order the client shows them.
MACRO_FIELDS = ("protein", "fat", "carbs", "sugar", "calories", "fiber", "sodium")

# Grams of salt per gram of sodium. Salt is sodium chloride; the standard
# label conversion is salt = sodium * 2.5, so sodium = salt / 2.5.
SALT_TO_SODIUM = 2.5


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
        basis = "converted"
        reported_serving_grams = _round(serving_grams)
    elif _has_per_serving(nutriments):
        # CASE 2 — OFF carries per-serving values directly. Use them as-is.
        # servingGrams stays null: knowing the macros of a serving is not the
        # same as knowing what it weighs, and inventing a weight is exactly
        # what this module refuses to do.
        macros, sodium_source = _macros(nutriments, "_serving")
        basis = "per_serving"
        reported_serving_grams = None
    else:
        # CASES 3 AND 4 — neither. THE NUMBERS BELOW ARE PER 100 g AND ARE NOT
        # CONVERTED. Case 3 is this with packageGrams present, case 4 is this
        # with it null; the client offers the two serving-size routes either
        # way and cannot save until one of them produces a number.
        macros, sodium_source = _macros(nutriments, "_100g")
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
            logger.info("barcode lookup: %s found as %s (%s) — basis %s, sodium from %s",
                        digits, code, matched_as, result["basis"], result["sodiumSource"])
            return result

    logger.info("barcode lookup: %s not found upstream (tried %s)", digits, ", ".join(tried))
    reason = ("Open Food Facts has no product with that barcode "
              f"(tried {' and '.join(tried)}). It is not in their database — "
              "type the label in by hand and the code will be kept with it.")
    return {"found": False, "barcode": digits, "reason": reason}
