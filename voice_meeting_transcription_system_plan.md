# Voice-Only Web Meeting and Post-Meeting Transcription System

## 1. Purpose

This project is a self-hosted, browser-based voice meeting system designed primarily to produce unusually accurate, useful, and honest post-meeting transcripts.

The initial deployment target is the web browser on iPad. Native iOS or Android applications are explicitly out of scope for the first version.

The system is not intended to compete immediately with Signal, FaceTime, WhatsApp, Zoom, or other mature calling platforms. The first goal is narrower:

> Create a simple voice room that participants can join through a URL, record every participant as a separate identified audio stream, and produce a high-quality post-meeting transcript that accurately represents interruptions, overlapping speech, and statements that may not have been audible to everyone.

The live call is important, but the primary product is the post-meeting record.

---

## 2. Core Goals

### 2.1 Browser-based voice rooms

Participants should be able to open a URL such as:

```text
https://my.app/chat/{room-id}
```

and join a voice-only conversation using the microphone and speakers of their device.

The first version should support:

- iPad Safari as the primary client
- Desktop browsers as secondary clients
- Two participants initially
- Small groups later
- Voice only
- Simple join, mute, unmute, and leave controls
- No native application requirement
- No dependency on a commercial hosted media provider

### 2.2 Self-hosted infrastructure

The system should be operable without paying LiveKit or another hosted real-time communication vendor.

The preferred media layer is:

- `mediasoup`
- `mediasoup-client`
- `coturn`
- A custom signaling and room service

The system may use open-source third-party components, but core operation should remain under the application's control.

### 2.3 Per-participant audio capture

Each participant's microphone should be captured as a separate identified media stream.

This provides:

- Reliable speaker identity
- Clean per-speaker audio
- Better transcription accuracy
- Accurate overlap detection
- Easier correction and reprocessing
- A stronger foundation for future agent use

The system should not depend on speaker diarization for native rooms because participant identity is known at capture time.

### 2.4 High-quality offline transcription

The authoritative transcript should be generated after the meeting.

In this document, a “flawless” transcript means:

- Significantly more accurate than low-latency real-time transcription
- Unconstrained by live latency requirements
- Able to use longer context windows
- Able to use larger or slower models
- Able to perform multiple passes
- Able to incorporate names, terminology, and domain vocabulary
- Able to revise punctuation, segmentation, and sentence boundaries
- Able to preserve uncertainty rather than invent certainty

It does not mean that speech recognition is literally incapable of error.

### 2.5 Honest reconstruction of the conversation

The system should not simply concatenate every participant's transcript in timestamp order.

It should preserve:

- Interruptions
- Simultaneous speech
- Speech continuing underneath another speaker
- Short acknowledgements
- Likely masking
- Statements that were spoken but may not have been heard
- The difference between source audio and the conversation as perceived

The output should make clear when a participant continued speaking while another participant dominated the audible conversation.

### 2.6 Agent-ready structured data

The transcript should be suitable for later use by software agents.

Agents should receive structured information rather than only a large text file.

The system should preserve:

- Speaker identity
- Utterance IDs
- Word and utterance timing
- Overlap intervals
- Audio references
- Transcript revision history
- Confidence or uncertainty
- Whether speech was likely masked
- The distinction between raw ASR, canonical transcript, and derived summaries

Real-time agents are not an initial requirement.

---

## 3. Important Design Principle: Preserve Multiple Truths

A meeting has more than one valid representation.

The system should preserve at least three different views.

### 3.1 Source transcript

The source transcript contains everything spoken into every participant's microphone.

Example:

```text
00:14.200–00:17.500  Alice:
I think we should postpone the deployment—

00:15.100–00:18.900  Bob:
No, Thursday is our last available window.
```

This is the most complete record.

It may contain speech that other participants did not hear clearly.

### 3.2 Conversation transcript

The conversation transcript is a cohesive, overlap-aware rendering of the meeting.

Example:

```text
Alice: I think we should postpone the deployment—

Bob [interrupting]: No, Thursday is our last available window.

Alice [continuing underneath Bob]:
—because the migration cannot be rolled back.
```

This representation should never silently convert simultaneous speech into a false clean sequence.

### 3.3 Heard transcript

A future heard transcript may approximate what a specific participant actually received or was likely able to hear.

Example:

```text
Heard by Ken:

Alice:
I think we should postpone—

Bob:
No, Thursday is our last available window.

Note: Alice continued speaking underneath Bob, but this portion was probably masked.
```

This is not required for the first version, but the architecture should not prevent it.

---

## 4. Why the Full Web Application Is Worth Building

