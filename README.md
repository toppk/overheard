# overheard

[![ci](https://github.com/toppk/overheard/actions/workflows/ci.yml/badge.svg)](https://github.com/toppk/overheard/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/toppk/overheard)](https://github.com/toppk/overheard/releases)
[![container](https://img.shields.io/badge/ghcr.io-toppk%2Foverheard-2496ed?logo=docker&logoColor=white)](https://github.com/toppk/overheard/pkgs/container/overheard)
[![site](https://img.shields.io/badge/site-the%20grid-4be4e4)](https://toppk.github.io/overheard/)
[![license](https://img.shields.io/github/license/toppk/overheard)](LICENSE)

Self-hosted, browser-based voice rooms that record every participant as a
separate audio track and produce an overlap-aware post-meeting transcript.
See `voice_meeting_transcription_system_plan.md` for the full design.

A working proof of concept: voice rooms (mediasoup SFU), per-speaker
Ogg/Opus recording with RTP-clock-anchored timing, offline name-aware
transcription, an overlap-aware compositor that weaves in room events
(joins, mutes, deafens) as stage directions, a searchable archive
(embedded Turso + native FTS), and an agent-friendly HTTP surface.

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
  the recordings directory. In-call, a TX/RX console shows live meters for
  what you send and what you hear, with the mute ("silence your mic") and
  deafen ("go deaf") controls attached to the flow they govern. Mute/deafen/
  join/leave land in the transcript as stage directions, placed by
  client-claimed, clock-synced timestamps.
- **Grid ambience** — sitting on the lobby, synthesized chimes (and
  optional browser notifications) announce arrivals, new constructs, and
  patch-ins. An orientation deck (4-page help popup) glows until first
  opened.
- **Two identities, on purpose** — your operator handle belongs to the grid;
  inside a construct you can patch in under any alias. The tape and the
  transcript record only the alias. Nothing links it back to your grid
  handle. New rules: this is not Zoom.
- **The verb ladder** — *jack in / jack out* is grid-level only (claim or
  burn your handle). *Patch in / drop the line* is construct-level (join or
  leave a room). One verb, one altitude.
- **Flatlining** — when the last operator drops the line, the construct
  flatlines permanently (a flatlined construct id can never be joined or
  reused) and **wintermute** — the offline transcription daemon — starts
  automatically.
- **Cold storage** — every flatlined construct is browsable by everyone at
  `/archive/{room-id}`: the conversation transcript, the structured JSON,
  and the per-speaker audio.
- **The stacks** (`/storage`) — search and filter all of cold storage:
  full-text search over every transcript (Turso native FTS, BM25-ranked
  with highlighted snippets), plus toggle filters for date, duration, and
  which voices were in the room. The grid lobby shows only the last 24h.

## Running an instance

**Read [SECURITY.md](SECURITY.md) first** — there is no authentication;
anyone who reaches the instance can hear everything.

Normal deployments run the released container image (docker or podman —
examples use podman). All durable state lives under a single `/data`
mount:

```
data/
  recordings/     audio, transcripts, metadata (source of truth)
  certs/          cert.pem (full chain) + key.pem -> HTTPS on
  index/          rebuildable search index (overheard.db)
  hf-cache/       whisper model cache (avoids re-downloading)
  overheard.env   instance config (see env table below)
```

```sh
mkdir -p data/{recordings,certs,index,hf-cache}
printf 'MEDIASOUP_ANNOUNCED_IPS=<public-ip>[,<lan-ip>]\n' > data/overheard.env
# put TLS cert.pem (full chain) + key.pem into data/certs/

podman run -d --name overheard --network host \
  -v $PWD/data:/data \
  --env-file $PWD/data/overheard.env \
  ghcr.io/toppk/overheard:latest
```

Host networking is the pragmatic choice for WebRTC's port range; with
bridged networking you must publish `3000/tcp` and the full RTC range and
keep `MEDIASOUP_ANNOUNCED_IPS` pointing at the host.

Open exactly these ports:

- `3000/tcp` — HTTPS + WSS signaling
- `40000-40100/udp` — WebRTC media
- `40000-40100/tcp` — ICE-TCP fallback (optional but recommended)

No TURN server yet — clients must be able to reach an announced IP
directly, which works for the common client-behind-NAT case since the
server is the media endpoint. Browsers require HTTPS for microphone access
on non-localhost origins, so real certificates in `data/certs/` are
effectively required.

To run it as a user service surviving reboots:

```sh
cd ~/.config/systemd/user && podman generate systemd --new --files --name overheard
systemctl --user daemon-reload && systemctl --user enable --now container-overheard
loginctl enable-linger   # start at boot without a login session
```

### Configuration

All configuration is environment variables (put them in
`data/overheard.env` for container deployments):

| var | default | purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP(S) listen port |
| `MEDIASOUP_ANNOUNCED_IPS` | all non-internal IPv4s | comma-separated ICE candidate IPs (set explicitly on multi-homed hosts: `public,lan`) |
| `RTC_MIN_PORT` / `RTC_MAX_PORT` | `40000` / `40100` | WebRTC media port range |
| `RECORDINGS_DIR` | `recordings` (`/data/recordings` in the image) | where audio/transcripts land |
| `CERTS_DIR` | `certs` (`/data/certs` in the image) | `cert.pem` + `key.pem`; their presence switches on HTTPS |
| `DB_PATH` | `data/overheard.db` (`/data/index/overheard.db` in the image) | search index; rebuildable from `RECORDINGS_DIR` |
| `OPUS_BITRATE` | `96000` | opus max average bitrate clients encode (and thus record) at; browser default is ~32k |
| `TRANSCRIBE_MODEL` | `small` | faster-whisper model size |
| `TRANSCRIBE_VOCAB` | unset | comma-separated domain terms to bias ASR toward (participant names are automatic) |
| `TRANSCRIBE_DISABLED` | unset | set to disable auto-transcription |

## Transcription

Transcription runs automatically when a room seals. Participant names are
fed to the decoder as vocabulary; add standing domain terms with
`TRANSCRIBE_VOCAB`. Per-room logs land in
`recordings/<room-id>/transcribe.log`; a "wake wintermute" button on the
archive page (or `POST /api/archives/{id}/transcribe`) re-runs it.

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
  markdown, JSON, or server-rendered HTML by Accept.
- `GET /api/archives` — enumerate/search archives: `q` full-text,
  `handles`, `since` (absolute epoch-ms/ISO — use for polling), `sinceMs`
  (relative window), duration bounds, `offset`/`limit`. Unparseable
  numeric params are a 400, never a silent no-filter.
- `GET /api/archives/{room-id}` — full JSON: metadata (tracks, events),
  transcript status (`none | running | done | failed`), rendered
  conversation.
- `GET /api/storage/facets` — participant handles with room counts.
- `GET /recordings/{room-id}/…` — raw per-speaker Ogg/Opus (each
  transcript's "raw channels" section links these).

The transcript markdown is a complete door: speech, stage directions,
overlap marks, and links to the source audio. See `docs/agent-qa.md` for
the agent feedback sessions that shaped this surface.

## Development

Requirements: Node.js >= 20, npm >= 11.10, ffmpeg (+ffprobe), Python 3,
openssl, and optionally podman/docker for container work.

### Standalone (fastest loop)

```sh
npm install
python3 -m venv .venv && .venv/bin/pip install -r transcription/requirements.txt
npm run dev              # builds the Astro frontend, then starts the server
```

Open http://localhost:3000. State lands in the repo's `recordings/` and
`data/` (both gitignored); all env vars from the configuration table apply.
For mic access from other devices on your LAN, generate a self-signed
cert — browsers will warn, but it works for testing:

```sh
./scripts/gen-certs.sh   # writes certs/{cert,key}.pem; server picks them up
```

Checks and tests:

```sh
npm run check           # typecheck the server
npm run build:web       # build the frontend
npm run test:loopback   # end-to-end recording pipeline test (needs ffmpeg)
```

`test:loopback` injects a sine tone as a fake participant through the full
mediasoup → ffmpeg recording pipeline and fails unless a playable Ogg/Opus
file comes out. CI runs typecheck, frontend build, a python syntax check,
the loopback test, and a Docker build on every push; tagging `v*` triggers
the release workflow (GHCR image + GitHub release).

### Container from source

To test the deployment shape (or ship a fix to your own instance) build
the image locally and run it exactly like the registry image:

```sh
podman build -t overheard:dev .
podman run -d --name overheard --network host \
  -v /path/to/data:/data --env-file /path/to/data/overheard.env overheard:dev
```

If the instance is systemd-managed, the redeploy loop is:

```sh
podman build -t overheard:dev .
systemctl --user restart container-overheard
```

Note the standalone dev server and a local container fight over port 3000
and the RTC range — stop one before starting the other.

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
recordings/      dev-mode audio + transcripts (gitignored)
data/            dev-mode search index (gitignored)
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
