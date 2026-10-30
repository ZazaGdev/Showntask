// Ctrl held to draw and left clicks: the overlay never has the keyboard or the
// mouse while recording, so a small PowerShell loop reads Ctrl, whether another key is down with
// it, and the left mouse button from Windows itself, and prints a line each time that changes
// ("100": Ctrl alone, "110": Ctrl and another key, "001": the left button down). No native hook.
// It quits with the app, or when the recording ends.
import { spawn } from 'node:child_process';
import { keysLine } from '../lib/ctrl.js';

const SCRIPT = `
$k = Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);' -Name Keys -Namespace ShowntaskRec -PassThru
$skip = @(0x10, 0x11, 0x12, 0x5B, 0x5C) + (0xA0..0xA5)
$last = ''; $n = 0
while ($true) {
  $c = [int](($k::GetAsyncKeyState(0x11) -band 0x8000) -ne 0); $o = 0
  if ($c) { foreach ($v in 8..254) { if ($skip -contains $v) { continue }; if ($k::GetAsyncKeyState($v) -band 0x8000) { $o = 1; break } } }
  $m = [int](($k::GetAsyncKeyState(0x01) -band 0x8000) -ne 0)
  $s = "$c$o$m"
  if ($s -ne $last) { [Console]::Out.WriteLine($s); [Console]::Out.Flush(); $last = $s }
  if ((++$n % 60) -eq 0 -and -not (Get-Process -Id $env:SHOWNTASK_PID -ErrorAction SilentlyContinue)) { exit }
  Start-Sleep -Milliseconds 25
}`;

// onKeys({ ctrl, other, mouse }) on every change. Returns stop().
export function watchKeys(onKeys, log = () => {}) {
  let child, buf = '';
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { windowsHide: true, env: { ...process.env, SHOWNTASK_PID: String(process.pid) } });
  } catch (e) { log(`key watcher: ${e.message}`); return () => {}; }
  child.on('error', e => log(`key watcher: ${e.message}`));
  child.stdout.on('data', d => {
    buf += d;
    const lines = buf.split(/\r?\n/); buf = lines.pop();
    for (const l of lines) { const k = keysLine(l); if (k) onKeys(k); }
  });
  return () => { try { child.kill(); } catch { /* gone */ } };
}
