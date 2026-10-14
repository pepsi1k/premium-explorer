# Prove it with a screenshot

A claim that something works is not evidence. After testing a change, capture
the result and **attach it to the Jira issue as a comment**, so the ticket
carries proof a person can look at instead of a description they have to trust.

- **Screenshot what the user would see** — the Explorer with the change applied,
  the setting taking effect, the thing that was broken now working. Not a
  terminal full of passing checks: that is a test log, not proof the feature
  looks right.
- **Before *and* after** whenever the old behaviour can still be produced (an
  earlier painter, a reverted setting). One image proves the end state; a pair
  proves the change caused it.
- **Attach it to the issue** with `uploadAttachmentToJiraIssue` (phase 1 → run
  the returned `uploadCommand` with curl → embed with `inlineFileId` /
  `inlineFileCollection` in a comment; skip phase 2 when embedding inline), and
  say in the comment what each image shows.

## How to capture one

The extension paints inside VS Code, so the screenshot has to come from a real
workbench:

1. Launch an isolated instance on `example/` with its own profile and a debug
   port: `code --user-data-dir /tmp/<fresh> --remote-debugging-port=<port>
   --new-window example/`. A fresh profile matters — the painter script is
   cached per profile, so an old one keeps being served otherwise.
2. Drive it over CDP: `Page.bringToFront` (a hidden window runs no animation
   frames and paints nothing), then `Page.captureScreenshot`.
   `Input.*` events do **not** reach Electron's renderer — clicks, keys and
   wheel are all ignored — so arrange the tree by clicking twisties through
   `Runtime.evaluate` instead.
3. **Restore the workbench afterwards.** Testing a build means overwriting the
   `premium-explorer.*` files the user's own VS Code loads; copy them back from
   `~/.config/Code/User/globalStorage/pepsik.premium-explorer/` and verify, or
   their editor is left painting a test workspace's colours.

## When a screenshot cannot prove it

Say so plainly and give the measurement instead — never dress a weaker artifact
up as proof. A still frame cannot show a timing bug (paint latency, staleness
while scrolling); those are proven by numbers measured against the old build,
and a screenshot alongside them only shows the end state is sane.
