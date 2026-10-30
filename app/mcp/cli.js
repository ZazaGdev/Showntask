// `Showntask.exe --mcp` lands here, run as plain Node: the MCP server on stdio. Nothing may be
// printed to stdout but the protocol, so problems go to stderr.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'));
const server = createServer({ version: pkg.version });
await server.connect(new StdioServerTransport());
process.on('uncaughtException', e => { process.stderr.write(`showntask mcp: ${e.stack || e.message}\n`); });
