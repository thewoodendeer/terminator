---
name: Killavic's Windows environment quirks
description: ELECTRON_RUN_AS_NODE=1 is set globally on this machine, and PowerShell needed RemoteSigned. Worth knowing on any future Electron/Node work here.
type: user
originSessionId: 02cecf55-e2a1-4018-94ce-f52e6c865791
---
Killavic's machine has two environment quirks that bite Node/Electron tooling:

1. **`ELECTRON_RUN_AS_NODE=1` is set in the user environment.** This makes Electron run any script as plain Node — `require('electron')` returns the binary path string instead of the API, crashing every real Electron app. The Terminator dev/start scripts now route through `scripts/run-electron.js` which strips it. If they ever try to run another Electron app or a fresh `electron .`, expect this to break it; the workaround is to spawn Electron from a Node script that deletes the var first, or run `[Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $null, 'User')` to remove it persistently.

2. **PowerShell ExecutionPolicy was Restricted by default.** This blocked `npm run dev` because `npm.ps1` couldn't execute. We set `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` once — should stick going forward, but if a fresh user account or shell complains about script execution, that's the fix.

**How to apply:** When debugging anything weird with Electron startup or `npm`/`pnpm` invocation on this machine, check these two before going deep on the project code.
