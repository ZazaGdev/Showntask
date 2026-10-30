// The prompt files in prompts/ filled in: {{name}} is a value, {{#name}}...{{/name}}
// shows only when the value is set, and <!-- mcp --> or <!-- files --> blocks are kept for one
// way of reading the recording (the MCP prompt, or MAKE-TASKS.md in the folder).

export function render(template, vars = {}, mode = 'mcp') {
  const other = mode === 'mcp' ? 'files' : 'mcp';
  return String(template)
    .replace(new RegExp(`<!-- ${other} -->[\\s\\S]*?<!-- /${other} -->\\n?`, 'g'), '')
    .replace(new RegExp(`<!-- /?${mode} -->\\n?`, 'g'), '')
    .replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (all, k, body) => (vars[k] ? body : ''))
    .replace(/\{\{(\w+)\}\}/g, (all, k) => (vars[k] ?? ''))
    .replace(/\n{3,}/g, '\n\n');
}
