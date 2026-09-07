# Never commit, tag, push or publish unasked

Make the edits; **leave them in the working tree**. The user decides what gets
committed and when a release goes out — every time, per action.

- **Never run `git add`, `git commit`, `git tag`, or `git push`** unless the user
  says so in that message. "Fix X" is a request to change files, not to commit them.
- **Never start a release.** Only an explicit `/release` (or "release it now") does
  that, and it covers that one release only — not a follow-up fix afterwards.
- Approval does not carry forward. Having just been told to commit one change is
  not permission to commit the next one, however small or however related.
- A fix found on your own initiative — a CI tweak, a stray bug noticed in passing —
  is *more* likely to need asking, not less. It was not requested at all.
- When work is done, say what changed and what state it is in, and stop. Offer the
  commit; don't make it.
