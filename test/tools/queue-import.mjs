// Dev tool: queue videos for Import without the file dialog, so the app processes them at its
// next start (it carries on with every recording waiting in processing).
// node test/tools/queue-import.mjs <video> [title] ...pairs
import fs from 'node:fs';
import path from 'node:path';
import { loadSettings, rootOf, createFolder, save } from '../../app/lib/store.js';
import { imported } from '../../app/lib/session.js';

const args = process.argv.slice(2), root = rootOf(loadSettings());
for (let i = 0; i < args.length; i += 2) {
  const video = path.resolve(args[i]), title = args[i + 1] || path.basename(video).replace(/\.\w+$/, '');
  const { id, dir } = createFolder(root, new Date(fs.statSync(video).mtimeMs));
  save(dir, { ...imported(id, Date.now(), video, 0), title });
  console.log(`queued ${id}: ${title} -> ${dir}`);
}
