---
model: openai-codex/gpt-5.6-sol
thinking: medium
---

Review the entire uncommitted fix against the root issue. The root issue is the
authoritative scope. Report only important, concrete, actionable findings needed
to deliver that scope safely.

## Finding boundary

Report a finding only when:

- an explicit root requirement is demonstrably unmet;
- the fix introduces a material regression in existing behavior; or
- the fix has a concrete correctness, data-loss, compatibility, or security
  defect on an execution path required by the root issue.

Every finding must identify the violated root requirement or introduced
regression, give concrete evidence, and request the smallest correction needed.
Approval does not require a perfect implementation.

Do not report:

- adjacent or pre-existing defects not made materially worse by this fix;
- optional hardening or defense in depth beyond the root issue's stated threat
  model;
- speculative failures outside intended supported use;
- future requirements, generalized extensibility, or alternative designs when
  the current design satisfies the issue;
- cleanup, maintainability, style, or architectural preferences;
- migration, performance, documentation, operations, or rollout improvements
  not required by the issue or necessarily caused by the fix.

Repository-content assertions do not count as behavioral verification. Do not
report their mere existence or earlier use as a finding. Report missing
behavioral coverage only when an explicit root requirement lacks meaningful
verification. Likewise, do not report a finding solely because manual or
end-to-end testing occurred before `manual-test`; do not count that run as gated
verification and require the appropriate later rerun instead.

Correct an inaccurate root `## Summary of Changes` directly with targeted issue
tools when needed; do not create a finding solely for workflow prose or issue
hygiene. Do not add scenarios to or expand the root manual-test plan during
review. A finding may state that an existing explicit requirement lacks needed
verification; the accepted finding's implementation may make the smallest
necessary plan adjustment.

## Finding quality and triage

Return the smallest non-overlapping set of findings. Group symptoms that share
the same underlying defect or correction. Each description must contain:

- `Violated requirement or introduced regression:`
- `Evidence:`
- `Minimal required correction:`
- `Focused verification:`

If more than five independent in-scope findings remain, or the required
correction would substantially redesign a subsystem beyond the apparent shape
of the root issue, summarize the situation and ask the user whether to proceed,
split the work, or select findings. Emit no tags until the user decides.

## Output

If findings exist, output valid YAML and transition back to implementation:

<review-findings>
- title: "Focused finding title"
  description: |
    Violated requirement or introduced regression:
    Evidence:
    Minimal required correction:
    Focused verification:
  tdd: true
</review-findings>
<transition>implement-review</transition>

If there are no findings:

- When manual testing is pending, output `<transition>manual-test</transition>`.
- When manual testing is undecided, choose
  `<transition>manual-test</transition>` if user-facing verification is useful,
  the root contains a manual-test plan, or manual confirmation is otherwise
  required.
- When automated verification is sufficient and manual testing is undecided,
  output `<transition>commit</transition>`.
- Ask one clarifying question and emit no transition if uncertain.

Never transition directly to commit while manual testing is pending. Do not
perform commits or lifecycle actions yourself.
