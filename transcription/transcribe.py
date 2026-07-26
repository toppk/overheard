#!/usr/bin/env python3
"""Offline per-speaker transcription for overheard recordings.

Usage:
    python transcription/transcribe.py recordings/<room-id> [--model small]

Reads recordings/<room-id>/metadata.json, transcribes each participant track
with faster-whisper, and writes:

    recordings/<room-id>/transcripts/tracks/<participant>.json   raw per-track ASR
    recordings/<room-id>/transcripts/canonical.json              merged, room-timeline utterances
    recordings/<room-id>/transcripts/conversation.md             readable transcript with overlap marks
"""

import argparse
import json
import sys
from pathlib import Path


def transcribe_track(model, audio_path: Path, offset_ms: int, speaker: dict) -> list[dict]:
    segments, _info = model.transcribe(
        str(audio_path),
        vad_filter=True,
        word_timestamps=True,
        beam_size=5,
    )
    utterances = []
    for i, seg in enumerate(segments):
        utterances.append(
            {
                "utterance_id": f"{speaker['participant_id']}_{i:04d}",
                "speaker_id": speaker["participant_id"],
                "speaker_name": speaker["display_name"],
                "start_ms": int(seg.start * 1000) + offset_ms,
                "end_ms": int(seg.end * 1000) + offset_ms,
                "text": seg.text.strip(),
                "words": [
                    {"w": w.word, "start_ms": int(w.start * 1000) + offset_ms, "end_ms": int(w.end * 1000) + offset_ms}
                    for w in (seg.words or [])
                ],
                "source_audio": {"file": speaker["file"]},
            }
        )
    return utterances


def split_utterances_at_events(utterances: list[dict], events: list[dict]) -> list[dict]:
    """Split utterances that span their own speaker's mute/unmute boundary.

    The recorded track plays silence while muted, so ASR happily bridges the
    gap and merges speech from either side of a mute into one segment. Word
    timestamps let us cut the segment back apart so events interleave where
    the words actually fell.
    """
    result = []
    for u in utterances:
        cuts = sorted(
            e["placed_ms"]
            for e in events
            if e["type"] in ("mute", "unmute")
            and e["participant_id"] == u["speaker_id"]
            and u["start_ms"] < e["placed_ms"] < u["end_ms"]
        )
        if not cuts or not u.get("words"):
            result.append(u)
            continue
        groups: list[list[dict]] = [[] for _ in range(len(cuts) + 1)]
        for w in u["words"]:
            mid = (w["start_ms"] + w["end_ms"]) / 2
            idx = sum(1 for c in cuts if mid >= c)
            groups[idx].append(w)
        pieces = [g for g in groups if g]
        if len(pieces) < 2:
            result.append(u)
            continue
        for i, words in enumerate(pieces):
            result.append(
                {
                    **u,
                    "utterance_id": f"{u['utterance_id']}_{chr(97 + i)}",
                    "start_ms": words[0]["start_ms"],
                    "end_ms": words[-1]["end_ms"],
                    "text": "".join(w["w"] for w in words).strip(),
                    "words": words,
                    "split_from": u["utterance_id"],
                }
            )
    return result


# ASR pads segment boundaries with silence, so consecutive turns graze each
# other by a few hundred ms without any real simultaneous speech. Only
# intersections at least this long count as overlap.
MIN_OVERLAP_MS = 500


def mark_overlaps(utterances: list[dict]) -> None:
    """Flag utterances that genuinely overlap another speaker's speech."""
    for u in utterances:
        u["overlapped"] = False
        u["overlaps_with"] = []
    for i, a in enumerate(utterances):
        for b in utterances[i + 1 :]:
            if b["start_ms"] >= a["end_ms"]:
                break
            if a["speaker_id"] == b["speaker_id"]:
                continue
            intersection = min(a["end_ms"], b["end_ms"]) - max(a["start_ms"], b["start_ms"])
            if intersection < MIN_OVERLAP_MS:
                continue
            a["overlapped"] = b["overlapped"] = True
            a["overlaps_with"].append(b["utterance_id"])
            b["overlaps_with"].append(a["utterance_id"])


def fmt_ts(ms: int) -> str:
    s = ms // 1000
    return f"{s // 60:02d}:{s % 60:02d}"


EVENT_PHRASES = {
    "join": "patches in",
    "leave": "drops the line",
    "mute": "silences their mic",
    "unmute": "opens their mic",
    "deafen": "goes deaf",
    "undeafen": "hears again",
}