The original simpler idea was:

```text
speakerphone conversation
    ↓
single mixed recording
    ↓
speaker diarization
    ↓
transcription
```

This is operationally simple but technically inferior.

A single speakerphone recording loses information that the communication system already had:

- Speaker identity
- Separate microphone tracks
- Exact overlap timing
- Clean audio for each participant
- The distinction between source speech and audible speech
- Reliable attribution during interruptions
- Per-participant network and delivery information

The full application instead records:

```text
participant A microphone → identified stream A
participant B microphone → identified stream B
participant C microphone → identified stream C
```

This avoids reconstructing speaker identity after the fact.

The system may still support uploaded mixed recordings later, but native room recordings should be the preferred mode.

---

## 5. Proposed System Architecture

```text
iPad Safari or desktop browser
        │
        │ WebRTC / Opus
        ▼
mediasoup SFU
        │
        ├── forwards audio to other participants
        │
        ├── per-speaker recording pipeline
        │
        ├── media timing and level metadata
        │
        └── optional live transcription pipeline
                    │
                    ▼
             provisional captions

per-speaker recordings
        │
        ▼
offline transcription workers
        │
        ├── high-accuracy per-speaker ASR
        ├── word and segment timestamps
        ├── vocabulary-aware correction
        └── full-context retranscription
                    │
                    ▼
transcript compositor
        │
        ├── source transcript
        ├── overlap-aware conversation transcript
        ├── likely masking annotations
        ├── readable export
        └── structured agent-ready representation
```

---

## 6. Major Components

### 6.1 Web client

Suggested technology:

- TypeScript
- `mediasoup-client`
- WebSocket signaling
- Standard browser WebRTC APIs
- Optional PWA shell

Initial client functions:

- Open room URL
- Enter display name
- Join room
- Grant microphone permission
- Mute and unmute
- Display participant state
- Display connection and recording state
- Leave room

The first version should assume:

- The Safari tab remains open
- The device remains awake
- The call remains in the foreground
- The browser may not behave like a native telephone application when locked or backgrounded

### 6.2 Signaling and room service

The application must provide signaling because mediasoup intentionally does not impose one.

The signaling service should manage:

- Room creation
- Room membership
- Participant identity
- Authentication or join tokens
- WebRTC transport negotiation
- Producer creation
- Consumer creation
- Reconnection
- Leave and disconnect events
- Transcript event delivery
- Recording state

Node.js or TypeScript is the natural control plane when using mediasoup.

### 6.3 Mediasoup media workers

Mediasoup should handle:

- WebRTC transport
- Opus audio streams
- Routing between participants
- Per-producer media access
- Audio-level observation
- Active-speaker observation
- Server-side media consumers

Mediasoup should remain independent from the transcription system.

A transcription failure must not interrupt the call.

### 6.4 TURN service

A production deployment requires TURN for clients that cannot establish a suitable direct media path.

Suggested component:

- `coturn`

TURN credentials should be temporary and scoped.

### 6.5 Recording pipeline

Every participant producer should be recorded separately.

Suggested options:

- GStreamer
- FFmpeg

GStreamer is likely preferable for long-running pipelines and explicit media graph control.

The system should preserve the original encoded Opus stream whenever possible.

Suggested archival formats:

- Ogg/Opus
- WebM/Opus
- Matroska/Opus

For ASR, the stream may be decoded to:

```text
16 kHz
mono
signed 16-bit PCM
```

PCM should be treated as a working format rather than the permanent master unless storage is irrelevant.

### 6.6 Object storage

Audio should be stored in S3-compatible object storage.

Possible layout:

```text
calls/{call-id}/
    metadata.json
    participants/{participant-id}.json
    audio/{participant-id}/000000.opus
    audio/{participant-id}/000001.opus
    transcripts/live.jsonl
    transcripts/canonical.json
    transcripts/conversation.md
```

Audio should be segmented into immutable chunks to support:

- Crash recovery
- Incremental uploads
- Partial retranscription
- Bounded data loss
- Parallel processing
- Reliable timing reconstruction

### 6.7 Metadata database

PostgreSQL is a reasonable primary store for:

- Rooms
- Participants
- Join and leave events
- Audio segment metadata
- Utterances
- Transcript revisions
- Overlap intervals
- Processing state
- Export state

Redis may be added for:

- Ephemeral room state
- Work queues
- Distributed coordination

It is not required for an initial single-node prototype.

### 6.8 Offline ASR workers

The offline pipeline is the highest-priority transcription component.

Candidate stack:

- Python
- `faster-whisper`
- A large Whisper-family model
- GPU acceleration where available
- Voice activity detection
- Word-level alignment where practical
- Multiple decoding passes

