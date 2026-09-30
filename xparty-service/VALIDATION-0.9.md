# Xparty 0.9 validation — 30 September 2026

Implemented complete Home entry while in a room, successful-entry room switching, automatic two-seat creation, compact participant/policy and room menus, five collapsible settings sections, auto-hidden player controls, movable/resizable focus PiP, portrait calls with self bottom-left, adjustable conversation area, compact search and Auto/Votes queue, chat approval icons, matched volume sliders, refined branding, removal of reaction UI, and authenticated photo/GIF/video/file attachments.

Validation: npm test (10 tests, all passed), npm run check, HTML unique IDs and CSS parsing; compact-ui.cjs at 320/390/844/1366px in three layouts; browser.cjs actual two-browser WebRTC using synthetic camera/microphone, mic stop and independent speaker behavior, file playback and refresh (0.008s observed local drift), chat attachment delivery; youtube-browser.cjs simulated API regression (2s drift corrected to 0.043s, buffering and local guest controls); recovery-browser.cjs history, identity reservation, mode and resize restoration. No unhandled browser errors observed.

Attachments: 20MB each, authenticated room/recipient scope, upload limits, bounded storage, 24-hour retention, cleanup on history trimming/room end/process restart. Ephemeral storage is intentional; this is not permanent file hosting.

Limits: synthetic media does not establish real-device acoustic loudness or cross-network quality. No TURN relay configured. Physical mobile devices, actual YouTube delivery and larger-room scaling require further validation. Calls remain limited to four seats. Exact xparty.onrender.com remains blocked by GitHub device verification required for Render dashboard sign-in. Accounts remain disabled pending provider/RLS setup. Main-site PR stays draft.

Run current browser regression suites with an available Chrome executable and Playwright; interface-v8.cjs and room-ui.cjs are historical UI checks superseded by compact-ui.cjs.
