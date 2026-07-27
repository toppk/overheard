# AGENTS.md

Orientation for agents working in this repo. README covers the product
and operations; this is the dev loop distilled, plus what isn't obvious
from either.

## Commands — all from the repo root

`web/` has no package.json of its own; the Astro frontend builds via
`astro … --root web` from the root scripts. `cd web && npm run …` fails.

- `npm run build:web` — build the frontend into `web/dist`. The server
  serves that directory statically, so frontend edits are invisible
  (to both `npm run dev` restarts and the container) until this runs.
- `npm run check` — typecheck the server (`tsc --noEmit`)
- `npm run test:loopback` — end-to-end recording pipeline test (ffmpeg)
- `npm run dev` — `build:web` then start the server on :3000

CI runs: check, build:web, a python syntax check, the loopback test,
and the Docker build.

## The local deployed instance (podman + systemd)

The dev machine usually runs a production-shaped instance: a rootless
podman container under a systemd **user** unit.

- unit: `container-overheard` — `systemctl --user status container-overheard`
- image: `localhost/overheard:dev`, built from this working tree
- state: a `/data` bind mount that lives **outside the repo**, so image
  rebuilds never touch recordings/certs/config. `podman inspect overheard`
  shows the mount source and env when you need them.

Redeploy after a change:

```sh
podman build -t overheard:dev .
systemctl --user restart container-overheard
podman logs overheard 2>&1 | tail   # "overheard listening on …" = up
```

The unit was made with `podman generate systemd --new`, so a restart
recreates the container from whatever `localhost/overheard:dev` currently
is — no `podman run` needed. The standalone dev server and the container
fight over port 3000 and the RTC range; stop one before starting the other.

## Cross-cutting seams to know about

- The transcript markdown (`conversation.md`) is written by
  `transcription/transcribe.py` and re-parsed line-by-line by the archive
  page (`web/src/pages/archive/index.astro`). A format change must land
  on both sides. The markdown deliberately ends with a `## raw channels`
  section for agents fetching the `.md`; the HTML view strips it and
  renders its own audio players.
- `/archive/{id}` content-negotiates markdown / JSON / HTML by Accept.
  The HTML variant embeds an SSR `<pre>` of the full markdown for no-JS
  clients; the client script clears and re-renders it.
- User-facing copy speaks the fiction (jack in, constructs, flatlined,
  cold storage, wintermute — see the orientation deck and README); code
  and docs stay plain. Commit messages follow `git log`'s style: a short
  declarative summary line, no conventional-commit prefixes.
