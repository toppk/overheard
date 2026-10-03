# AGENTS.md

Orientation for agents working in this repo. README covers the product
and operations; this is the dev loop distilled, plus what isn't obvious
from either.

## Commands — all from the repo root

`web/` has no package.json of its own; the Astro frontend builds via
`astro … --root web` from the root scripts. `cd web && npm run …` fails.

- `npm run build:web` — build the frontend into `web/dist`. The server
  serves that directory statically, so frontend edits are invisible
  (to both `npm run dev` restarts and the container) until this runs.
- `npm run check` — typecheck the server (`tsc --noEmit`)
- `npm run test:loopback` — end-to-end recording pipeline test (ffmpeg)
- `npm run dev` — `build:web` then start the server on :3000

CI runs: check, build:web, a python syntax check, the loopback test,
and the Docker build.

## The local deployed instance (podman + systemd)

The dev machine usually runs a production-shaped instance: a rootless
podman container under a systemd **user** unit.

- unit: `container-overheard` — `systemctl --user status container-overheard`
- image: `localhost/overheard:dev`, built from this working tree
- config: a **read-only** `/conf` bind mount holding `overheard.env`,
  which is also the unit's `--env-file`.
- state: a `/data` bind mount — recordings, search index, model cache.

  Both live **outside the repo**, so image rebuilds never touch either, and
  the split keeps what you author separate from what the app owns.
  `podman inspect overheard` shows the mount sources and env when you need
  them.

- TLS: **this instance runs behind Apache**, which terminates TLS for
  `https://overheard.x.bllue.org/` and proxies to `127.0.0.1:21310`
  (`HOST=127.0.0.1`, `PORT=21310` — the port comes from foundation's
  registry, and Apache is configured to match, so don't change it on this
  side alone). `CERTS_DIR=/conf/nocerts` is an empty directory, so the app
  serves plain HTTP; the server logs `using HTTP` and that is correct here.
  The RTC range (40000–40100) is still reached directly, not via Apache.

  Other deployments use **native TLS** (cert.pem + key.pem in `CERTS_DIR`,
  served on whatever `HOST`/`PORT`); both modes are supported and
  documented in the README — don't optimise one away. The app is
  proxy-agnostic: clients build `wss://` from `location`, and the server
  never reads forwarded headers or builds absolute URLs. Keep it that way.

Redeploy after a change:

```sh
podman build -t overheard:dev .
systemctl --user restart container-overheard
podman logs overheard 2>&1 | tail   # "overheard listening on …" = up
```

The unit was made with `podman generate systemd --new`, so a restart
recreates the container from whatever `localhost/overheard:dev` currently
is — no `podman run` needed. The standalone dev server (`:3000`) and the
container no longer share an HTTP port, but they still fight over the RTC
range; stop one before starting the other.

A rebuild re-resolves the Python dependencies, so check a transcript after
one. PyAV 19 once landed this way and broke faster-whisper's audio open;
`transcription/requirements.txt` now pins it. The scribe exits non-zero
(and writes no transcript) when every track fails, so the lobby says
"wintermute chokes" rather than filing an empty transcript.

## Releases

`npm version X.Y.Z --no-git-tag-version`, commit as `Release X.Y.Z`,
tag `vX.Y.Z`, push master and the tag. The release workflow builds the
ghcr image and creates the GitHub release — but its auto-generated body
is just a compare link, and a compare link is not a release note.

Hand-written notes are part of the release, not optional. After the
workflow creates the release, replace the body:

```sh
gh release edit vX.Y.Z --notes-file <notes.md>
```

Write them in v0.9.0's voice: one line naming the release's theme, then
short bold-led sections grouped by surface (**The call**, **The tape**,
**The transcript**, **The stacks**, …) in the product's fiction —
describing what changed for the person using it, not restating commits.
Source the content from `git log vPREV..vNEW`, close with known gaps
when honest, and keep the **Full Changelog** compare link as the last
line. v0.9.0, v0.9.1, and v0.10.0 are the models.

## Cross-cutting seams to know about

