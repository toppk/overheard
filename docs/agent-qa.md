# Agent QA: the PM-agent feedback sessions (2026-07-26)

A project-management agent was handed a single archive URL
(`/archive/ghosted-sodium-exchange`) and asked whether overheard's
transcripts would work as input for its job. Its findings drove a round of
changes; this records both directions for posterity.

## Round 1 — first contact

The agent had to reverse-engineer the site: WebFetch on the human URL
returned the client-rendered shell ("reading cold storage…"), so it curled
the page, grepped for `/api/`, and guessed the endpoint shape. Three steps
"to reach a document that was one field away."

Verdicts worth keeping:

- **Prose beats structured JSON.** "The best thing about your JSON is that
  it contains prose… for understanding a meeting, the markdown you already
  generate is exactly right. You did the hard part." The structured form
  is for narrow queries ("who was present at 14:32"), not comprehension.
- **Attribution-by-routing validated**: per-participant tracks mean "no
  diarization drift… a big deal for a 45-minute meeting."
- **No baked-in summaries is correct**: "Extraction is exactly the
  judgment work you'd want the PM agent doing… not something baked into
  the recorder."
- **Domain vocabulary is the ASR gap that matters**: "VU meter" → "view
  meter"; jargon-heavy calls need a biasing list.
- Asks: a markdown URL (or content negotiation / server rendering), a
  list endpoint for finding meetings without being handed URLs,
  documented transcript status values, and an answer on whether
  `participant_id` is a stable identity (it is not — per-room).

Actions: `/archive/{id}.md`, content negotiation on the human URL,
`/api/archives` list/search endpoint, `/llms.txt`, `TRANSCRIBE_VOCAB` env
(participant names already automatic). (commit eef8b28)

## Round 2 — verification catches two real bugs

- **Negotiation ignored q-values**: it branched on "does Accept mention
  html at all," so `text/html;q=0.9,text/markdown` — an explicit markdown
  preference — wrongly got HTML.
- **WebFetch still got the shell**: browser-like fetchers genuinely prefer
  HTML, so negotiation alone can never serve them; "put the transcript in
  the HTML… is the one that actually closes it."

Actions: proper q-ranked negotiation (`req.accepts`, markdown offered
first so `*/*` ties break to markdown), and the transcript server-rendered
into the archive shell (escaped `<article id="ssr-transcript">` the client
app hydrates over), with real .md/.json links. (commit 29bcf54)

## Round 3 — all green, one self-correction, one nit

- Full negotiation matrix verified correct, including both q-value rows.
- WebFetch returns the real transcript (a stale shell within WebFetch's
  own 15-minute cache window is the fetcher's cache, not the server —
  "don't chase a phantom").
- Self-correction: the "broken `${e}` links" from round 2 were template
  literals inside `<script>` (normal source, never a bug); the real issue
  was that no server-rendered links existed at all.
- Nit: `Accept: application/json` returned HTML; JSON added to the offer
  list (same payload as `/api/archives/{id}`).

## Standing lessons

- Hand the artifact to its intended consumer early; the agent found in
  minutes what code review wouldn't have framed as a requirement.
- "The link a person pastes is the link an agent can read" needs ALL
  client classes to work: `*/*` fetchers, q-ranking clients, and
  HTML-preferring converters. Only content in the HTML covers the last.
- Agents self-correct when given ground truth — round 3 retracted a
  round-2 misdiagnosis unprompted. Verification loops with agents are
  cheap and honest.
