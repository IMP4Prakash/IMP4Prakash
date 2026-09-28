# Xparty — PKX404's private watch portal

A first working implementation for `/xparty/` on `pkx404.github.io`, with a separate Node.js room service. This is a prototype, not complete Rave parity.

## Included

- Eight-character, randomly generated room codes; no email, account or Google login for participants.
- Two-person rooms by default. Optional four-person mesh rooms are a beta feature.
- Host-only source selection, shared play/pause/seek, a shared server clock and threshold-based drift correction.
- YouTube embedded playback; in-app public search, with the official Data API supported via a server-side key.
- Room-scoped text chat, camera and microphone controls, real connection indicators.
- Mobile layout and a cinema button that keeps the shared video and call tiles together.
- Separate local movie and conversation volume. Web Audio mixes call audio and local files; YouTube uses its player API. Some mobile browsers restrict YouTube volume to hardware controls.
- Host-only local-file selection: authenticated HTTPS chunk uploads temporarily store the file on the room server, then guests download it automatically. Playback waits for online participants to load metadata. Files are deleted when replaced or the room ends.
- Room locking, refresh recovery, kick, host transfer, camera approval, microphone moderation, queue voting, join rate limits and bounded uploads. No application room-expiry timer.

## Important limits

- Live prototype: https://pkx404-xparty.onrender.com . The GitHub Pages integration remains in draft PR #1.
- **Real phone/tablet/desktop tests over separate networks remain a deployment acceptance step.** Headless browser tests are not equivalent.
- **Local video maximum: 250 MB.** Each guest receives the entire file in browser memory before playback. This is a transfer-first implementation, not progressive streaming of multi-GB movies. Each recipient necessarily receives a copy of the media. Keep the host tab open until upload completes. Once uploaded, refresh downloads the same file again.
- **TURN is needed for reliable network coverage.** Default STUN supports direct connections where possible. Without TURN, some Wi-Fi/mobile combinations fail. A Node web service does not replace a TURN service.
- Calls use a peer mesh, capped at four. Four-person rooms require more upload bandwidth and have not been certified on low-end phones.
- Rooms and chat have no database. Restarting/deploying the backend ends all rooms. The last 100 messages are held in room memory and restored on refresh.
- Keep one backend instance: in-memory rooms do not work across uncoordinated replicas.
- Leaving transfers host ownership to another participant. Disconnected participants keep their slots until they leave, are removed, or the room ends. Session credentials are retained in sessionStorage for same-tab refresh; a new tab/device needs a new join.
- Browser autoplay restrictions can require tapping Play or Enable sound. Background/screen-lock operation is not promised.
- YouTube availability, ads, embedding permissions, browser restrictions and buffering may prevent exact frame synchronization. The app does not bypass these restrictions.
- Code-only entry is possession-based privacy. Anyone given the code can join while unlocked. There is no email verification or claim of end-to-end encrypted text chat. Use TLS in production. WebRTC encrypts media in transit; peer IP addresses may be exposed by direct connections.

## Run on your computer

1. Install Node.js 22 or later.
2. Open a terminal in this folder.
3. Run `npm ci` then `npm start`.
4. Open `http://localhost:8787/xparty/` in two separate browser profiles.
5. Create a room in one and enter its code in the other.

For custom settings, copy `.env.example` to `.env`, fill it, and start with:

```sh
node --env-file=.env server.mjs
```

Never upload `.env` or private keys into the website folder.

## Deploy the backend

The frontend can remain on GitHub Pages, but room signaling needs a continuously reachable HTTPS/WebSocket server. A Dockerfile and a Render blueprint are supplied. The deployment account and any paid services must belong to you. This package does not automatically create or charge for hosting.

