---
name: release
description: Cut a new Premium Explorer release — bump, tag, push, and watch it through Marketplace verification.
argument-hint: '[patch | minor | major | explicit version, e.g. 1.2.0]'
disable-model-invocation: true
allowed-tools: Bash(git status:*), Bash(git log:*), Bash(git diff:*), Bash(git tag:*), Bash(git add:*), Bash(git commit:*), Bash(git push:*), Bash(node:*), Bash(curl:*), Bash(pnpm:*), Read, Edit
---

## Release state

- Version in package.json: !`node -p "require('./package.json').version" 2>&1`
- Tags: !`git tag -l | tail -5 2>&1`
- Working tree: !`git status --short 2>&1 | head -20`
- Unpushed: !`git log --oneline origin/main..HEAD 2>&1 | head -10`
- Live on the Marketplace: !`curl -sS -m 20 -X POST "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery" -H "Accept: application/json;api-version=3.0-preview.1" -H "Content-Type: application/json" -d '{"filters":[{"criteria":[{"filterType":7,"value":"pepsik.premium-explorer"}],"pageNumber":1,"pageSize":100}],"flags":1}' 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const e=JSON.parse(s).results[0].extensions[0];console.log(e.versions.map(v=>v.version).join(', '));}catch(err){console.log('query failed');}})" 2>&1`

## Task

Ship a new version. Requested bump, if any: $ARGUMENTS

Releases are tag-driven: pushing a `v*` tag runs `.github/workflows/release.yml`,
which verifies the tag against `package.json`, packages, publishes with `vsce`,
waits for the Marketplace to finish verifying, then notifies Telegram.

1. **Pick a version above every published one.** The list above is authoritative —
   it comes from the gallery API, which returns validated versions only. A version
   that has ever been accepted **can never be republished or overwritten**, so a
   broken release is fixed by bumping, never by retrying.

2. **Bump `package.json` and update `CHANGELOG.md`** with what actually changed.
   The changelog ships inside the VSIX and is shown on the Marketplace listing.

3. **Commit.** The repo signs commits (`commit.gpgsign = true`). If signing fails
   because the passphrase isn't cached, **stop and hand the commit to the user** —
   do not reach for `--no-gpg-sign`, which quietly lands an unsigned commit in a
   signed history.

4. **Push `main` before the tag.** A tag pointing at a commit the remote doesn't
   have will check out the wrong tree in CI.

5. **Tag and push**: `git tag v<version> && git push origin v<version>`. The tag
   must equal `package.json` exactly — the workflow's first step fails the run
   otherwise, which is the intended guard, not a bug.

6. **Watch it land.** The workflow already polls, but to follow along locally:
   `node scripts/wait-for-marketplace.mjs pepsik.premium-explorer <version>`.
   Verification normally takes 3–8 minutes. Until it completes the Marketplace
   shows "Verifying" and the version is not installable.

## Traps

- **Never tag a version that was published by hand** with a local `vsce publish`.
  The upload will be rejected as a duplicate and the run reports a failed release.
- **A failed tag must be replaced, not reused.** Delete it both places —
  `git push --delete origin v<x>` and `git tag -d v<x>` — then bump and re-tag.
- **Required secrets**: `VSCE_PAT` (Azure DevOps, scope *Marketplace: Manage*,
  issued for **all accessible organizations**), plus `TELEGRAM_BOT_TOKEN` and
  `TELEGRAM_CHAT_ID`. A PAT scoped to one organization fails with an opaque 401.
- **`VSCE_PAT` expires.** When a release fails to authenticate, suspect expiry
  before suspecting the workflow.

## When done

Report the tag pushed, the workflow run URL, and whether the version is live yet.
If it's still verifying, say so — publishing is not the same as being installable.
