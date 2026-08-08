// ---------------------------------------------------------------------------
// api.js — Calls to the local server. ALL fetch() lives here.
//
// ARCHITECTURE.md §3. This file is intentionally empty right now: the client
// currently makes no network calls at all, and server/ does not exist yet.
//
// It is committed empty on purpose. When Google Health sync, barcode lookup or
// food vision arrive, their fetch() calls belong HERE and nowhere else. Keeping
// the file present stops a future session from scattering fetch() through the
// page modules.
//
// When it is populated, remember:
//   - Client and server are same-origin over Tailscale (§2). No CORS shim.
//   - The server is a sidecar, not the database (§1.2). It returns small daily
//     summaries; localStorage stays the source of truth.
//   - Always follow nextPageToken (§6). A sync that ignores pagination returns
//     partial days that look complete.
// ---------------------------------------------------------------------------

export const API_BASE = '';
