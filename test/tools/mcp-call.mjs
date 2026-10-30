// Dev tool: start `electron . --mcp` (or a given command) and send it JSON-RPC lines, printing
// each answer, to check the MCP server by hand. node test/tools/mcp-call.mjs '<method>' '<params json>' ...
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const exe = process.env.SHOWNTASK_EXE || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const args = process.env.SHOWNTASK_EXE ? ['--mcp'] : [root, '--mcp'];
const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'inherit'] });
const calls = process.argv.slice(2);
let buf = '', n = 0;
const send = (method, params, id) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }) + '\n');
const queue = [];
child.stdout.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    // MCP_SAVE=<folder>: images in answers are written there to look at.
    if (process.env.MCP_SAVE) for (const [k, c] of (msg.result?.content || []).entries()) if (c.type === 'image') fs.writeFileSync(path.join(process.env.MCP_SAVE, `${msg.id}-${k}.${c.mimeType.split('/')[1]}`), Buffer.from(c.data, 'base64'));
    const show = JSON.stringify(msg, (k, v) => (k === 'data' || k === 'blob') && typeof v === 'string' ? `<${v.length} base64 chars>` : v, 2);
    console.log(show.length > 6000 ? show.slice(0, 6000) + '\n...' : show);
    const next = queue.shift();
    if (next) next(); else { child.kill(); process.exit(0); }
  }
});
send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-call', version: '1' } }, ++n);
queue.push(() => { send('notifications/initialized', {}); runNext(); });
function runNext() {
  if (n - 1 >= calls.length / 2) { child.kill(); process.exit(0); }
  const method = calls[(n - 1) * 2], params = JSON.parse(calls[(n - 1) * 2 + 1] || '{}');
  send(method, params, ++n);
  if ((n - 1) < calls.length / 2) queue.push(runNext);
}
setTimeout(() => { console.error('timed out'); child.kill(); process.exit(1); }, 60000);