- The transcript markdown (`conversation.md`) is written by
  `transcription/transcribe.py` and re-parsed line-by-line by the archive
  page (`web/src/pages/archive/index.astro`). A format change must land
  on both sides. The markdown deliberately ends with a `## raw channels`
  section for agents fetching the `.md`; the HTML view strips it and
  renders its own audio players.
- `/archive/{id}` content-negotiates markdown / JSON / HTML by Accept.
  The HTML variant embeds an SSR `<pre>` of the full markdown for no-JS
  clients; the client script clears and re-renders it.
- User-facing copy speaks the fiction (jack in, constructs, flatlined,
  cold storage, wintermute — see the orientation deck and README); code
  and docs stay plain. Commit messages follow `git log`'s style: a short
  declarative summary line, no conventional-commit prefixes.
- Every call client mirrors its diagnostics over the room websocket into
  the server log as `[trace <room>/<name>] …` (newProducer received,
  consume, play refused + error name, transport states, carrier
  lost/restored, mic seized/gone, ICE restarts, resyncs, wake lock). For
  any live-call bug report, `podman logs overheard` holds both sides of
  the story — read it before theorizing; a missing trace line is itself
  the answer (that client never processed the event).

- **"No audio" has four causes and they are not interchangeable.** The
  carrier watch (`web/src/lib/call.ts`) attributes a stalled TX before
  naming it: mic ended → `MIC GONE`, mic seized by another app (a call,
  Signal, Siri — `track.muted`, which is *not* our mute button
  `track.enabled`) → `MIC SEIZED`, otherwise → `TX dead … (network likely
  eating UDP)`. Only the network case triggers an ICE restart; a seized
  mic needs the user, and no candidate pair will fix it. Don't collapse
  these back into one message — telling someone to debug their router
  when Signal has the mic is how a whole afternoon gets lost.

