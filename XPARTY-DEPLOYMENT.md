# Xparty deployment staging

This branch prepares the portal and room service; it is not a completed deployment.

Render: connect this repository, select branch `xparty/first-build-20260928`, root directory `xparty-service`, Node runtime, build `npm ci --omit=dev`, start `node server.mjs`, free instance, health path `/health`.

Set ALLOWED_ORIGINS to `https://pkx404.github.io`. Add the backend HTTPS origin if using its hosted frontend for testing. Use TRUST_PROXY=1 only with Render's trusted proxy.

After deployment, put the backend HTTPS URL into `xparty/config.js` before merging the portal to main. Configure a TURN relay via TURN_URLS and TURN_SECRET, and optionally YOUTUBE_API_KEY. Never commit secret values.

The free backend can sleep; expect slow initial joins and prototype-grade availability. Rooms are in memory and end on restart. No database or paid hosting resources are created by this branch.

Current validation: see xparty-service/VALIDATION.md. GitHub staging has now been completed; older validation notes describing missing GitHub access refer to the earlier build session. Physical device testing, actual YouTube streaming, Render deployment and TURN validation remain pending.
