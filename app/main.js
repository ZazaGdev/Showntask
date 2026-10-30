// Showntask: record an area of the screen and your voice, transcribe it on the PC, keep
// candidate frames, and hand each recording to your own agent through the MCP server in the same
// exe. `Showntask.exe --mcp` starts no window: Electron's main process cannot read a stdio pipe on
// Windows, so it hands its stdio to a copy of itself run as plain Node (ELECTRON_RUN_AS_NODE).
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

if (process.argv.includes('--mcp')) {
  const child = spawn(process.execPath, [path.join(HERE, 'mcp', 'cli.js')], { stdio: 'inherit', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  const { app } = await import('electron');
  // This shell process only waits for the child: its own cache stays apart from the app's,
  // which may be running at the same time.
  app.setPath('userData', path.join(app.getPath('appData'), 'Showntask', 'mcp-shell'));
  app.disableHardwareAcceleration();
  child.on('exit', code => app.exit(code ?? 0));
  child.on('error', () => app.exit(1));
} else {
  await import('./app.js');
}