Offline processing should support:

- Participant names
- Product names
- Technical vocabulary
- Abbreviations
- Meeting-specific context
- Longer context windows
- Retries with different decoding parameters
- Model replacement without changing the stored source audio

### 6.9 Transcript compositor

The transcript compositor is the most distinctive application component.

It should merge independently transcribed participant tracks onto a shared room timeline.

It should understand:

- Speaker turns
- Interruptions
- Simultaneous speech
- Continued speech underneath another speaker
- Short acknowledgements
- Pauses
- Likely masking
- Sentence continuation
- Whether an utterance was probably part of the audible conversation

The compositor should produce both human-readable and machine-readable forms.

---

## 7. Common Room Timeline

All artifacts should map onto a common room timeline.

The system should align:

- Participant join time
- RTP timestamps
- Recording segment boundaries
- Transcript segment times
- Word times
- Audio-level observations
- Active-speaker observations
- Subscription events
- Disconnects and reconnects

A monotonic room-relative clock should be preferred over relying only on independent wall-clock timestamps.

Example:

```json
{
  "participant_id": "p_123",
  "sequence": 42,
  "room_time_start_ms": 126000,
  "room_time_end_ms": 132000,
  "rtp_timestamp_start": 38192000,
  "codec": "opus",
  "sample_rate": 48000,
  "channels": 1
}
```

Without a common clock, speaker tracks will drift and overlap rendering will become unreliable.

---

## 8. Transcript Data Model

A canonical utterance may resemble:

```json
{
  "utterance_id": "u_987",
  "speaker_id": "p_123",
  "speaker_name": "Ken",
  "start_ms": 41220,
  "end_ms": 46310,
  "text": "Use the monthly SQLite catalog, not the daily one.",
  "overlapped": false,
  "source_audio": {
    "track_id": "track_p123",
    "segments": [7, 8]
  },
  "transcription": {
    "engine": "faster-whisper",
    "model": "large-v3",
    "pass": "offline",
    "revision": 2
  }
}
```

An overlap interval may resemble:

```json
{
  "overlap_id": "ov_73",
  "start_ms": 15100,
  "end_ms": 17500,
  "speakers": ["alice", "bob"],
  "dominance": [
    {
      "speaker_id": "bob",
      "estimated_level_dbov": -19,
      "rank": 1
    },
    {
      "speaker_id": "alice",
      "estimated_level_dbov": -31,
      "rank": 2
    }
  ],
  "audibility": {
    "ken": "alice_probably_masked"
  }
}
```

The data model should distinguish:

- Spoken
- Forwarded
- Probably audible
- Probably masked
- Unknown

These are not the same fact.

---

## 9. Live Transcription

Live transcription is a secondary feature.

It may eventually be useful for:

- Accessibility
- Convenience
- Live translation experiments
- Agent interaction
- Real-time search or note-taking

However, it should not define the core architecture.

Live transcription introduces:

- Rolling buffers
- Partial-result revisions
- Latency and accuracy tradeoffs
- Streaming model limitations
- GPU scheduling during meetings
- Caption synchronization
- Additional user interface states

The initial system should treat live captions as:

```text
provisional convenience
```

The offline transcript should be:

```text
authoritative canonical result
```

Live transcription may be deferred entirely from the first milestone.

---

## 10. Translation

Online translation is considered experimental and potentially gimmicky in the initial product.

It may eventually support:

- Cross-language meetings
- Accessibility
- Real-time agent interaction
- Multilingual observation

It is not central to the first version.

Offline translation is more meaningful because it can operate on the canonical source-language transcript.

The correct processing order is:

```text
source audio
    ↓
high-quality source-language transcription
    ↓
canonical transcript
    ↓
offline translation
```

The system should not overwrite original-language text with translated text.

Translations should remain linked to the source utterance and transcript revision.

---

## 11. Rejected or Deferred Solutions

### 11.1 Single mixed speakerphone recording as the primary design

Rejected as the main architecture because it requires reconstructing speaker identity and overlap from degraded mixed audio.

Problems:

- Diarization errors
- Crosstalk
- Echo
- Variable speaker distance
- Loss of clean source tracks
- Poor overlap attribution
- No reliable participant identity
- Difficulty knowing what was masked

It may still be supported as an import mode.

### 11.2 Diarization for native rooms

Rejected because native room participants are already identified by their media producers.

Diarization adds unnecessary uncertainty where identity is known.

### 11.3 Mixed-room transcription only

Rejected because it loses speech that occurs underneath another speaker and creates attribution problems.

