# overheard

[![ci](https://github.com/toppk/overheard/actions/workflows/ci.yml/badge.svg)](https://github.com/toppk/overheard/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/toppk/overheard)](https://github.com/toppk/overheard/releases)
[![container](https://img.shields.io/badge/ghcr.io-toppk%2Foverheard-2496ed?logo=docker&logoColor=white)](https://github.com/toppk/overheard/pkgs/container/overheard)
[![site](https://img.shields.io/badge/site-the%20grid-4be4e4)](https://toppk.github.io/overheard/)

Self-hosted, browser-based voice rooms that record every participant as a
separate audio track and produce an overlap-aware post-meeting transcript.
See `voice_meeting_transcription_system_plan.md` for the full design.

This is a working proof of concept: voice rooms (mediasoup SFU),
per-speaker Ogg/Opus recording with RTP-clock-anchored timing, offline
name-aware transcription, an overlap-aware compositor that weaves in room
events (joins, mutes, deafens) as stage directions, a searchable archive
(embedded Turso + native FTS), and an agent-friendly HTTP surface.

## Requirements

- Node.js >= 20 and npm >= 11.10
- ffmpeg (recording) and ffprobe (loopback test)
- Python 3 with `faster-whisper` for transcription
- openssl (only for generating the self-signed HTTPS cert)
- optionally docker/podman for the container build

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
  (`neon-static-relay`). Anyone can patch into a hot construct from the grid
  or via its `/chat/{room-id}` URL. Every channel is taped per-speaker to
  `recordings/{room-id}/tracks/*.ogg`. In-call, a TX/RX console shows live
  meters for what you send and what you hear, with the mute ("silence your
  mic") and deafen ("go deaf") controls attached to the flow they govern.
  Mute/deafen/join/leave land in the transcript as stage directions, placed
  by client-claimed, clock-synced timestamps.
- **Grid ambience** — sitting on the lobby, synthesized chimes (and
  optional browser notifications) announce arrivals, new constructs, and
  patch-ins. An orientation deck (3-page help popup) glows until first
  opened.
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
- **The stacks** (`/storage`) — search and filter all of cold storage:
  full-text search over every transcript (Turso native FTS, BM25-ranked
  with highlighted snippets), plus toggle filters for date, duration, and
  which voices were in the room. The grid lobby shows only the last 24h.

### Calling from other devices

Browsers require HTTPS for microphone access on non-localhost origins.
Drop real certificates into `certs/cert.pem` (full chain) and
`certs/key.pem`, or generate self-signed ones for LAN testing:

```sh
./scripts/gen-certs.sh                  # writes certs/{cert,key}.pem
```

The server switches to HTTPS automatically when `certs/` exists.

### Deploying on the internet

**Read [SECURITY.md](SECURITY.md) first** — there is no authentication;
anyone who reaches the instance can hear everything.

Open exactly these ports:

- `3000/tcp` — HTTPS + WSS signaling
- `40000-40100/udp` — WebRTC media
- `40000-40100/tcp` — ICE-TCP fallback (optional but recommended)

Environment variables:

| var | default | purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP(S) listen port |
| `MEDIASOUP_ANNOUNCED_IPS` | all non-internal IPv4s | comma-separated ICE candidate IPs (set to `public,lan` explicitly on multi-homed hosts) |
| `RTC_MIN_PORT` / `RTC_MAX_PORT` | `40000` / `40100` | WebRTC media port range |
| `RECORDINGS_DIR` | `recordings` | where audio/transcripts land |
| `DB_PATH` | `data/overheard.db` | cold-storage index (Turso embedded, FTS over transcripts; rebuildable from `RECORDINGS_DIR`) |
| `OPUS_BITRATE` | `96000` | opus max average bitrate clients encode (and thus record) at; browser default is ~32k |
| `TRANSCRIBE_MODEL` | `small` | faster-whisper model size |
| `TRANSCRIBE_VOCAB` | unset | comma-separated domain terms to bias ASR toward (participant names are automatic) |
| `TRANSCRIBE_DISABLED` | unset | set to disable auto-transcription |

No TURN server yet — clients must be able to reach an announced IP
directly, which works for the common client-behind-NAT case since the
server is the media endpoint.

### Docker

```sh
docker build -t overheard .
docker run --network host \
  -v $PWD/recordings:/app/recordings \
  -v $PWD/certs:/app/certs \
  overheard
```

Host networking is the pragmatic choice for WebRTC's port range; with
bridged networking you must publish `3000/tcp` and the full RTC range and
keep `MEDIASOUP_ANNOUNCED_IPS` pointing at the host. Tagged releases
(`v*`) build and push `ghcr.io/<owner>/overheard` via GitHub Actions.

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

Participant names are automatically fed to the decoder as vocabulary;
add standing domain terms with `TRANSCRIBE_VOCAB` (or `--vocab` manually).

Outputs in `recordings/<room-id>/transcripts/`:

- `tracks/<participant>.json` — raw per-track ASR with word timings
- `canonical.json` — merged utterances on the room timeline, with overlap
  flags and typed room events (both claim and receipt timestamps)
- `conversation.md` — readable transcript: per-utterance timestamps, stage
  directions for joins/leaves/mutes/deafens, simultaneous speech marked
  `[overlapping]` rather than flattened, and a "raw channels" section
  linking the source audio. Utterances spanning a speaker's own mute are
  split at the boundary using word timings.

## API (agent-friendly)

`GET /llms.txt` on a running instance documents everything. Highlights:

- `GET /archive/{room-id}.md` — the transcript as plain markdown, one URL,
  no JavaScript. The human URL (`/archive/{room-id}`) content-negotiates:
  non-HTML clients get the markdown too.
- `GET /api/archives` — enumerate/search archives: `q` full-text,
  `handles`, `since` (absolute epoch-ms/ISO — use for polling), `sinceMs`
  (relative window), duration bounds, `offset`/`limit`. Unparseable
  numeric params are a 400, never a silent no-filter.
- `GET /api/archives/{room-id}` — full JSON: metadata (tracks, events),
  transcript status, rendered conversation. Also served for
  `Accept: application/json` on the human URL.
- `GET /api/storage/facets` — participant handles with room counts.
- `GET /recordings/{room-id}/…` — raw per-speaker Ogg/Opus (each
  transcript's "raw channels" section links these).

The transcript markdown is a complete door: speech, stage directions,
overlap marks, and links to the source audio. See `docs/agent-qa.md` for
the agent feedback sessions that shaped this surface.

## Development

```sh
npm run check           # typecheck the server
npm run build:web       # build the frontend
npm run test:loopback   # end-to-end recording pipeline test (needs ffmpeg)
```

`test:loopback` injects a sine tone as a fake participant through the full
mediasoup → ffmpeg recording pipeline and fails unless a playable Ogg/Opus
file comes out. CI (`.github/workflows/ci.yml`) runs typecheck, frontend
build, a python syntax check, the loopback test, and a Docker build on
every push; tagging `v*` triggers the release workflow (GHCR image +
GitHub release).

## Layout

```
server/          Node/TypeScript control plane
  index.ts       HTTP(S) + WebSocket signaling, API routes, llms.txt
  room.ts        room/peer state, events, mediasoup router and transports
  recorder.ts    per-producer recording: RTP timing relay → ffmpeg → Ogg/Opus
  transcriber.ts wintermute: spawns the offline transcription pipeline
  archives.ts    filesystem source of truth for sealed rooms
  db.ts          cold-storage index: embedded Turso + native FTS
  lobby.ts       grid presence and traffic feed
web/             Astro frontend (built statically, served by the server)
  src/lib/       call logic, diagnostics, chimes
  src/pages/     the grid (/), constructs (/chat), archives (/archive),
                 the stacks (/storage)
transcription/   offline faster-whisper pipeline + transcript compositor
site/            GitHub Pages project page
docs/            flow diagrams, agent QA record
recordings/      audio + transcripts, one dir per room (gitignored)
data/            rebuildable search index (gitignored)
```

## PoC limitations

- No TURN (coturn) yet; direct connectivity to the server is required.
- No authentication or identity: handles and aliases are self-claimed,
  `participant_id` is per-room, and everyone is a superuser (see
  SECURITY.md — this is currently by design, and the ACL/identity design
  is being deliberately pondered before building).
- Object storage is the local filesystem; the Turso index is rebuildable
  from it, not authoritative.
- The compositor handles overlap flags, event interleaving, and
  mute-boundary splitting — but not yet the plan's dominance/masking model
  ("probably unheard") or multi-pass transcript revisions.
- Mid-call reconnects create a new track file; foreground-only on iPad
  (screen lock drops the call).
