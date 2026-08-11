# -----------------------------------------------------------------------------
# server/google_health_auth.py — ONE-TIME, BY-HAND consent flow.
# ARCHITECTURE.md §6.
#
# RUN THIS YOURSELF, FROM A NORMAL LOGGED-IN SESSION ON THE ALIENWARE:
#
#     server\.venv\Scripts\python.exe server\google_health_auth.py
#
# It opens a real browser, you sign in to Google and grant the three
# read-only scopes, and it writes the resulting refresh token to
# .metracker\google_refresh_token.json. That is the ONLY thing this script
# does — it does not sync anything.
#
# WHY THIS IS A SEPARATE FILE FROM google_health.py: the server
# (server/app.py, and google_health.py's sync_range()) runs unattended, at
# boot, as SYSTEM, with no desktop session and no browser to show a consent
# screen in. It must never attempt this flow itself — if the refresh token is
# missing or Google has expired it, google_health.py fails with a message
# pointing back at this script instead of hanging or crashing. Run this by
# hand whenever that happens; re-running it is exactly what ARCHITECTURE.md
# §6 calls "expected maintenance" for an app kept in Testing status (Google
# expires refresh tokens for unverified apps periodically — that is not a bug
# to fix by getting the app verified, it's the accepted tradeoff for skipping
# Google's review queue).
#
# Reuses test_fitbit.py's already-validated approach (InstalledAppFlow,
# run_local_server) rather than reinventing OAuth — the only change is where
# the result goes: a refresh token on disk for google_health.py to reuse,
# instead of a one-off access token printed to a terminal.
# -----------------------------------------------------------------------------

import json
import os
import sys
from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow

DEFAULT_SECRETS_DIR = Path.home() / '.metracker'
SECRETS_DIR = Path(os.environ.get('METRACKER_SECRETS_DIR', DEFAULT_SECRETS_DIR))
CLIENT_SECRET_FILE = SECRETS_DIR / 'client_secret.json'
REFRESH_TOKEN_FILE = SECRETS_DIR / 'google_refresh_token.json'

SCOPES = [
    'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
    'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
    'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
]


def main():
    if not CLIENT_SECRET_FILE.is_file():
        sys.exit(
            f"client_secret.json not found at: {CLIENT_SECRET_FILE}\n"
            "Put it there, or set METRACKER_SECRETS_DIR to the folder holding it."
        )

    print("Opening a browser for Google sign-in and consent...")
    print("Sign in with the Google account linked to your Fitbit data, and")
    print("grant the three requested read-only permissions.")

    flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRET_FILE), SCOPES)
    creds = flow.run_local_server(port=8080)

    if not creds.refresh_token:
        # Happens if Google decides this account already has a live grant and
        # skips issuing a fresh refresh token. Revoking the app's access in
        # https://myaccount.google.com/permissions and re-running this script
        # forces a fresh consent screen, which always issues one.
        sys.exit(
            "Google did not return a refresh token this time. Go to "
            "https://myaccount.google.com/permissions, remove Me-Tracker's "
            "access, and run this script again — that forces a fresh consent "
            "screen, which always issues a new refresh token."
        )

    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    REFRESH_TOKEN_FILE.write_text(json.dumps({"refresh_token": creds.refresh_token}))
    # Lock the file down to the current user where the OS supports it. Best
    # effort only — NTFS ACLs on Windows aren't chmod, and .metracker already
    # sits outside the repo and outside any web-served directory (§3).
    try:
        os.chmod(REFRESH_TOKEN_FILE, 0o600)
    except OSError:
        pass

    print(f"Done. Refresh token saved to {REFRESH_TOKEN_FILE}.")
    print("The server will pick it up automatically on the next sync — nothing else to run.")


if __name__ == "__main__":
    main()
