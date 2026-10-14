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
## Titles

Every issue's summary is **`[premium-explorer] <short plain title>`** — the
epic's own slug in brackets, exactly as the other epics do it (`[home-b14] Fix
the nightstand`, `[whoami] …`). The prefix is not optional; the board is shared
with every other epic and an unprefixed row is unreadable there.

Keep the title itself **short and in plain words** — what a person would say
out loud, not a summary of the investigation:

- *"Pills blink out while scrolling"*, not *"Styling wobbles ("jelly") while
  scrolling: pills/label styles drop out and lag behind the rows"*
- *"A rule with no colour paints grey"*, not *"Manual rule without
  rootBackgroundColor paints defaultColor gray instead of no fill"*

Setting names, file paths, measurements and design-section numbers belong in
the description, never in the title.

- Write issue descriptions with substance: symptom, root cause if known (with
  `file:line` references), and a suggested fix or verification steps. A title
  alone is not a ticket.
- **Attach the user's screenshots to the issue** when they illustrate it: use
  `uploadAttachmentToJiraIssue` (phase 1 → run the returned `uploadCommand` via
  curl → embed with `inlineFileId`/`inlineFileCollection` in a comment; skip
  phase 2 when embedding inline).

## The board, and who moves a task where

The project's statuses are **To Do → Approve → In Progress → Review → Done**.
Two of those moves are mine to make freely, and two are not.

- **To Do** — filed, not spoken for.
- **Approve** — *a proposal, not a work queue.* Move a task here to put it
  forward as worth doing. Being in Approve is **not** permission to start it:
  work begins only when the user says so, whoever moved it there.
- **In Progress** — move a task here as soon as actual work on it begins, and
  reference the issue key when summarizing that work. Check first that an issue
  covers what is being done; if none does, create one.
- **Review** — move a task here when the implementation is finished (coded,
  tested, in the working tree or released), with a comment saying what changed.
- **Done** — **never move a task out of Review on my own initiative.** Two
  things must both be true: the user has asked for the review, *and* I am
  certain the task is genuinely finished. If either is missing — including any
  doubt about whether it really works — it stays in Review and I say why.

## Keep it on the board, not in the backlog

A status change alone does not put a task on the board. **EM board** (id 3) is
a team-managed Kanban board with a backlog, and an issue created through the
API lands in the **backlog** — where it stays, carrying its new status, out of
sight. Anything past To Do (Approve, In Progress, Review) belongs on the board.

So every time a task is moved along, check where it actually is:

```
getJiraBoardIssueData  boardId 3, dataset "backlog",
                       jql: status in (Approve, "In Progress", Review)
```

and name anything it returns, in the reply, as still stranded in the backlog.

**The move itself cannot be made from here.** The Atlassian tools expose only
the backlog direction (`transitionJiraIssue` takes `assignToBacklog`, and
`sprintId` — which this board rejects, having no sprints); there is no
backlog → board operation in the catalogue, and no way to toggle a project
feature. So either drag it across in the UI, or turn **Backlog** off in
Project settings → Features, after which every issue is on the board and this
stops being a thing to remember.

Never report a task as "on the board" on the strength of the API: the board
dataset's own `returnHint` says it includes backlog issues, so it cannot tell
the two apart. Report where the backlog query puts it, or say it is unverified.

This covers tracking only — it does not change the no-unasked-commits rule or
authorize releases.
