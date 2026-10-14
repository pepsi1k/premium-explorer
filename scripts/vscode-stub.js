// Minimal `vscode` API stub so the compiled generator (out/) can run in plain
// Node — enough for scripts/verify-example.js to bake the example workspace.
// Configured through env: PE_SETTINGS (JSON settings file), PE_WS (workspace
// folder). Not loaded by the extension itself.
const fs = require('fs');
const path = require('path');

const SETTINGS = JSON.parse(fs.readFileSync(process.env.PE_SETTINGS, 'utf8'));
const WS_ROOT = process.env.PE_WS;

class Uri {
  constructor(fsPath) { this.fsPath = fsPath; }
  static file(p) { return new Uri(p); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
}

module.exports = {
  Uri,
  workspace: {
    workspaceFolders: [{ uri: Uri.file(WS_ROOT), name: path.basename(WS_ROOT), index: 0 }],
    getConfiguration() {
      return {
        get(key, dflt) {
          const v = SETTINGS['premiumExplorer.' + key];
          return v === undefined ? dflt : v;
        },
      };
    },
    fs: {
      async createDirectory(uri) { fs.mkdirSync(uri.fsPath, { recursive: true }); },
      async writeFile(uri, data) { fs.writeFileSync(uri.fsPath, data); },
      async readFile(uri) { return fs.readFileSync(uri.fsPath); },
      async stat(uri) { return fs.statSync(uri.fsPath); },
      async readDirectory(uri) {
        return fs.readdirSync(uri.fsPath, { withFileTypes: true })
          .map(e => [e.name, e.isDirectory() ? 2 : 1]);
      },
    },
  },
  window: {
    async showInformationMessage() { return undefined; },
    async showWarningMessage() { return undefined; },
    async showErrorMessage() { return undefined; },
  },
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  ThemeColor: class {},
  FileDecoration: class { constructor(badge) { this.badge = badge; } },
  EventEmitter: class { get event() { return () => ({ dispose() {} }); } fire() {} dispose() {} },
};
