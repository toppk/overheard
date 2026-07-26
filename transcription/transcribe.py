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


def mark_overlaps(utterances: list[dict]) -> None:
    """Flag utterances that overlap in time with another speaker's speech."""
    for u in utterances:
        u["overlapped"] = False
        u["overlaps_with"] = []
    for i, a in enumerate(utterances):
        for b in utterances[i + 1 :]:
            if b["start_ms"] >= a["end_ms"]:
                break
            if a["speaker_id"] != b["speaker_id"]:
                a["overlapped"] = b["overlapped"] = True
                a["overlaps_with"].append(b["utterance_id"])
                b["overlaps_with"].append(a["utterance_id"])


def fmt_ts(ms: int) -> str:
    s = ms // 1000
    return f"{s // 60:02d}:{s % 60:02d}"


def render_markdown(room_id: str, utterances: list[dict]) -> str:
    lines = [f"# Conversation transcript — room {room_id}", ""]
    prev_speaker = None
    for u in utterances:
        mark = ""
        if u["overlapped"]:
            mark = " *[overlapping]*"
        header = f"**{u['speaker_name']}** ({fmt_ts(u['start_ms'])}){mark}"
        if u["speaker_name"] != prev_speaker or u["overlapped"]:
            lines.append(header)
        lines.append(f"{u['text']}")
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
        utterances = transcribe_track(model, audio_path, track["room_time_start_ms"], track)
        (out_dir / "tracks" / f"{track['participant_id']}.json").write_text(
            json.dumps(utterances, indent=2, ensure_ascii=False)
        )
        all_utterances.extend(utterances)

    all_utterances.sort(key=lambda u: u["start_ms"])
    mark_overlaps(all_utterances)

    canonical = {
        "room_id": metadata["room_id"],
        "started_at": metadata["started_at"],
        "ended_at": metadata["ended_at"],
        "utterances": all_utterances,
    }
    (out_dir / "canonical.json").write_text(json.dumps(canonical, indent=2, ensure_ascii=False))
    (out_dir / "conversation.md").write_text(render_markdown(metadata["room_id"], all_utterances))

    print(f"done: {len(all_utterances)} utterances")
    print(f"  {out_dir / 'canonical.json'}")
    print(f"  {out_dir / 'conversation.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
