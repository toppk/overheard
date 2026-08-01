# Purging an archive

Overheard has no archive-purge command yet. A sealed room exists in two
places:

1. `RECORDINGS_DIR/<room-id>/` is the durable source of truth: metadata,
   events, audio, transcription logs, raw ASR, and rendered transcripts.
2. `DB_PATH` is a rebuildable Turso/SQLite search index. It contains a copy of
   the rendered transcript, participant names, facets, and FTS data. The
   running server also keeps the recent-archive list in memory.

Deleting only the room directory therefore leaves a ghost in the stacks and
in participant facets until the index is reconciled. Restarting does not fix
that today: startup refreshes rooms found on disk but does not delete index
rows for rooms that disappeared.

For ordinary cleanup, removing a row from both index tables would make the
room logically unreachable. Do **not** rely on that for sensitive material.
SQLite-family databases can retain deleted content in free pages, indexes,
and the write-ahead log. The hard-purge procedure below discards the whole
derived index and rebuilds it from the remaining source directories.

## What “purged” means

This runbook provides an **application-level hard purge**. After it succeeds,
the running deployment cannot serve or search the room, and the live data
mount has no room source, copied transcript, or old index/WAL pages belonging
to it.

That is not the same as proving that no evidence ever existed. A room can
leave these traces outside the application data model:

- The current service journal records the exact room id, the creator's grid
  handle in lobby narration, in-room aliases, join/leave timing, ephemeral
  peer/transport ids, recording paths, call diagnostics, and transcription
  start/finish status. The server does **not** log audio or utterance text;
  the transcriber sends stdout/stderr only to the per-room `transcribe.log`,
  which is removed with the room.
- A literal room id typed in a shell command can remain in shell history. It
  is also briefly visible in a process argument when passed to `rm`, `curl`,
  or a positional-argument purge script. Host audit tooling may record those
  arguments or filesystem paths independently of shell history.
- Support tickets, chat/agent sessions used during an investigation, and
  command-execution tooling can retain the room id and any diagnostic output
  pasted or captured there.
- Browsers or agents that already fetched the archive may have caches or
  independent copies. Host/cloud backups, filesystem snapshots, exports, and
  transcript-forensics copies have their own retention policies.
- Unlinked file blocks may remain recoverable from the underlying storage.
  Whether physical erasure is possible depends on the filesystem, snapshots,
  encryption, SSD/TRIM behavior, and storage provider; deleting application
  files cannot promise forensic erasure.

Journald does not support deleting individual entries for one room. Vacuuming
journal files is a blunt retention action that also removes unrelated history.
For public deployments, reduce identifying data when it is written and set an
explicit retention window rather than expecting a later room purge to edit the
journal. Application controls for that are still TODO.

## Before starting

- Schedule a brief outage. Do not purge a hot construct or edit the index
  while the server is running.
- Record the exact room id. It must match `^[a-zA-Z0-9_-]+$`; never use a glob
  or a partial name.
- Avoid typing the literal id into a command line. For the current manual
  procedure, start a dedicated interactive shell with history disabled and
  read it from the terminal instead:

  ```sh
  set +o history
  IFS= read -r -s -p 'room id: ' PURGE_ROOM_ID
  printf '\n'
  case "$PURGE_ROOM_ID" in
    ''|*[!a-zA-Z0-9_-]*) echo 'invalid room id'; exit 2 ;;
  esac
  ```

  Do not export `PURGE_ROOM_ID`. Use it only in the carefully checked path and
  URL expansions below, then close that shell. This keeps the literal value
  out of ordinary shell history, but expanded child-process arguments can
  still expose it transiently. The planned purge tool will read the id on
  stdin and perform deletion and verification within one process. Its safe
  interactive shape is `overheard purge` followed by a TTY prompt—not a
  command such as `printf 'ROOM_ID' | overheard purge`, which merely moves the
  literal id into the producer command's argv and shell history.
- Locate the host data directory and configured paths instead of assuming the
  container defaults:

  ```sh
  podman inspect overheard --format \
    '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}{{range .Config.Env}}{{println .}}{{end}}'
  ```

  In the container deployment, `RECORDINGS_DIR` and `DB_PATH` usually resolve
  beneath the host directory mounted at `/data`.
- Decide what “purged” covers. This procedure removes the live source and live
  search index. Existing host/cloud backups, filesystem snapshots, exports,
  browser caches, or copies made for transcript forensics are separate copies
  and need their own retention/deletion action. Do not make a backup of a
  contaminated index as part of this procedure.

## Hard-purge procedure

The examples use absolute-path placeholders deliberately. Set the two
deployment paths from the inspected deployment, then validate every resolved
target before any deletion. Do not put the room id itself in these assignment
commands. Keep the service stopped until both the room and index have been
removed.

