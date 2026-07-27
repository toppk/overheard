# Security

overheard is a proof of concept with an unusual, deliberate security posture.
Read this before putting an instance on the internet.

## The designed posture: radical transparency

There is **no authentication and no authorization**. Every visitor is a
superuser: anyone who can reach the instance can see who is present, join
any live room, and read/listen to every archived conversation, transcript,
and raw audio track. This is the product's stated ethos ("nothing is
private, everything is remembered"), not an oversight — but it means an
instance is exactly as private as the network path to it.

Consequences of exposing an instance publicly:

- Anyone who finds the port can listen to every recording ever made there.
- Anyone can join any live construct (room names are unguessable-ish
  generated slugs, but live rooms are listed in the lobby for everyone).
- Identities are self-claimed handles and per-room aliases; there is no
  account system and nothing prevents impersonation.

Mitigations for real deployments until auth exists: scope firewall rules to
known client IPs, run the instance only while testing, or front it with a
reverse proxy that adds authentication.

## Encryption

In transit, between machines:

- Web page, API, and signaling WebSocket: TLS (HTTPS/WSS) when certificates
  are present in the certs directory (`CERTS_DIR`; `/data/certs` in the
  container image). Without certs the server falls back to plain HTTP,
  intended for localhost development only.
- Audio: WebRTC-mandated DTLS-SRTP in both directions. There is no
  unencrypted media mode.
- Cleartext on the wire is limited to ICE/STUN connectivity probes and DTLS
  handshake framing (standard for all WebRTC), neither of which carries
  audio content.
- Traffic shape is not concealed: opus is VBR and packets flow continuously,
  so an on-path observer can infer speech activity patterns (who is
  talking and when, not what is said).

**Not end-to-end encrypted, by design.** The server terminates SRTP,
records every participant separately, and transcribes offline — that is the
product. The server operator can hear everything. E2EE (e.g. SFrame) would
blind the server and is structurally incompatible with this architecture.

At rest: recordings, transcripts, and metadata are plaintext files under
`recordings/`, and the search index (`data/overheard.db`) additionally
holds full transcript text. Disk encryption is the deployment's
responsibility.

The HTTP API (`/llms.txt` documents it) exposes all of the above for read,
including full-text search over every transcript — by design, to the same
everyone-is-a-superuser standard as the UI.

Inside the host, mediasoup forwards decrypted RTP to the recording process
over the loopback interface only.

## Data integrity and claims

Room events (mute/unmute/deafen) carry client-claimed timestamps used to
place them on the transcript timeline. Claims are sanity-checked against
server receipt time (10s window) but are ultimately client-asserted — the
data model treats them as claims, not observations. A malicious client can
shade event timing within that window.

## Network exposure

A deployment needs exactly:

- `3000/tcp` — HTTPS + WSS
- `40000-40100/udp` — WebRTC media (`RTC_MIN_PORT`/`RTC_MAX_PORT`)
- `40000-40100/tcp` — ICE-TCP fallback (optional)

Nothing else listens externally. There is no STUN/TURN component.

## Supply chain

- npm dependencies are exact-pinned; `.npmrc` enforces
  `min-release-age=7` (days) and `save-exact`.
- TLS private keys: `certs/` and `*.pem` are gitignored and
  dockerignored; never commit key material.

## Reporting

This is a personal proof of concept. Report issues to the repository owner
(ken@bllue.org) or open a GitHub issue for non-sensitive findings.