A mixed transcript may be useful as a comparison artifact, but it should not replace per-speaker source transcription.

### 11.4 Naive chronological transcript concatenation

Rejected because it falsely converts simultaneous speech into sequential dialogue.

Overlap must be represented explicitly.

### 11.5 Live transcription as the primary product

Deferred because the main value is the post-meeting transcript.

Live ASR forces latency and accuracy compromises and adds substantial complexity before the core value has been validated.

### 11.6 Live translation as an early requirement

Deferred because its product value is uncertain and its quality depends on provisional live transcription.

### 11.7 Real-time agents

Deferred.

The first system should produce excellent structured data for future agents rather than prematurely designing agent participation.

### 11.8 Building custom echo cancellation or codecs

Rejected.

Browsers and WebRTC already provide:

- Acoustic echo cancellation
- Noise suppression
- Automatic gain control
- Opus encoding
- Jitter buffering
- Packet-loss handling
- Secure media transport

The project should use those facilities rather than recreate digital telephony.

### 11.9 Building a custom SFU

Rejected.

Mediasoup already provides the required media routing and server-side stream access.

Building directly on Pion or another low-level WebRTC toolkit would turn the media server itself into the project.

### 11.10 Paying for a hosted LiveKit deployment

Rejected as a dependency.

LiveKit may remain useful as a design reference, but the desired deployment is self-hosted and should not require payment to LiveKit.

### 11.11 Jitsi as the primary stack

Rejected because it is closer to a complete conferencing product and is more opinionated than necessary for a narrow custom voice application.

### 11.12 Janus as the primary stack

Deferred unless SIP, RTP gateways, or traditional telephony integration become important.

Janus is compelling as a gateway, but mediasoup is a better fit for the proposed custom application.

### 11.13 Native mobile applications in the first version

Deferred.

The initial product should validate the concept in iPad Safari.

Native applications may later be required for:

- Reliable background operation
- Lock-screen integration
- Incoming call behavior
- Audio-session control
- Improved lifecycle management

---

## 12. Alternative Solutions Still Worth Supporting

### 12.1 Uploaded mixed recordings

The backend should eventually accept existing audio recordings.

This mode requires:

- Speaker diarization
- Speaker naming or correction
- Lower-confidence attribution
- Reuse of the same transcript compositor

This creates a useful fallback when other participants cannot or will not join the web application.

### 12.2 Client-rendered downstream recordings

A later version may record the downstream mix rendered for each participant.

This could help distinguish:

- Everything spoken
- Everything forwarded
- What a participant's browser rendered
- What was probably masked

This is not necessary for the first milestone.

### 12.3 Server-side delivery reconstruction

The server may retain:

- Which producers were subscribed
- Which packets were forwarded
- Audio level estimates
- Active-speaker state
- Packet loss and reception statistics

This can support an approximate “what each participant heard” view without immediately recording every client-rendered mix.

---

## 13. Initial Product Definition

The first product should be defined as:

> A self-hosted, browser-based, two-person voice room that produces an unusually accurate, overlap-aware, post-meeting transcript from separately recorded participant audio.

It should not initially be defined as:

- A Signal replacement
- A FaceTime replacement
- A Zoom replacement
- A multilingual calling platform
- A real-time AI meeting assistant
- A general telephony platform

---

## 14. Phased Implementation Plan

## Phase 1: Browser Call

Goals:

- Create room URL
- Join from two browsers
- Capture microphone
- Establish mediasoup transports
- Forward audio in both directions
- Support mute and leave
- Operate on iPad Safari in the foreground
- Use coturn where required

Success criteria:

- Two participants can converse reliably
- Connection state is visible
- Reconnection behavior is understandable
- No transcription is required

## Phase 2: Per-Speaker Recording

Goals:

- Create a recording consumer for every producer
- Store each participant independently
- Preserve Opus where possible
- Segment recordings into immutable chunks
- Record timeline metadata
- Survive participant reconnects

Success criteria:

- Every speaker has a separate playable recording
- Tracks align on a common room timeline
- Disconnects do not corrupt the entire recording
- Audio files can be reprocessed later

## Phase 3: Offline Per-Speaker Transcription

Goals:

- Transcribe each track independently
- Use high-accuracy offline decoding
- Preserve segment and word timing
- Include participant names and vocabulary
- Store transcript revisions
- Link transcript spans to source audio

Success criteria:

- Speaker identity is correct without diarization
- Technical terms can be improved through vocabulary or prompts
- The result is measurably better than a real-time pass
- Each utterance can seek to its underlying audio

## Phase 4: Conversation Compositor

Goals:

