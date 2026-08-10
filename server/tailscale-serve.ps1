# -----------------------------------------------------------------------------
# server\tailscale-serve.ps1 — Expose the Me-Tracker server over the tailnet.
#
# ARCHITECTURE.md §2. Run this once (it persists across reboots — Tailscale
# stores the serve config itself, not this script). Safe to re-run any time;
# it just reasserts the same mapping.
#
# Uses `serve`, never `funnel`. Funnel exposes to the public internet, which
# defeats the entire point of running this over Tailscale. If you ever see
# this script (or anyone) suggest funnel, that is wrong — stop and ask.
#
# WHAT THIS DOES: proxies HTTPS on the tailnet (port 443, the default — no
# port number in the URL) to this machine's own 127.0.0.1:8123, where
# server/app.py is listening. Tailscale terminates TLS and issues the
# certificate; app.py never sees HTTPS directly and never needs to.
# -----------------------------------------------------------------------------

tailscale serve --bg 8123

Write-Host ""
Write-Host "Serve config:"
tailscale serve status

# -----------------------------------------------------------------------------
# TO UNDO: tailscale serve reset
#   Removes this mapping (and any other serve config on this machine).
#   Does not affect Tailscale itself or your other devices.
# -----------------------------------------------------------------------------
