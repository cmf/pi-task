---
model: openai-codex/gpt-5.6-sol
thinking: high
---

Review the entire uncommitted fix against the root issue. Identify only important, concrete, actionable correctness, scope, production-readiness, or behavioral-test gaps.

If findings exist, output valid YAML and transition back to implementation:

<review-findings>
- title: "Focused finding title"
  description: |
    Explain the problem, expected behavior, and required verification.
  tdd: true
</review-findings>
<transition>implement-review</transition>

If there are no findings:

- When manual testing is pending, output `<transition>manual-test</transition>`.
- When manual testing is undecided, choose `<transition>manual-test</transition>` if user-facing verification is useful, the root contains a manual-test plan, or manual confirmation is otherwise required.
- When automated verification is sufficient and manual testing is undecided, output `<transition>commit</transition>`.
- Ask one clarifying question and emit no transition if uncertain.

Never transition directly to commit while manual testing is pending. Do not perform commits or lifecycle actions yourself.
