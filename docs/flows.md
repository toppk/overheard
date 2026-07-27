# overheard — pages, views & states

Three maps of the same city: where a browser can stand (pages and their
views), what a construct can become (its one-way lifecycle), and what
happens on the wire when an operator jacks in.

## Page & view navigation

```mermaid
flowchart TD
  subgraph GRID ["/  — the grid"]
    LOGIN["login view<br/><i>handle, operator?</i>"]
    LOBBY["lobby view<br/>operators · hot constructs ·<br/>cold storage · grid traffic<br/><i>footer: jack out of the grid</i>"]
  end

  subgraph CHAT ["/chat/{id}  — construct"]
    JOIN["join view<br/><i>patch in as &lt;handle&gt;</i><br/>or under an alias —<br/>alias never touches the grid handle"]
    CALL["in-call view<br/>VU meter · operators on channel ·<br/>cut feed · drop the line"]
    SEALEDNOTE["flatlined notice<br/><i>no second run</i>"]
  end

  subgraph ARCH ["cold storage"]
    STACKS["/storage — the stacks<br/>toggle filters + full-text search"]
    PARSED["/archive/{id} — transcript dump<br/>+ raw channels + json<br/>(also .md and content-negotiated)"]
    PARSING["wintermute parsing…<br/><i>auto-refreshes 5s</i>"]
    UNPARSED["unparsed / parse failed<br/><i>wake wintermute</i>"]
    NOTFOUND["no such construct"]
  end

  ENTRY(["browser opens /"]) --> HANDLE{"stored<br/>handle?"}
  HANDLE -- "yes — auto-enter" --> LOBBY
  HANDLE -- "no" --> LOGIN
  LOGIN -- "jack in (stores handle)" --> LOBBY
  LOBBY -- "jack out of the grid<br/>(burns handle)" --> LOGIN

  LOBBY -- "spin up a construct<br/>GET /api/dig → navigate" --> JOIN
  LOBBY -- "patch in (hot construct)" --> JOIN
  LOBBY -- "access (last 24h list)" --> PARSED
  LOBBY -- "browse the stacks" --> STACKS
  STACKS -- "access" --> PARSED

  JOIN -- "patch in: mic permission<br/>+ ws join ok" --> CALL
  JOIN -- "join rejected: sealed" --> SEALEDNOTE
  SEALEDNOTE -- "access cold storage" --> PARSED
  CALL -- "drop the line / close tab<br/>→ leave, navigate /" --> LOBBY
  JOIN -- "back to the grid" --> LOBBY

  PARSED -.->|"back to the grid"| LOBBY
  PARSING -- "parse finishes" --> PARSED
  UNPARSED -- "wake wintermute<br/>POST …/transcribe" --> PARSING
```

## Construct lifecycle — one way, no second run

`metadata.json` on disk is what makes a flatline permanent: the id can
never be joined or reused.

```mermaid
stateDiagram-v2
  [*] --> unclaimed : name minted by GET /api/dig
  unclaimed --> hot : first patch-in<br/>(router created, taping starts per producer)
  hot --> hot : operators patch in / drop<br/>(≥1 channel still open)
  hot --> flatlined : last operator drops the line<br/>metadata.json written — PERMANENT
  flatlined --> parsing : wintermute wakes<br/>(auto when tracks > 0)
  flatlined --> [*] : nothing taped<br/>(empty archive, no parse)
  parsing --> parsed : exit 0 — transcript committed
  parsing --> parse_failed : nonzero exit<br/>(log kept per room)
  parse_failed --> parsing : wake wintermute<br/>POST /api/archives/{id}/transcribe
  parsed --> [*]

  note right of flatlined
    join attempts now
    rejected: "sealed"
  end note
```

## Jack in — what happens on the wire

The recording pipeline is fully independent of the call: an ffmpeg failure
can never drop the channel.

```mermaid
sequenceDiagram
  participant B as browser
  participant S as server (ws signaling)
  participant M as mediasoup SFU
  participant F as ffmpeg (per producer)

  B->>B: getUserMedia (mic) + start VU meter
  B->>S: join {roomId, handle}
  S->>M: get/create router
  S-->>B: rtpCapabilities + peers already on channel
  B->>S: createTransport ×2 (send, recv)
  S->>M: createWebRtcTransport ×2
  B->>S: produce (opus rtpParameters)
  S->>M: transport.produce
  S->>M: PlainTransport → consume producer
  M->>F: RTP (opus) to 127.0.0.1
  F->>F: tape ogg pages to disk continuously
  S-->>B: newProducer → other operators consume
  Note over B,M: DTLS-SRTP encrypted media, opus both ways

  B->>S: leave (drop the line)
  S->>M: close transports
  S->>F: SIGINT, await exit (file already durable)
  S->>S: last channel? → metadata.json (flatline) → wake wintermute
```

Source of truth: `web/src/pages/*.astro` (views), `server/index.ts`
(routing & seal), `server/recorder.ts` (taping), `server/transcriber.ts`
(wintermute).
