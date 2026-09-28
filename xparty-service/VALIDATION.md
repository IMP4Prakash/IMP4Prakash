# Revision 0.2 validation — 2026-09-28

Passed locally:
- Real WebSocket flows: room isolation, invalid origins, source permissions, resume, camera approval, forced mute, queue/votes, host transfer, kick and revoked-token rejection.
- Authenticated file chunk upload and downloaded-byte integrity.
- Two Chromium contexts at desktop and 390px mobile sizes: actual WebRTC with synthetic camera/audio, chat, host-only file selection, HTTPS transfer, shared playback/pause, refresh restoring room/chat/file, room lock, theatre with film/calls/chat, browsing while playing, no horizontal overflow or unhandled JavaScript errors.
- Local file players differed by 0.008 seconds in the measured run (same machine, not a cross-network claim).
- Simulated YouTube IFrame API contract: shared play/pause/seek and independent volume. Injected two-second drift corrected to approximately 0.098 seconds within two seconds. This is not real YouTube streaming validation.
- Public YouTube search returned real results for "lofi music" from the development runtime.

Still required: real phone/tablet/desktop playback across separate networks, actual YouTube streaming/ads/buffering, sustained playback, physical mobile codec/autoplay behavior, TURN relay coverage. User reported the previous live version's chat and mic/video working, but video sync failing; that does not validate this revision.

Room refresh survives while the service process remains alive. Render restart/deploy clears in-memory rooms. No automatic application expiry timer remains.

---
Historical first-build record follows; superseded behavior is described above.

# Xparty build validation — 28 September 2026

## Passed in this environment

- JavaScript syntax checks for server and frontend.
- Real HTTP/WebSocket server tests: room creation, valid/invalid codes, two-person capacity, four-person capacity setting, foreign-origin rejection, room isolation, host-only video selection, stale-source command rejection, file-readiness gate, guest playback control, token-based reconnect, locking, host-leave cleanup.
- Synchronization utility tests: video URL validation, server-clock position projection, small-drift tolerance and seek cooldown.
- Two independent Chromium browser contexts (desktop 1440px and mobile-emulated 390px): code entry, bidirectional chat, script/HTML displayed safely as text.
- Real local WebRTC peer connection: synthetic camera video decoded on both ends; incoming audio RTP bytes confirmed on both ends.
- A 15-second generated WebM selected only by the host, transferred over a real RTCDataChannel, automatically loaded by the guest and played in synchronization. One final-run sample had 0.010 seconds of drift. This is a single local observation, not a latency guarantee.
- Guest pause propagated to the host.
- Mobile layout had no horizontal overflow at 390px. Cinema mode kept the shared video and both camera tiles visible together.
- Locked room rejected a subsequent join attempt.
- No unhandled browser JavaScript errors in the completed two-person workflow.
- Four independent browser contexts joined a four-person room; all six pairwise WebRTC connections established. This was a connection smoke test, not sustained four-way media/bandwidth certification.
- Simulated YouTube IFrame API contract: video source selection, shared play, guest seek/pause and independent per-user movie volume.

## Not validated / not deployed

- Actual YouTube streaming, ads, buffering behavior, restricted embeds, and real YouTube search API credentials.
- Physical Android/iPhone/iPad/tablet/desktop devices, Safari, Bluetooth/headphone routing, and hardware volume behavior.
- Devices on different real networks; TURN relay and forced-relay connectivity.
- Camera/microphone privacy UX on physical devices. Automated tests used granted permissions and synthetic devices.
- Continuous four-person camera/audio/file-transfer load, battery or low-memory behavior.
- Large-file performance near 250 MB and arbitrary codecs. Multi-GB movie streaming is outside this first build.
- Hosting deployment, GitHub write/push, and a live URL. GitHub was installed during the task but its repository actions were not exposed to the active tool session.

## Test environment notes

The sandbox required Chromium loopback candidate flags and pre-granted synthetic-device permissions to test local WebRTC. Those flags are test-only; users do not need to change browser flags. Tests ran on one machine, not separate physical networks. The initial standard browser download failed; a packaged headless Chromium was used instead. A call negotiation defect affecting outgoing media from the answering peer was found and fixed before the passing tests.

Room/call screenshots with color bars and green moving images show generated test video, not actual participants. `Xparty-preview.png` is a clearly labeled design preview.

## References used for integration

- GitHub Pages static hosting: https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- YouTube IFrame API: https://developers.google.com/youtube/iframe_api_reference
- YouTube search API: https://developers.google.com/youtube/v3/docs/search/list
- WebRTC data channels: https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel
- TURN configuration: https://webrtc.org/getting-started/turn-server
- Browser media volume: https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/volume
- Node deployment example: https://render.com/docs/deploy-node-express-app
