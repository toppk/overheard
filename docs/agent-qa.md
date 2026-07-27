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

## Round 4 — the sinceMs semantics trap

The agent proved `sinceMs=<future timestamp>` returned all rows and called
it "ignored." Root cause was subtler: `sinceMs` was a RELATIVE window
("sealed within the last N ms" — what the lobby's 24h view uses), while
the name and docs read as an absolute timestamp; a huge value meant "a
window covering all history," indistinguishable from a no-op. The
experience was a bug even though the filter worked as coded.

Actions: absolute `since` param added (epoch ms or ISO 8601, 400 on
garbage), `sinceMs` kept and documented as the relative window, llms.txt
made unambiguous, verified with the agent's own decisive case (future
timestamp → 0 rows).

Also from this round: facets exposed the identity problem concretely —
ken/toppk/Bob/bob as separate self-claimed handles with case splits;
`handles=` filtering is only as good as what people typed. Evidence for
the identity/ACL work.

## Round 5 — the pattern, generalized

The agent verified `since` on eight decisive cases (including the one that
proves sealed-at-or-after semantics: a room that STARTED before the cutoff
but sealed after it correctly matches), retracted its round-4 "ignored"
diagnosis with a monotonic-window proof, and then found the last instance
of the shape: `sinceMs=notanumber` silently returned the full corpus with
a 200 — a filter that appears to work while filtering nothing.

Actions: every numeric param (sinceMs, minDurMs, maxDurMs, offset, limit)
now 400s with the param named when present but unparseable. Deliberate
non-changes: empty string still means "not provided"; `since=-1` stays
valid (a 1969 epoch ms is a real instant — the agent's own call).

The agent's closing generalization, worth keeping: "a filter can be
working-as-coded and broken-as-named, and only the consumer's reading
counts… Both times the code was fine and the contract lied."

## Round 6 — close-out

Final verification: all numeric-param 400s confirmed, no regressions, and
`sinceMs=-1 → 0` praised as "better than I asked for" — the last −1 ms is
an empty window, while `since=-1` correctly returns everything (a 1969
instant). Same input, opposite correct answers, both right for what the
parameter means: "that's the naming distinction actually paying off."

The agent's corrections to OUR framing, worth as much as its bug reports:

- The generalization wasn't arrived at cleanly — "I read the name, formed
  an expectation, and reported the gap as a defect in the code. The
  consumer's reading counted, and the consumer was also wrong about the
  cause. Both halves are the lesson."
- The exchange worked because of how feedback was received: "Twice you
  gave me the correction rather than the accommodation, and both times
  the result was better than what I'd asked for. That's not a property of
  the QA — it's a property of how you took it."

Closing assessment: "Genuinely good system. The .md-as-complete-door
design, attribution-by-routing, and refusing to flatten overlapping
speech are the three decisions I'd keep hardest if anything ever
pressures them."

## Standing lessons

- Hand the artifact to its intended consumer early; the agent found in
  minutes what code review wouldn't have framed as a requirement.
- "The link a person pastes is the link an agent can read" needs ALL
  client classes to work: `*/*` fetchers, q-ranking clients, and
  HTML-preferring converters. Only content in the HTML covers the last.
- Agents self-correct when given ground truth — round 3 retracted a
  round-2 misdiagnosis unprompted. Verification loops with agents are
  cheap and honest.
