# Transcript forensics

Recipes for diagnosing the recording/transcription pipeline, distilled
from real investigations (the mute-ordering bug, the overlap-mark noise,
the covert-translation bug). The theme of all of them: the durable
inputs — `metadata.json`, the ogg tracks, the raw per-track ASR — carry
enough provenance to reconstruct exactly what happened without guessing.

## Which side is lying: events or ASR?

Events are millisecond-accurate; whisper word timestamps drift up to ~1s
around silence gaps. When the transcript orders things impossibly, check
the tape before blaming the events:

- File time → room time: `room_ms = file_ms + track.room_time_start_ms`
  (the RTP-anchored offset in `metadata.json`).
- Find real speech edges:
  `ffmpeg -i track.ogg -af silencedetect=n=-35dB:d=0.4 -f null -`
  and map them into room time.
- Compare with the event stream. In the mute-ordering investigation the
  audio went silent within ~1 ms of the mute event's `claim_server_ms` —
  which proved the ASR word timing was the lie.

The mute gap is preserved in the file (duration ≈ room-time span), so
silence edges and events are directly comparable.

## Re-merge without re-running whisper

Everything after ASR — event placement, mute clamping, splitting,
overlap marking, markdown rendering — is pure python over
`transcripts/tracks/*.json`. To test a merge-layer change against real
sessions with the wording guaranteed identical:

```python
sys.path.insert(0, "transcription"); import transcribe
utts = [u for p in sorted(tracks_dir.glob("*.json"))
        for u in json.loads(p.read_text())]
events = transcribe.place_events(metadata)
transcribe.clamp_to_mute_silence(utts, events)
utts = transcribe.split_utterances_at_events(utts, events)
utts.sort(key=lambda u: u["start_ms"])
transcribe.mark_overlaps(utts)
md = transcribe.render_markdown(...)
```

Importing `transcribe` needs no faster-whisper (only `main()` does), so
this runs on the host. Use it for dry-run blast-radius checks ("which
archives would change?") before regenerating anything, and diff the
rendered markdown rather than eyeballing.

## A/B experiments against the deployed container

No image rebuild needed: `/data` is a bind mount, so stage a copy of the
room's inputs plus the experimental `transcribe.py` under `/data/exp/`
and run it with the container's venv:

```sh
podman exec overheard /app/.venv/bin/python \
    /data/exp/transcribe.py /data/exp/room --model small [--flags]
```

- The container shell is dash without `time`; wrap runs in
  `s=$(date +%s) … $(( $(date +%s) - s ))`.
- Whisper decoding (beam 5) is deterministic: a rerun with unchanged
  settings is byte-identical to the original, so any diff between two
  runs is exactly the flag under test — and "adopt the experiment
  output" equals "rerun in production".
- Word-level text diffing (difflib over per-speaker word lists from
  `canonical.json`) separates real wording drift from segment
  re-chunking, which markdown line diffs conflate.

## Rescuing derived data

The search index (`archives.transcript`) holds each room's
`conversation.md` as of the last server start — an accidental backup
when a bulk regeneration goes further than intended. The live file is
locked and its Turso FTS schema breaks stock `sqlite3`; copy the
`overheard.db*` files and read the copy with `@tursodatabase/database`
from the repo's node_modules.
