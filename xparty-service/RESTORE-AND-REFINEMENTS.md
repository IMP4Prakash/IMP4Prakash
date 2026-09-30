# Xparty Best v0.9 restore point and focused v0.9.1 refinement

Preserved BEFORE edits: branch xparty/preserved-best-v0.9-20260930, commit b60c6e4d84893e5f4c7dc634ba071c715cbf22a2. This branch contains the complete existing project and must remain unchanged. To restore, deploy that branch on the existing Render services or fast-forward a new rollback commit using its tree; do not force-push the working history.

Only targeted UI changes: reference dedication, cookie icon/default preference choice, inline agreement link and icons, shared optional nickname and remembered skip choice, separate Friends/Messages navigation, add-friend entry, mobile notification room return, internal party mode buttons, automatic authenticated media previews, compact participant and call controls, edit/call icons, corner drag dots and inline browsing return. End-room action removed from the app UI; self-exit remains. Media sync/server behavior unchanged. Existing account provider remains disabled; persistent friendships/direct account messages need provider setup and are not represented as working guest features.

Validation: all 10 server tests; syntax, CSS and unique HTML IDs; refinements-ui and compact-ui at 320/390/844/1366px; real synthetic two-client WebRTC, mic stop/speaker and local-file delivery/refresh (0.001s local drift); simulated YouTube regression with injected 2s drift corrected to 0.014s. Physical device audio/network quality and real YouTube delivery remain unverified. Historical v8 tests are superseded by current suites.

Hostname: Render sign-in succeeded. Dashboard assigns xparty-twn6.onrender.com while service name is already xparty; no suffix edit control was exposed. Exact xparty.onrender.com is not assigned. No new hosting service or paid plan was created.
