# Second hero refinement validation — 2026-09-30

Restore point: `xparty/preserved-second-hero-20260930`, commit `de0e51b1701af0ec8b28a0d9a6210ddce779ba28`.

Changes: original saved cut-out X mark delivered through a shared SVG; one full playback status inside the player; quiet underline view selectors and a zoom/focus icon; home-header-only profile icon; notifications inside Settings; prominent complete room code; compact camera-off participants; resizable call media in Both view; per-person friend icons; plain product footer. Call controls hide after inactivity and can be revealed by touch, hover, keyboard or the control icon.

Call-seat handling is isolated from playback authorization. Taking a seat in a controlled mode requests host review, with a four-seat capacity limit. Host-only newcomers watch/chat until admitted. Approved seats survive reconnect; dropping a seat revokes admission, and refreshing cannot approve a pending request. Existing default-room admission behavior remains. A host may offer one guest a mic seat; this never starts a microphone or camera on that guest's device. Call track updates safely stop when their peer connection closes.

Passed locally:
- 12 server tests, including unauthorized seat review and mic offer, decline, capacity enforcement, room access, recovery, attachment isolation and playback control.
- second-hero.cjs: shared logo, profile placement, one status, compact auto-hide rows, friend icon, real two-client seat request/decline/approval/reconnect, explicit mic offer, large resizable call video and header containment at 320, 390, 844 landscape and 1366 pixels.
- layout-social.cjs: polls, friend approval and all combinations of three theatre views and call/chat/both at the same viewport sizes.
- compact-ui.cjs: decoded synthetic video and incoming audio packets both directions, portrait tiles/self placement, PiP, room switching, GIF previews and responsive layouts.
- refinements-ui.cjs and recovery-browser.cjs: privacy/agreement entry, nickname preference, navigation and reserved-identity recovery.
- youtube-browser.cjs: simulated YouTube API synchronization, injected two-second drift corrected to 0.068 seconds, buffering/recovery without a seek loop, guest local pause and independent playback volume. Actual YouTube streaming was not validated by this fixture.
- JavaScript syntax, unique HTML IDs and CSS parsing.

Physical-device acoustics, cross-network TURN connectivity and arbitrary YouTube availability are outside these browser fixtures. Playback clock and synchronization algorithms are unchanged. Guest friendships remain room-scoped.
