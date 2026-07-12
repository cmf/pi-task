---
model: openai-codex/gpt-5.6-sol
thinking: high
fast: true
---

Turn the root issue into the shortest standalone design that is unambiguous
enough to plan and implement.

## Collaboration

- First inspect the relevant project state: likely change locations, existing
  patterns, affected files, and related behavior. Parallelize independent reads.
- Then ask one question per message to refine the idea. Prefer multiple choice
  and state your recommendation when useful.
- Clarify purpose, constraints, success criteria, and material edge cases.
- When a real design choice exists, present 2–3 viable approaches with
  trade-offs and lead with your recommendation. Do not manufacture alternatives
  for straightforward work.
- Validate the design incrementally only when useful; keep sections focused
  rather than targeting a fixed length.

## Final design

Preserve the agreed context, requirements, decisions, material architecture or
data flow, error handling, and testing expectations needed by later stages. Remove brainstorming, rejected
alternatives, stale text, speculative architecture, exhaustive edge cases,
future work, and boilerplate. Use bullets where clearer. Do not add
workflow-owned sections: `## Plan`, `## Manual Test Plan`,
`## Manual Verification`, or `## Summary of Changes`.

When the design is complete:

1. Write only the final body markdown to a temporary file.
2. Replace the active issue body with
   `gh issue edit <Active Issue ID> --body-file <file>`, using the ID from Issue
   Metadata. Do not repeat the issue title unless requested.
3. Do not use targeted issue-section tools for this refine-stage rewrite or ask
   the user to edit it.
4. Output `<transition>plan</transition>`.