- Merge per-speaker transcripts
- Detect overlap intervals
- Represent interruptions
- Preserve continued speech underneath another speaker
- Produce a readable conversation transcript
- Produce a complete “everything said” view

Success criteria:

- Simultaneous speech is not presented as false sequence
- The transcript remains readable
- Masked or probably unheard speech is visibly distinguished
- Structured JSON preserves all underlying timing

## Phase 5: Transcript Quality

Goals:

- Add multiple offline passes
- Improve punctuation and segmentation
- Add domain vocabulary
- Compare alternate ASR results
- Mark uncertainty
- Support correction without overwriting provenance
- Create stable canonical transcript versions

Success criteria:

- Reprocessing can improve old meetings
- Corrections remain traceable
- Agents can cite stable utterance IDs
- Raw and normalized results remain available

## Phase 6: Mixed Recording Import

Goals:

- Upload speakerphone or legacy recordings
- Run diarization
- Allow speaker assignment
- Reuse the conversation compositor
- Compare mixed and native room quality

Success criteria:

- Imported recordings produce usable transcripts
- Native rooms remain visibly higher confidence
- The same transcript data model supports both sources

## Phase 7: Optional Live Features

Potential additions:

- Provisional live captions
- Partial transcript revisions
- Live translation
- Agent observation
- Real-time meeting search
- Participant-specific heard views

These should be added only after the post-meeting pipeline is strong.

---

## 15. Suggested First Milestone Scope

The first meaningful milestone should support:

```text
2 participants
voice only
foreground iPad Safari
desktop browser compatibility
shared room URL
mediasoup
coturn
separate Opus recording per participant
room-relative timing
offline transcription after call end
overlap-aware merged transcript
JSON export
Markdown or text export
```

Explicitly excluded:

```text
native mobile apps
background calling
video
screen sharing
live translation
real-time agents
large rooms
SIP
telephone numbers
advanced moderation
client-rendered heard recordings
```

---

## 16. Risks

### 16.1 iPad browser lifecycle

Safari may suspend or disrupt the session when:

- The screen locks
- The browser is backgrounded
- Another application takes microphone ownership
- The operating system reclaims resources

The first version should document and embrace the foreground-only constraint.

### 16.2 Timeline drift

Independent recording and transcription services can produce subtly different clocks.

A common room clock and explicit media timestamps are mandatory.

### 16.3 Recording reliability

Long-running RTP recording pipelines may fail, stall, or produce corrupt output.

Segmented immutable recording reduces the impact.

### 16.4 Overlap interpretation

Audio levels and active-speaker state can estimate dominance but cannot prove what a human actually understood.

The transcript must use language such as:

- Probably masked
- Likely dominant
- Possibly unheard
- Unknown

It should not claim subjective certainty.

### 16.5 Transcript normalization

LLM-based correction can introduce plausible but unsupported language.

The system should retain:

- Raw ASR
- Offline ASR
- Normalized transcript
- Human edits
- Provenance

Derived corrections should never destroy the underlying evidence.

### 16.6 Scope expansion

It will be tempting to add:

- Live captions
- Translation
- Agents
- Full conferencing controls
- Native apps

before the core recording and transcript system is validated.

The project should resist this until the post-meeting transcript is demonstrably valuable.

---

## 17. Recommended Technology Stack

```text
Client:
  TypeScript
  mediasoup-client
  WebSocket
  browser WebRTC APIs

Control plane:
  Node.js / TypeScript
  mediasoup
  custom signaling and room state

Media:
  mediasoup workers
  coturn
  GStreamer or FFmpeg recording workers

Transcription:
  Python
  faster-whisper
  offline GPU workers
  optional alignment and VAD tools

Storage:
  PostgreSQL
  S3-compatible object storage
  optional Redis

Outputs:
  canonical JSON
  readable Markdown
  plain text
  audio-linked transcript UI
```

---

## 18. Final Recommendation

Build the full application, but keep the first version narrow.

The initial objective is not to build a complete communications platform. It is to prove that browser-native, separately recorded participant streams produce a materially better meeting record than a single speakerphone recording.

The most important engineering sequence is:

```text
reliable room
    ↓
reliable per-speaker recording
    ↓
accurate offline transcription
    ↓
overlap-aware transcript composition
    ↓
agent-ready structured output
```

Live transcription, live translation, heard-view reconstruction, and real-time agents should remain optional later layers.

The enduring value of the system is not the SFU and not the speech model by themselves. It is the ability to preserve what every participant said, reconstruct the conversation honestly, identify what may have been masked, and expose the result as a durable, traceable record for humans and future agents.
