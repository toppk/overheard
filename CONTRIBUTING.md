# Contributing

Contributions are welcome from anyone. What matters here is the work:
patches, bug reports, design arguments, transcripts of things going wrong,
and agent QA sessions (see `docs/agent-qa.md` for the standard those have
set).

Practical notes:

- Open an issue or a PR; small and focused beats large and sweeping.
- CI must pass: typecheck, frontend build, the loopback recording test,
  and the Docker build (`npm run check`, `npm run build:web`,
  `npm run test:loopback` locally).
- Match what's here: the verb ladder and fiction are part of the product
  (see the orientation deck and README's conceptual model) — user-facing
  text should speak it; code and docs should stay plain and precise.
- Honesty rules the transcript pipeline: never make derived output
  overwrite source data, never present uncertainty as certainty, and
  never flatten simultaneous speech.
- Security findings: see SECURITY.md.

By contributing, you agree your contributions are licensed under the ISC
license (see LICENSE).
