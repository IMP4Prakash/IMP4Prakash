# Xparty live prototype

Live URL: https://pkx404-xparty.onrender.com (old /xparty/ links also work).

Render service srv-dasunt59fdbs73f6rg80 deploys branch xparty/first-build-20260928. Auto-deploy is disabled; trigger a deploy after updating the branch. Build: `npm ci --omit=dev --prefix xparty-service`; start: `node xparty-service/server.mjs`.

GitHub Pages integration is still staged in draft PR #1. Keep xparty/ frontend files synchronized with xparty-service/public/xparty/, preserving their different config.js backend settings.

No application room expiry. Rooms, credentials, votes and chat are in memory: Render restarts/deployments still clear them. A persistent datastore is required for restart-proof rooms. Uploaded videos use ephemeral server storage, capped at 250 MB each and 1 GB total; authenticated members download them automatically. No paid resources have been provisioned.

TURN is not configured, so some network combinations can still prevent calls. In-app search uses public YouTube results unless YOUTUBE_API_KEY is configured; public results are an unsupported fallback and may be blocked. Never commit keys.

See xparty-service/VALIDATION.md for current test evidence and physical-device checks still needed.


## Frontend split (revision 0.4)

Render static frontend `srv-dat8thk9v7es73b03980` serves the repository's `xparty/` directory, same feature branch, auto-deploy off. URL assigned by Render: https://xparty-wsev.onrender.com . Requested exact xparty.onrender.com was not assigned. Backend `ALLOWED_ORIGINS` now includes this alternate frontend and both previous origins. Deploy both services after frontend changes. Static build: `test -f xparty/index.html`; publish: `xparty`; no dependency install.

Optional account setup is in xparty-service/accounts/SETUP.md. No Supabase/SMS/Google credentials were available or configured by this revision.


Revision 0.5 keeps the proven playback timing intact and updates call audio/UI. New room codes have seven characters; eight-character codes remain accepted. Both frontend copies must deploy together. Rooms held only in memory clear when the backend restarts. No hostname, paid resource, or account provider was changed in this revision.

### 0.6 — party controls and recovery

Includes Host Approval / Host Only / Shared Control, approval policies, 120-second reserved seats and host reconnect grace, persistent same-browser rejoin, optional nickname, storage consent, and a resizable focused-call layout with in-app movie PiP. Existing sync correction is preserved. Architecture/roadmap: `xparty-service/docs/PARTY-ARCHITECTURE.md`.

Both existing Render services track `xparty/first-build-20260928` with auto deploy off. Publish backend and static frontend manually after the same commit is pushed. The static site's config continues to point to the existing backend. The exact `xparty.onrender.com` hostname has NOT been assigned; the static service currently has `xparty-wsev.onrender.com`. Do not treat renaming a service label as proof its URL changed, or select another random suffix.

No persistent database, paid plan, TURN server, OTP provider or Kubernetes deployment is provisioned by this release. A backend restart still clears in-memory rooms on the current hosting setup. Do not merge the main-site draft PR without the owner's approval.
