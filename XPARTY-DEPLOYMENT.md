# Xparty live prototype

Live URL: https://pkx404-xparty.onrender.com (old /xparty/ links also work).

Render service srv-dasunt59fdbs73f6rg80 deploys branch xparty/first-build-20260928. Auto-deploy is disabled; trigger a deploy after updating the branch. Build: `npm ci --omit=dev --prefix xparty-service`; start: `node xparty-service/server.mjs`.

GitHub Pages integration is still staged in draft PR #1. Keep xparty/ frontend files synchronized with xparty-service/public/xparty/, preserving their different config.js backend settings.

No application room expiry. Rooms, credentials, votes and chat are in memory: Render restarts/deployments still clear them. A persistent datastore is required for restart-proof rooms. Uploaded videos use ephemeral server storage, capped at 250 MB each and 1 GB total; authenticated members download them automatically. No paid resources have been provisioned.

TURN is not configured, so some network combinations can still prevent calls. In-app search uses public YouTube results unless YOUTUBE_API_KEY is configured; public results are an unsupported fallback and may be blocked. Never commit keys.

See xparty-service/VALIDATION.md for current test evidence and physical-device checks still needed.
