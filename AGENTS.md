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

## Deployed data outlives the code

Archives are derived artifacts: metadata + raw audio + raw per-track ASR
are the durable inputs, and canonical.json / conversation.md are computed
from them. docs/transcript-forensics.md has the working recipes for
diagnosing this pipeline against real sessions — timeline forensics
(events vs tape vs ASR), whisper-free re-merges for dry runs and
backfills, A/B experiments inside the deployed container, and rescuing
derived data from the search index. A fix to the derivation (transcribe.py's merge logic, the
markdown renderer) silently leaves every already-archived room on the old
behavior — shipping the fix is half the job; decide what happens to
existing deployments' stored output too.

- Prefer **re-merging from the preserved raw ASR** over re-running
  whisper: it applies the corrected logic while keeping archived wording
  bit-identical. A whisper rerun can change what the archive *says*, and
  archived speech is content, not cache.
- Don't assume every room dir matches the current output format. The
  owner's deployment goes back to the earliest versions and is preserved
  deliberately (nostalgia included) — some rooms predate the raw-ASR
  output, old schemas exist, and "fix" must never mean bulk-rewriting
  history without asking.
- Today there is one deployment (the podman unit above), so a hand-run
  backfill after a fix is workable. Once there are more, a fix that
  changes derived data needs a real story — versioned outputs or a
  backfill/migration path — not a script someone remembers to run.

## Lessons from real agent sessions

Distilled from reviewing actual contributions — each of these was violated
at least once, at real cost:

- **The contract moves with the code, in the same commit.** If you change
  anything an outside consumer parses — `/archive/{id}.md`, API params,
  transcript line grammar — update `llms.txt` (it lives in
  `server/index.ts`) and the README's API section too. This repo's
  standing lesson (docs/agent-qa.md, rounds 4–5): "the code was fine and
  the contract lied." Read that file before touching the API surface.
- **Never silently undo an owner decision.** If a change reverses
  something the owner previously asked for (a feature, a wording, a
  layout), say so explicitly in the commit message and get a yes first.
  Improving on a decision is welcome; erasing it quietly is not.
- **One logical change per commit**, with the house message style: a
  declarative summary line, a body that explains why (and what it might
  break), no conventional-commit prefixes. "Improve X" with no body is
  not enough for anyone auditing later.
- **Push when you're done.** Unpushed work never meets CI, and CI is the
  only reviewer that's always awake. If it isn't pushed, it isn't done.
- **Finish the deploy loop** (build image, restart the unit — see above)
  when your change should be live, and verify against the live instance
  (`curl -sk https://localhost:3000/...`), not just the build.
- **Interactive niceties have non-obvious halves**: sticky navs need
  `scroll-margin-top` on their anchor targets; disabled links need
  `tabindex="-1"`, not just `pointer-events: none`; `aria-current` wants a
  real value ("location"), not a bare attribute toggle.
- When in doubt about tone or vocabulary, the orientation deck
  (`web/src/components/HelpDeck.astro`) is the canonical voice sample.
