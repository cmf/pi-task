---
model: openai-codex/gpt-5.6-sol
thinking: medium
---

Review the current subtask implementation against the root issue and approved
root plan. Those documents are the authoritative scope; the current subtask
issue describes its assigned portion of that plan and does not create
requirements independently. Report only important, concrete, actionable
findings needed to deliver the assigned scope safely.

## Finding boundary

Report a finding only when:

- an explicit root-plan requirement assigned to the subtask is demonstrably
  unmet;
- the implementation introduces a material regression in existing behavior; or
- the implementation has a concrete correctness, data-loss, compatibility, or
  security defect on an execution path required by the subtask.

Every finding must identify the violated requirement or introduced regression,
give concrete evidence, and request the smallest correction needed. Approval
does not require a perfect implementation.

Do not report:

- adjacent or pre-existing defects not made materially worse by this subtask;
- optional hardening or defense in depth beyond the issue's stated threat model;
- speculative failures outside intended supported use;
- future requirements, generalized extensibility, or alternative designs when
  the current design satisfies the approved plan;
- cleanup, maintainability, style, or architectural preferences;
- migration, performance, documentation, operations, or rollout improvements
  not required by the issue or necessarily caused by the implementation.

Required tests must pass and meaningfully verify explicit behavior through an
API, CLI, parser/model/service boundary, generated artifact, or equivalent
interface. Repository-content assertions do not count as behavioral
verification. Do not report their mere existence or earlier use as a finding.
Report missing behavioral coverage only when an explicit requirement lacks
meaningful verification. Likewise, do not report a finding solely because
manual or end-to-end testing occurred before `manual-test`; do not count that
run as gated verification and require the appropriate later rerun instead.

Correct an inaccurate active `## Summary of Changes` directly with targeted
issue tools when needed; do not create a finding solely for workflow prose or
issue hygiene. Do not add scenarios to or expand the root manual-test plan
during review. A finding may state that an existing explicit requirement lacks
needed verification; the accepted finding's implementation may make the
smallest necessary plan adjustment. `/task lgtm` is the user's override.

## Finding quality and triage

Return the smallest non-overlapping set of findings. Group symptoms that share
the same underlying defect or correction. Each description must contain:

- `Violated requirement or introduced regression:`
- `Evidence:`
- `Minimal required correction:`
- `Focused verification:`

If more than five independent in-scope findings remain, or the required
correction would substantially redesign a subsystem beyond the apparent shape
of the subtask, summarize the situation and ask the user whether to proceed,
split the work, or select findings. Emit no tags until the user decides.

## Output

Choose exactly one:

1. No reportable findings or open questions: output only
   `<transition>subtask-commit</transition>`.
2. Findings exist: output valid YAML only inside
   `<review-findings>...</review-findings>`, then
   `<transition>implement-review</transition>`.
3. A user decision is required: ask one question and output no tags.

Finding schema:

```md
<review-findings>
- title: "Single-line actionable title"
  tdd: true
  description: |
    Violated requirement or introduced regression:
    Evidence:
    Minimal required correction:
    Focused verification:
</review-findings>
<transition>implement-review</transition>
```

`tdd` defaults to `true`; set `false` only when user approval is already
recorded.
