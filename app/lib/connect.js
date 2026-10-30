// The Connect page's lines: how to add Showntask's MCP server to each agent. command is
// the program to start and args its arguments (["--mcp"] once installed; the app folder too
// when running from source).

const json = v => JSON.stringify(v, null, 2);
const quote = s => (/\s/.test(s) ? `"${s}"` : s);

export function connectLines(command, args = ['--mcp']) {
  const server = { command, args };
  const shell = [quote(command), ...args.map(quote)].join(' ');
  return [
    { agent: 'Claude Code', where: 'Run once in a terminal', text: `claude mcp add --scope user showntask -- ${shell}` },
    { agent: 'Codex CLI', where: 'Add to %USERPROFILE%\\.codex\\config.toml', text: `[mcp_servers.showntask]\ncommand = '${command}'\nargs = [${args.map(a => `'${a}'`).join(', ')}]` },
    { agent: 'Cursor', where: 'Add to %USERPROFILE%\\.cursor\\mcp.json (or the project\'s .cursor\\mcp.json)', text: json({ mcpServers: { showntask: server } }) },
    { agent: 'Claude Desktop', where: 'Add to %APPDATA%\\Claude\\claude_desktop_config.json, then restart Claude Desktop', text: json({ mcpServers: { showntask: server } }) },
    { agent: 'VS Code (Copilot agent mode)', where: 'Add to the project\'s .vscode\\mcp.json', text: json({ servers: { showntask: { type: 'stdio', ...server } } }) },
  ];
}
