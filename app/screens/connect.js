// Connect an agent: the exact line for each agent, with a copy button, and the plain
// warning that an agent's provider sees what it reads.
import { h, call, toast } from './ui.js';

export function connectPage() {
  const el = h('section', {}, h('h1', {}, 'Connect an agent'));
  call('connect').then(c => {
    if (!c) return;
    el.append(
      h('p', { class: 'muted' }, 'Showntask is also an MCP server. Add it to your agent once; then ask it to run the make-tasks prompt (in Claude Code: /mcp__showntask__make-tasks, or just "make tasks from my last Showntask recording").'),
      h('div', { class: 'card warn' }, h('b', {}, 'Privacy. '), 'Recordings stay on this PC. Once your agent reads one, its transcript and the frames it looks at go to that agent\'s AI provider, under your own terms with them. Delete private frames or spans first.'),
      ...c.lines.map(l => h('div', { class: 'card' },
        h('div', { class: 'bar' }, h('h3', {}, l.agent), h('span', { class: 'muted small grow' }, l.where),
          h('button', { onclick: async () => { if (await call('copy', l.text)) toast('Copied'); } }, 'Copy')),
        h('div', { class: 'code' }, l.text))),
      h('h2', {}, 'Agents without MCP, and browser chats'),
      h('p', { class: 'muted' }, 'Each recording\'s folder has MAKE-TASKS.md: any agent that can read files can follow it ("Copy prompt for my agent" on a recording). For claude.ai or ChatGPT in a browser, use "Export for chat" and upload the zip.'));
  });
  return { el };
}
