# Keep tasks tracked in Jira

All premium-explorer work items — bugs, features, chores — live in the pepsik
Jira (`https://pepsik-dev.atlassian.net`, project **EM**), under the epic
**EM-14** "[premium-explorer] VS Code extension for folder colors and explorer
styling".

- **Always use the pepsik Jira for this project** — the `mcp__claude_ai_pepsik__*`
  tools (cloudId `f3c3f0b7-d631-48a8-9267-101e498063cc`). Never the
  `atlassian-{work}` server: that is the work Jira and has nothing to do with
  this extension.

- **When the user reports a bug or asks for a feature**, create a Jira issue for
  it (type Bug/Task, `parent: EM-14`, label `premium-explorer`, assigned to the
  user) unless one already exists — search the epic's children first.
- **When starting work on something**, check whether a Jira issue covers it; if
  it doesn't, create one — and **transition the issue to In Progress** as soon as
  work on it begins. Reference the issue key when summarizing the work.
- **When the implementation is done** (coded, tested, in the working tree or
  released), comment the issue with what changed and **transition it to Review**.
- **Only the user moves work past Review**: transition to Done when they confirm
  the fix is verified on their machine (or they close it themselves).
- Write issue descriptions with substance: symptom, root cause if known (with
  `file:line` references), and a suggested fix or verification steps. A title
  alone is not a ticket.
- **Attach the user's screenshots to the issue** when they illustrate it: use
  `uploadAttachmentToJiraIssue` (phase 1 → run the returned `uploadCommand` via
  curl → embed with `inlineFileId`/`inlineFileCollection` in a comment; skip
  phase 2 when embedding inline).
- This covers tracking only — it does not change the no-unasked-commits rule or
  authorize releases.