1. Put this backend package into its own repository, or use the `xparty-service` directory of the supplied integration layout as the host's root directory.
2. Create a Node web service on your chosen host. Use `npm ci --omit=dev` as the build command and `node server.mjs` as the start command. The service binds to the host's `PORT`.
3. Set `ALLOWED_ORIGINS=https://pkx404.github.io`. If serving the interface from the backend too, add that HTTPS origin separated by a comma.
4. On Render, the supplied blueprint sets `TRUST_PROXY=1`; verify your host's proxy behavior before using that on another provider.
5. Configure a TURN provider or your own coturn server. For coturn, set `TURN_URLS` (comma-separated `turn:`/`turns:` URLs) and `TURN_SECRET` to match its shared secret. Support TCP/TLS in addition to UDP for restrictive networks. Keep the secret server-side; Xparty generates temporary credentials for room participants.
6. Optionally set `YOUTUBE_API_KEY` with YouTube Data API v3 enabled. The key is used only server-side. Without it the server parses public YouTube search results, which can break or be blocked; configure the official API for supported search. Search is rate-limited.
7. Visit `https://YOUR-BACKEND/health`; it should return `{"ok":true,"service":"Xparty"}`.
8. Put the backend HTTPS URL into `public/xparty/config.js`:

```js
window.XPARTY_CONFIG = { backendUrl: 'https://YOUR-BACKEND' };
```

Free/sleeping backend plans can delay joins or interrupt rooms. Review current provider limits and costs before choosing a plan. TURN relay bandwidth can be billable.

## Add to pkx404.github.io

- Copy the **contents of `public/xparty/`** into a folder named `xparty` at your website repository's root.
- Copy `integration/xparty-card.css` to your website root.
- Add `<link rel="stylesheet" href="xparty-card.css">` after your existing stylesheet.
- Insert the contents of `integration/project-card.html` inside your existing `<section id="projects">`, after its introduction.
- A complete `integration/index-with-xparty.html` is also supplied, based on the live website fetched during this task. Prefer the card snippet if your homepage has changed since then.
- Keep your existing `style.css`, `script.js`, portrait assets and contact section.
- Publish through your existing Pages workflow. The intended URL is `https://pkx404.github.io/xparty/`; this is not a claim that the URL has been deployed.

## Validate on real devices after deployment

Use headphones. Test Phone A on mobile data and Device B on a different Wi-Fi connection; repeat with desktop/tablet as needed.

1. Create a two-person room on A. Open the portal separately on B and type the code. Confirm a wrong code and locked room cannot join.
2. Send a message each way. Neither should appear in another room.
3. Request guest camera access, approve it as host, then enable both microphones and cameras. Confirm audible voices both ways and visible moving video; do not rely only on the connection label.
4. Play an embeddable YouTube video for ten minutes. Pause and seek from both devices. Record observed drift, buffering and any repeated unexpected seeks.
5. Turn movie volume down with conversation unchanged; then reverse. Check mobile YouTube volume behavior explicitly.
6. In portrait and landscape, use cinema view. Confirm the film and call video remain visible simultaneously.
7. Select a small MP4 or WebM **only on A**. Wait for transfer completion on both. Play, pause and seek from B. Repeat while calls are active. Check codec support on each device.
8. Test a brief network drop, denied camera permission, leaving the room, and a code shared after the host leaves.
9. Test a forced TURN-only session in a controlled build to verify relay credentials and firewall configuration. This has not been validated by this package's local test environment.
10. Only after the two-device workflow passes, try four-person rooms and record bandwidth/battery effects.

## Tests

`npm test` covers real server/WebSocket flows plus synchronization math. `npm run check` checks JS syntax.

`tests/browser.cjs` is a Playwright end-to-end test. It uses real WebRTC with synthetic camera/microphone tracks in two separate browser contexts on one machine. Create its video fixture using:

```sh
ffmpeg -y -f lavfi -i testsrc2=size=640x360:rate=24 -f lavfi -i sine=frequency=220:sample_rate=48000 -t 15 -c:v libvpx -b:v 350k -c:a libopus tests/sample.webm
```

Install Playwright and Chromium for your environment, run the server, then run the test. See `VALIDATION.md` for the actual results from this build. Never equate local synthetic-device tests with physical devices on separate networks.