def place_events(metadata: dict) -> list[dict]:
    """Place non-speech events on the room timeline.

    mute/unmute carry a client-claimed wallclock (client_time_ms) captured at
    the moment the track was toggled; when present, prefer it over server
    receipt time so the event lands where the audio actually changed. It is
    a claim, not an observation — both times are preserved in the output.
    """
    room_start_epoch_ms = None
    try:
        from datetime import datetime

        room_start_epoch_ms = int(
            datetime.fromisoformat(metadata["started_at"].replace("Z", "+00:00")).timestamp() * 1000
        )
    except (KeyError, ValueError):
        pass

    placed = []
    for ev in metadata.get("events", []):
        placed_ms = ev["room_time_ms"]
        if room_start_epoch_ms is not None and ev.get("client_time_ms"):
            claimed = ev["client_time_ms"] - room_start_epoch_ms
            # Sanity-check the claim: only trust it near the receipt time
            # (clock skew or a bogus client otherwise throws it off the map).
            if abs(claimed - ev["room_time_ms"]) < 10_000:
                placed_ms = claimed
        placed.append({**ev, "placed_ms": placed_ms})
    placed.sort(key=lambda e: e["placed_ms"])
    return placed


def render_markdown(room_id: str, utterances: list[dict], events: list[dict]) -> str:
    lines = [f"# Conversation transcript — room {room_id}", ""]
    items = [("u", u["start_ms"], u) for u in utterances] + [
        ("e", e["placed_ms"], e) for e in events
    ]
    # At equal timestamps, stage directions come before speech (you patch in
    # before you can be heard).
    items.sort(key=lambda i: (i[1], 0 if i[0] == "e" else 1))
    prev_speaker = None
    for kind, ts, item in items:
        if kind == "e":
            phrase = EVENT_PHRASES.get(item["type"], item["type"])
            lines.append(f"*[ {item['display_name']} {phrase} — {fmt_ts(ts)} ]*")
            lines.append("")
            prev_speaker = None  # re-introduce the next speaker after a stage direction
            continue
        u = item
        if u["speaker_name"] != prev_speaker:
            lines.append(f"**{u['speaker_name']}**")
        mark = " *[overlapping]*" if u["overlapped"] else ""
        lines.append(f"({fmt_ts(u['start_ms'])}) {u['text']}{mark}")
        lines.append("")
        prev_speaker = u["speaker_name"]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("room_dir", type=Path, help="recordings/<room-id> directory")
    parser.add_argument("--model", default="small", help="faster-whisper model size (default: small)")
    parser.add_argument("--language", default=None, help="force language code, e.g. en")
    args = parser.parse_args()

    metadata_path = args.room_dir / "metadata.json"
    if not metadata_path.exists():
        print(f"error: {metadata_path} not found", file=sys.stderr)
        return 1
    metadata = json.loads(metadata_path.read_text())

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("error: faster-whisper not installed. Run:", file=sys.stderr)
        print("  pip install -r transcription/requirements.txt", file=sys.stderr)
        return 1

    print(f"loading model '{args.model}'…")
    model = WhisperModel(args.model, compute_type="auto")

    out_dir = args.room_dir / "transcripts"
    (out_dir / "tracks").mkdir(parents=True, exist_ok=True)

    all_utterances: list[dict] = []
    for track in metadata["tracks"]:
        audio_path = args.room_dir / track["file"]
        if not audio_path.exists():
            print(f"warning: missing audio file {audio_path}, skipping", file=sys.stderr)
            continue
        print(f"transcribing {track['display_name']} ({audio_path.name})…")
        try:
            utterances = transcribe_track(model, audio_path, track["room_time_start_ms"], track)
        except Exception as err:  # noqa: BLE001 — a dead track must not sink the room
            print(
                f"warning: could not transcribe {audio_path.name} "
                f"({type(err).__name__}: {err}); skipping track",
                file=sys.stderr,
            )
            continue
        (out_dir / "tracks" / f"{track['participant_id']}.json").write_text(
            json.dumps(utterances, indent=2, ensure_ascii=False)
        )
        all_utterances.extend(utterances)

    events = place_events(metadata)
    all_utterances = split_utterances_at_events(all_utterances, events)
    all_utterances.sort(key=lambda u: u["start_ms"])
    mark_overlaps(all_utterances)

    canonical = {
        "room_id": metadata["room_id"],
        "started_at": metadata["started_at"],
        "ended_at": metadata["ended_at"],
        "utterances": all_utterances,
        "events": events,
    }
    (out_dir / "canonical.json").write_text(json.dumps(canonical, indent=2, ensure_ascii=False))
    (out_dir / "conversation.md").write_text(
        render_markdown(metadata["room_id"], all_utterances, events)
    )

    print(f"done: {len(all_utterances)} utterances, {len(events)} events")
    print(f"  {out_dir / 'canonical.json'}")
    print(f"  {out_dir / 'conversation.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