- **Every join logs the caller's platform** — `[room X] name joined as id
  — iPadOS 17.4 · Safari 17 · tablet`. Coarse by design (OS/browser major
  version, form factor, standalone; no UA string, no metrics, no device
  labels): enough to spot "only on iPadOS Safari", not enough to identify
  a device. `web/src/lib/platform.ts`. Note iPadOS Safari reports a Mac UA
  by default and is separated by `maxTouchPoints` — the same UA string
  means macOS on a desktop and iPadOS on a tablet, so never read the raw
  UA and conclude "Mac".

- **A mic that goes away must be re-taken, not waited for.** A
  `MediaStreamTrack` at `readyState === 'ended'` is dead permanently; it
  cannot be restarted. When another app seizes the mic the platform either
  hands the track back (`unmute`) or kills it, and which one depends on the
  OS audio stack — and iPadOS Safari was observed doing **both**, on two
  runs of the same Signal-seizes-the-mic test (ken, 2026-08-06 and
  2026-08-07): once it ended the track, once it unmuted it. Never assume
  which; both paths must work, plus a timed fallback for a platform that
  does neither and says nothing.
  `reacquireMic()` calls getUserMedia again and `producer.replaceTrack()`s
  the result into the live producer, so the producer, transport, recording
  and room all survive. Two invariants when touching it: the user's own
  mute lives on `track.enabled` and must be re-applied to the replacement
  (it is captured *before* the swap), and the TX level meter has to be
  re-tapped or it reads the dead track and sits at zero — which looks
  exactly like the failure that was just fixed.

- **On iOS the microphone is not the only casualty.** An audio-session
  interruption also suspends the `AudioContext` and pauses the `<audio>`
  elements, so recovering the mic alone leaves you able to talk but unable
  to hear, with both meters reading zero. `resumePlayback()` handles that
  and runs on both mic reacquisition and visibilitychange; playback the
  browser refuses without a gesture goes into the existing tap-anywhere
  path rather than being swallowed.

- **Use the right lifecycle event, and use both halves of it.**
  `visibilitychange` fires going *hidden* as well as visible, and the hidden
  edge is the last moment a locking device can still reach the server — it
  sends `away`, which is why the lobby can say "toppk (away)" immediately
  instead of claiming they are on channel for the ~12s TCP takes to notice.
  For unload, `beforeunload` is **not reliable on iOS Safari**; `pagehide`
  is. Both are wired, and `leave()` is idempotent because some browsers
  fire both. Guard `pagehide` on `event.persisted`: that case is the
  back/forward cache, not an unload, and leaving there would latch
  `leaving` and defeat the reconnect.

- **The client reconnects itself after a mid-call drop.** `reconnect()`
  rebuilds the session in place — new socket, new transports, new producer,
  re-consume everyone — against the same room, so a screen lock becomes a
  gap in the tape rather than the end of a meeting. `join()` was split for
  this: `establish()` is the re-runnable half, and the loaded `Device`, the
  mic and the AudioContext survive a drop while transports and consumers do
  not. Two invariants: the replaced socket must be detached before opening
  the next one (its `onclose` would start a second reconnect), and the
  backoff ladder must stay comfortably inside the server's hold window —
  getting back into the *same* construct is the whole point, and a sealed
  one cannot be rejoined at any speed. Known cost: the server sees a new
  peer, so each reconnect adds a second track for the same speaker.

- **An empty room is held open before it seals** (`EMPTY_ROOM_LINGER_MS`,
  30s, `ROOM_LINGER_MS` to override). Sealing is permanent, so doing it the
  instant the last socket drops means a screen lock ends the meeting for
  good — exactly what happened on iPadOS (ken, 2026-08-07): the lock
  suspended the page, the ws died ~10s later, the construct flatlined, and
  unlocking left nothing to rejoin. The seal arrives via
  `roomManager.onSealed()`, not a return value from the leave path —
  anything that must run at seal time belongs there.

  **Write nothing to disk during the hold.** `isSealed()` is defined as
  "metadata.json exists" (`archives.ts`), so writing metadata early to make
  the hold crash-safe silently marks the room sealed *while it is still hot
  and rejoinable* — two states that must never overlap. That bug was
  written and caught the same day; the tracks are already on disk, and the
  window is seconds. `listLive()` exposes `sealsAt` so the lobby can say
  "channel empty — flatlines in ~Ns" rather than claiming, from an empty
  participant list, that someone is still on channel.

- **A dead signaling socket invalidates every other diagnosis.** Once the
  ws is gone the session no longer exists, so TX/RX stalls are its symptom,
  not independent faults; the carrier watch bails out and `onclose` clears
  the banner and says the line dropped. It also fires `onDisconnected`, and
  the chat page must put the way back on screen: a dead in-call UI whose
  only exit is "drop the line" strands you outside a construct that is
  still hot and waiting (ken, 2026-08-07). A dropped `Call` cannot be
  reused — its mediasoup `Device` is already loaded and its transports are
  dead — so rejoining means a fresh page, not a second `join()`. Leaving a "network likely eating
  UDP" message up for a call that has already ended is how someone spends
  an afternoon debugging a network that was fine.

- **Never call getUserMedia while the page is hidden.** iOS answers a
  prompt it cannot show with `NotAllowedError`, and treating that as a real
  denial latches the mic as lost for the rest of the call — a screen lock
  would then poison the recovery it was supposed to trigger. Reacquisition
  waits for `visibilitychange`, which also re-arms any denial recorded
  while backgrounded.

- **Recovery has to be visible the moment it happens.** The carrier banner
  is rebuilt on a 3s beat, so any recovery that lands mid-beat leaves the
  user being told they are broken while they are already talking — caught
  on the 2026-08-07 iPad tape as "it works, but it still says mic seized".
  `refreshMicCarrier()` clears it immediately on unmute and on a successful
  reacquire. Anything else that adds a recovery path should do the same:
  a stale alarm teaches people to distrust the banner exactly when it is
  telling the truth.

- **The path dies but ICE never re-runs.** A UDP-hostile network (CGNAT
  rebinding, a firewall culling the flow) kills the specific 5-tuple ICE
  settled on; because the handshake already succeeded, nothing retries and
  the transport sits `connected` on a dead path. That is why leaving and
  rejoining — or switching devices — "magically" fixed it: both build new
  transports on new ports. `considerIceRestart()` buys the same new ports
  while keeping the room, producer and recording intact. The
  `[transport …] tuple:` log line is the evidence: a restart that recovers
  audio shows a new remote port, one that doesn't shows the same one.

- **Keep the log readable — it is the only witness.** ffmpeg's jitter
  chatter ("max delay reached", "RTP: missed N packets") was 76% of all log
  volume across six real meetings, so it is counted and reported once in
  the `[rec] recording finalized …; N packet(s), M jitter event(s)` line
  instead of per event. ffmpeg stderr is split per line before prefixing:
  a multi-line chunk logged as one entry left 793 lines with no
  `[ffmpeg <id>]` prefix and no way to tell whose track they belonged to.
  Anything new that logs per-packet or per-frame gets the same treatment.

- **A track that captured zero RTP is not a recording.** `recorder.ts`
  counts relayed packets and sets `capturedMedia`; `room.writeMetadata()`
  keeps such tracks out of `metadata.json` entirely, and the scribe is not
  summoned for a room where nothing was taped. Don't use ffmpeg's exit
  code for this — the identical no-packets condition exits 255 or 0
  depending on how the read timed out. The participant isn't erased:
  their join/leave stay in `events[]`, there is simply no tape of them.

## Deployed data outlives the code

Archives are derived artifacts: metadata + raw audio + raw per-track ASR
are the durable inputs, and canonical.json / conversation.md are computed
from them. docs/transcript-forensics.md has the working recipes for
diagnosing this pipeline against real sessions — timeline forensics
(events vs tape vs ASR), whisper-free re-merges for dry runs and
backfills, A/B experiments inside the deployed container, and rescuing
derived data from the search index. A fix to the derivation (transcribe.py's merge logic, the
markdown renderer) silently leaves every already-archived room on the old
behavior — shipping the fix is half the job; decide what happens to
existing deployments' stored output too.

- Prefer **re-merging from the preserved raw ASR** over re-running
  whisper: it applies the corrected logic while keeping archived wording
  bit-identical. A whisper rerun can change what the archive *says*, and
  archived speech is content, not cache.
- Don't assume every room dir matches the current output format. The
  owner's deployment goes back to the earliest versions and is preserved
  deliberately (nostalgia included) — some rooms predate the raw-ASR
  output, old schemas exist, and "fix" must never mean bulk-rewriting
  history without asking.
- Today there is one deployment (the podman unit above), so a hand-run
  backfill after a fix is workable. Once there are more, a fix that
  changes derived data needs a real story — versioned outputs or a
  backfill/migration path — not a script someone remembers to run.

## Lessons from real agent sessions

Distilled from reviewing actual contributions — each of these was violated
at least once, at real cost:

- **The contract moves with the code, in the same commit.** If you change
  anything an outside consumer parses — `/archive/{id}.md`, API params,
  transcript line grammar — update `llms.txt` (it lives in
  `server/index.ts`) and the README's API section too. This repo's
  standing lesson (docs/agent-qa.md, rounds 4–5): "the code was fine and
  the contract lied." Read that file before touching the API surface.
- **Never silently undo an owner decision.** If a change reverses
  something the owner previously asked for (a feature, a wording, a
  layout), say so explicitly in the commit message and get a yes first.
  Improving on a decision is welcome; erasing it quietly is not.
- **One logical change per commit**, with the house message style: a
  declarative summary line, a body that explains why (and what it might
  break), no conventional-commit prefixes. "Improve X" with no body is
  not enough for anyone auditing later.
- **Push when you're done.** Unpushed work never meets CI, and CI is the
  only reviewer that's always awake. If it isn't pushed, it isn't done.
- **Finish the deploy loop** (build image, restart the unit — see above)
  when your change should be live, and verify against the live instance
  (`curl -sk https://localhost:3000/...`), not just the build.
- **Interactive niceties have non-obvious halves**: sticky navs need
  `scroll-margin-top` on their anchor targets; disabled links need
  `tabindex="-1"`, not just `pointer-events: none`; `aria-current` wants a
  real value ("location"), not a bare attribute toggle.
- When in doubt about tone or vocabulary, the orientation deck
  (`web/src/components/HelpDeck.astro`) is the canonical voice sample.