```sh
PURGE_RECORDINGS_ROOT=/absolute/data/recordings
PURGE_DB_PATH=/absolute/data/index/overheard.db
PURGE_ROOM_PATH="$PURGE_RECORDINGS_ROOT/$PURGE_ROOM_ID"

test "$(dirname -- "$PURGE_ROOM_PATH")" = "$PURGE_RECORDINGS_ROOT" || exit 2
test "$(basename -- "$PURGE_ROOM_PATH")" = "$PURGE_ROOM_ID" || exit 2
printf 'recordings root: %s\nindex: %s\n' \
  "$PURGE_RECORDINGS_ROOT" "$PURGE_DB_PATH"
```

1. Stop the service and confirm the container is down:

   ```sh
   systemctl --user stop container-overheard
   if systemctl --user is-active --quiet container-overheard; then
     echo 'ABORT: service is still active'
   else
     echo 'service is stopped'
   fi
   ```

   The generated unit can settle as either `inactive` or `failed` after its
   container receives SIGTERM; the important invariant is that it is not
   active and `podman ps --filter name=overheard` is empty.

2. Inspect the exact room target. If it still exists, check that it is one
   direct child of the recordings directory and that its `metadata.json`
   names the expected `room_id`. Then remove that one directory. For example:

   ```sh
   test -d "$PURGE_ROOM_PATH"
   test "$(jq -r .room_id "$PURGE_ROOM_PATH/metadata.json")" = "$PURGE_ROOM_ID"
   rm -rf -- "$PURGE_ROOM_PATH"
   test ! -e "$PURGE_ROOM_PATH"
   ```

   If the directory was already removed, the final absence check is enough.
   Never aim recursive removal at the recordings directory itself.

3. Inspect `DB_PATH` and remove the complete live index family while the
   service is stopped. With the default filename this means all three exact
   paths below; `-wal` and `-shm` may or may not exist:

   ```sh
   ls -l "$PURGE_DB_PATH" \
     "${PURGE_DB_PATH}-wal" \
     "${PURGE_DB_PATH}-shm"
   rm -f -- "$PURGE_DB_PATH" \
     "${PURGE_DB_PATH}-wal" \
     "${PURGE_DB_PATH}-shm"
   ```

   This is safe for application state only because the database is derived;
   all archives to retain must still have intact source directories.

4. Start the service. Startup creates a new index and repopulates it from the
   remaining recordings:

   ```sh
   systemctl --user start container-overheard
   podman logs overheard 2>&1 | tail -n 30
   ```

   Wait for `cold-storage index ready` and `overheard listening on`.

5. Verify the exact id without putting sensitive phrases into URLs or shell
   history:

   ```sh
   test ! -e "$PURGE_ROOM_PATH"

   curl -sk -o /dev/null -w '%{http_code}\n' \
     "https://localhost:3000/api/archives/$PURGE_ROOM_ID"

   curl -sk 'https://localhost:3000/api/archives?limit=100' |
     jq --arg room "$PURGE_ROOM_ID" 'any(.rows[]; .roomId == $room)'

   curl -sk -o /dev/null -w '%{http_code}\n' \
     "https://localhost:3000/recordings/$PURGE_ROOM_ID/metadata.json"
   ```

   Expected results are: source absent, archive API `404`, list membership
   `false`, and raw metadata `404`. If the deployment has more than 100 rooms,
   page through the list or query the database copy by exact room id.

   Do not use the HTML archive URL as the absence check. `/archive/ROOM_ID`
   serves the static archive shell with HTTP 200 even when its client-side API
   request subsequently returns 404.

6. Clear the current shell variable and exit the dedicated shell. If the
   literal id was typed before history was disabled, this does not remove that
   older entry: use the shell's history-removal workflow before exiting and
   remember that terminal/session-recording systems are separate stores.

   ```sh
   unset PURGE_ROOM_ID PURGE_ROOM_PATH PURGE_RECORDINGS_ROOT PURGE_DB_PATH
   exit
   ```

## Recovery after a filesystem-only deletion

If the room directory is already gone but it still appears in the stacks,
leave it gone and perform steps 1, 3, 4, and 5. No whisper rerun is involved:
the new index copies the existing `conversation.md` files for every remaining
room.

If the server fails during rebuild, keep the original room absent, inspect the
startup error, and leave the service stopped if necessary. Do not restore the
old index when it contains the material being purged; it is derived and may
retain the deleted transcript in its database or WAL pages.

## Public-deployment logging

Today, client call traces are mirrored to the server and the service logs
human-readable room ids and aliases. That is excellent for diagnosing live
call failures, but it makes journald a durable membership ledger even after an
archive purge. Until configurable logging lands, operators should treat the
journal as sensitive metadata and apply an intentional host-level retention
policy.

The product work must preserve the ability to debug carrier and transport
failures while offering a public-deployment profile that minimizes readable
identity: configurable trace logging, short retention, redacted or keyed
pseudonyms for room/operator/alias identifiers, and an explicit choice about
whether purge events themselves are auditable. Speech and transcript text
must remain forbidden from operational logs in every profile.
