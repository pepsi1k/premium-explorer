# Example workspace

Open this folder in VS Code (with Premium Explorer installed and background
painting enabled) to see every current feature configured, one folder per case —
edge bar directions and blends (EM-93), pill gradient fills (EM-98), and the
shared multi-stop Fill mechanics (EM-90, see [docs/fill-spec.md](../docs/fill-spec.md)),
plus two regression folders. The configuration lives in
[.vscode/settings.json](.vscode/settings.json).

The same settings double as the automated test fixture:

```bash
pnpm run compile-tests
node scripts/verify-example.js
```

bakes this workspace with the real generator (vscode API stubbed) and asserts
what reaches the painter for each folder.
