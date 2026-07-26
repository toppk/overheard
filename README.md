# overheard

Self-hosted, browser-based voice rooms that record every participant as a
separate audio track and produce an overlap-aware post-meeting transcript.
See `voice_meeting_transcription_system_plan.md` for the full design.

This is a proof of concept covering plan phases 1–3: two-person voice calls
(mediasoup SFU), per-speaker Ogg/Opus recording to local disk, and offline
per-track transcription with a merged conversation transcript.

## Requirements

- Node.js >= 20 and npm >= 11.10
- ffmpeg (recording) and ffprobe (loopback test)
- Python 3 with `faster-whisper` for transcription
- openssl (only for generating the self-signed HTTPS cert)

## Quick start

```sh
npm install
npm run dev          # builds the Astro frontend, then starts the server
```

Open http://localhost:3000 and you jack into **the grid**.

## Conceptual model

The app is a small Neuromancer-flavored social space rather than a meeting
tool:

- **The grid** — the lobby. Everyone with the site open is present and
  visible: all operators online, all hot constructs (live rooms), everything
  in cold storage, and a running traffic feed. Everyone is a superuser;
  nothing is private, everything is remembered.
- **Constructs** — rooms, spun up on demand with generated jitsi-style names
  (`neon-static-relay`). Anyone can jack into a hot construct from the grid
  or via its `/chat/{room-id}` URL. Every channel is taped per-speaker to
  `recordings/{room-id}/tracks/*.ogg`. Your own mic level is shown as a VU
  meter ("your signal") so you know you're being heard.
- **Two identities, on purpose** — your operator handle belongs to the grid;
  inside a construct you can patch in under any alias. The tape and the
  transcript record only the alias. Nothing links it back to your grid
  handle. New rules: this is not Zoom.
- **The verb ladder** — *jack in / jack out* is grid-level only (claim or
  burn your handle). *Patch in / drop the line* is construct-level (join or
  leave a room). One verb, one altitude.
- **Flatlining** — when the last operator drops the line, the construct flatlines
  permanently (`metadata.json` is written; a flatlined construct id can
  never be joined or reused) and **wintermute** — the offline transcription
  daemon — starts automatically.
- **Cold storage** — every flatlined construct is browsable by everyone at
  `/archive/{room-id}`: the conversation transcript, the structured JSON,
  and the per-speaker audio. Constructs taped before auto-transcription
  existed (or after a failure) offer a "wake wintermute" button.

### Calling from other devices (e.g. iPad Safari)

Browsers require HTTPS for microphone access on non-localhost origins:

```sh
./scripts/gen-certs.sh                  # writes certs/{cert,key}.pem
MEDIASOUP_ANNOUNCED_IP=<your-lan-ip> npm run dev
```

Then open `https://<your-lan-ip>:3000` on the device and accept the
self-signed certificate. `MEDIASOUP_ANNOUNCED_IP` defaults to the first
non-internal IPv4 address, so setting it is only needed when that guess is
wrong. No TURN server yet — clients must be able to reach the announced IP
directly (same LAN is fine).

## Transcription

Transcription runs automatically when a room seals, using
`.venv/bin/python` if a `.venv` exists (else `python3`). Setup:

```sh
python3 -m venv .venv
.venv/bin/pip install -r transcription/requirements.txt
```

Env vars: `TRANSCRIBE_MODEL` (default `small`), `TRANSCRIBE_DISABLED=1` to
turn auto-transcription off. Per-room logs land in
`recordings/<room-id>/transcribe.log`. Manual run:

```sh
.venv/bin/python transcription/transcribe.py recordings/<room-id> [--model small]
```

Outputs in `recordings/<room-id>/transcripts/`:

- `tracks/<participant>.json` — raw per-track ASR with word timings
- `canonical.json` — merged utterances on the room timeline, with overlap flags
- `conversation.md` — readable transcript; simultaneous speech is marked
  `[overlapping]` rather than flattened into a false sequence

## Testing without a second person

`npx tsx scripts/loopback-test.ts` injects a sine tone as a fake participant
through the full mediasoup → ffmpeg recording pipeline and verifies a playable
Ogg/Opus file is produced.

## Layout

```
server/          Node/TypeScript control plane: signaling, rooms, recording
  index.ts       HTTP(S) + WebSocket signaling server
  room.ts        room/peer state, mediasoup router and transports
  recorder.ts    per-producer PlainTransport → ffmpeg → Ogg/Opus
web/             Astro frontend (built statically, served by the server)
  src/lib/call.ts        mediasoup-client call logic
  src/pages/chat/        the room page (/chat/{room-id})
transcription/   offline faster-whisper pipeline + transcript compositor
recordings/      local audio + transcripts, one directory per room (gitignored)
```

## PoC limitations

- No TURN (coturn) yet; direct connectivity to the server is required.
- No authentication; anyone with a room URL can join.
- Storage is the local filesystem, metadata is JSON (no Postgres/S3 yet).
- The transcript compositor is a simple timestamp merge with overlap flags,
  not the full masking/dominance model from the plan.
- Recording starts when a participant publishes audio and stops when they
  leave; mid-call reconnects create a new track file.
