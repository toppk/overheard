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

## Before starting

- Schedule a brief outage. Do not purge a hot construct or edit the index
  while the server is running.
- Record the exact room id. It must match `^[a-zA-Z0-9_-]+$`; never use a glob
  or a partial name.
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

The examples use placeholders deliberately. Substitute absolute host paths,
then print and inspect them before any deletion. Keep the service stopped
until both the room and index have been removed.

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
   ls -ld /absolute/data/recordings/ROOM_ID
   jq -r .room_id /absolute/data/recordings/ROOM_ID/metadata.json
   rm -rf -- /absolute/data/recordings/ROOM_ID
   test ! -e /absolute/data/recordings/ROOM_ID
   ```

   If the directory was already removed, the final absence check is enough.
   Never aim recursive removal at the recordings directory itself.

3. Inspect `DB_PATH` and remove the complete live index family while the
   service is stopped. With the default filename this means all three exact
   paths below; `-wal` and `-shm` may or may not exist:

   ```sh
   ls -l /absolute/data/index/overheard.db \
     /absolute/data/index/overheard.db-wal \
     /absolute/data/index/overheard.db-shm
   rm -f -- /absolute/data/index/overheard.db \
     /absolute/data/index/overheard.db-wal \
     /absolute/data/index/overheard.db-shm
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
   test ! -e /absolute/data/recordings/ROOM_ID

   curl -sk -o /dev/null -w '%{http_code}\n' \
     https://localhost:3000/api/archives/ROOM_ID

   curl -sk 'https://localhost:3000/api/archives?limit=100' |
     jq 'any(.rows[]; .roomId == "ROOM_ID")'

   curl -sk -o /dev/null -w '%{http_code}\n' \
     https://localhost:3000/recordings/ROOM_ID/metadata.json
   ```

   Expected results are: source absent, archive API `404`, list membership
   `false`, and raw metadata `404`. If the deployment has more than 100 rooms,
   page through the list or query the database copy by exact room id.

   Do not use the HTML archive URL as the absence check. `/archive/ROOM_ID`
   serves the static archive shell with HTTP 200 even when its client-side API
   request subsequently returns 404.

## Recovery after a filesystem-only deletion

If the room directory is already gone but it still appears in the stacks,
leave it gone and perform steps 1, 3, 4, and 5. No whisper rerun is involved:
the new index copies the existing `conversation.md` files for every remaining
room.

If the server fails during rebuild, keep the original room absent, inspect the
startup error, and leave the service stopped if necessary. Do not restore the
old index when it contains the material being purged; it is derived and may
retain the deleted transcript in its database or WAL pages.
