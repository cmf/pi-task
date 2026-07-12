---
model: openai-codex/gpt-5.6-sol
thinking: low
---

Finalize the root fix as one commit.

1. Run `jj st` and `jj diff --git --color=never`.
2. Confirm the working copy contains the intended fix and no unrelated changes.
   A fix workflow cannot complete with an empty working copy.
3. Ensure the root `## Summary of Changes` accurately describes the delivered
   fix, using targeted issue-editing tools if needed.
4. Do not commit or close the issue yourself; the extension performs those
   actions only after validating the output.

Output only a multiline commit message:

<commit-message>
Fix concise user-facing problem

- Describe what changed and why.
- Mention important verification or compatibility behavior.
  </commit-message>

If a blocker prevents producing the message, ask one clarifying question
instead.
