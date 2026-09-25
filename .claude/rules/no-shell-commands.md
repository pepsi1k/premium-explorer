# The extension never runs, copies or pushes shell commands

A permission problem is the user's to fix, deliberately, outside VS Code. The
extension explains it; it never acts on it.

- **Never run a command**: no `child_process`, no terminal creation or `sendText`,
  no task that escalates privilege, no password prompt.
- **Never copy one**: no "Copy Command" button, nothing written to
  `vscode.env.clipboard`.
- **A command may appear only as a read-only example** in the **Details** modal
  (`showFix()` in `src/injection.ts`), framed as optional — "if you choose to grant
  it, for example: …". Keep it to one line. Nowhere else: not in notifications,
  `PatchError` hints, `permissionHint()`, tooltips or output channels.
- **Never add new commands without being asked** — especially ones that need
  root/Administrator (`sudo`, `chown`, `icacls`, `takeown`, …). The existing
  `showFix()` examples are the only ones the user has approved.
- **Don't route around a permission the user hasn't granted.** Code may only write
  where the user has already given access; it must never try to escalate on its own.

**Why:** a VS Code extension that runs or pushes root commands is doing exactly what
malicious extensions do. The user does not want this extension to look, or be,
dangerous — explaining is fine, acting is not.
