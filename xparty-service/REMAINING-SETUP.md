# Xparty release status and remaining dependencies

The working application remains on the authorized feature branch; the main-site PR is still a draft.

## Deployment-dependent work

- Exact `xparty.onrender.com`: not assigned. The static site is named xparty but Render assigned `xparty-wsev.onrender.com`. Renaming the label is not proof of obtaining the hostname. Dashboard sign-in is required to inspect the available hostname controls. Do not silently allocate a different suffix or rename to a fallback without the owner's choice.
- Email/phone OTP, profiles, friends, direct account calls and Google libraries: existing optional integration needs a Supabase project, schema installation, public auth configuration, enabled email/SMS providers and Google OAuth scopes. Phone delivery may incur provider fees. Do not enable the UI before those dependencies work. See accounts/SETUP.md.
- Durable rooms and large local files: current free backend keeps guest rooms in memory and caps file uploads at 250 MB. Restarts lose rooms. Database/object storage and retention/cleanup work are still needed; deployment must not be described as permanent-room storage.
- Reliable relay coverage: TURN is not provisioned. Direct WebRTC works on tested localhost sessions, but restrictive networks need a configured relay.
- Vimeo, Dailymotion and SoundCloud are not implemented. Netflix/Prime DRM/subscription access cannot be treated as an ordinary embedded video source. Only supported, authorized provider integration can be offered.
- Real phone/tablet/desktop tests on different networks and acoustic echo/noise tests require actual devices. Automated synthetic-media tests cannot establish these outcomes.

## Further UX verification

- Complete Hindi/Kannada coverage for newly introduced controls.
- Review call controls in every chat-only layout and large-room screen size.
- Validate real YouTube search quotas, streams and embedded overlays with the configured provider. `controls: 0` is configured; removing every provider overlay is not guaranteed by that setting.
- Review operational privacy/retention notices when account/storage providers are chosen; UI consent is not a legal compliance certification.
