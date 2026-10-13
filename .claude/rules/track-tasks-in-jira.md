# Keep tasks tracked in Jira

All premium-explorer work items — bugs, features, chores — live in the pepsik
Jira (`https://pepsik-dev.atlassian.net`, project **EM**), under the epic
**EM-14** "[premium-explorer] VS Code extension for folder colors and explorer
styling".

- **When the user reports a bug or asks for a feature**, create a Jira issue for
  it (type Bug/Task, `parent: EM-14`, label `premium-explorer`, assigned to the
  user) unless one already exists — search the epic's children first.
- **When starting work on something**, check whether a Jira issue covers it; if
  it doesn't, create one — and **transition the issue to In Progress** as soon as
  work on it begins. Reference the issue key when summarizing the work.
- **When work lands**, note it on the issue (comment or transition) — but only
  transition/close when the user confirms the fix is verified or released.
- Write issue descriptions with substance: symptom, root cause if known (with
  `file:line` references), and a suggested fix or verification steps. A title
  alone is not a ticket.
- This covers tracking only — it does not change the no-unasked-commits rule or
  authorize releases.
