// Whisper on the PC: whisper-cli from the whisper.cpp release and a model from the
// whisper.cpp Hugging Face repo, downloaded once into the speech folder and checked by SHA-256.
// This is the app's only network use.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { expandEnv } from './lib/transcript.js';
import { MODELS } from './lib/settings.js';

export const CLI = {
  tag: 'b5454',
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
  sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
};
export const MODEL_SHA = {
  'ggml-base.en-q5_1.bin': '4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f',
  'ggml-small.en-q5_1.bin': 'bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30',
  'ggml-small-q5_1.bin': 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
  'ggml-medium-q5_0.bin': '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f',
  'ggml-medium.en-q5_0.bin': '76733e26ad8fe1c7a5bf7531a9d41917b2adc0f20f2e4f5531688a8c6cd88eb0',
};
const modelUrl = name => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${name}`;

export const ownDir = () => path.join(process.env.APPDATA || '', 'Showntask', 'speech');

// whisper-cli.exe in dir or up to three folders below it.
export function findCli(dir, depth = 0) {
  const direct = path.join(dir, 'whisper-cli.exe');
  if (fs.existsSync(direct)) return direct;
  if (depth >= 3) return null;
  let subs = [];
  try { subs = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return null; }
  for (const d of subs) { const f = findCli(path.join(dir, d.name), depth + 1); if (f) return f; }
  return null;
}

// Where Whisper is for these settings: { cli, model, dir, missing: ['cli', 'model'] }. The
// setting's folder when there is one, else Showntask's own.
export function locate(settings) {
  const dir = settings.speechDir ? expandEnv(settings.speechDir, process.env) : ownDir();
  const cli = findCli(dir), model = path.join(dir, settings.model);
  return { cli, model, dir, missing: [...(cli ? [] : ['cli']), ...(fs.existsSync(model) ? [] : ['model'])] };
}

// One file downloaded to `to` through redirects, checked against sha256, written via a .part
// file so a cut-off download is never taken for a whole one. onBytes(done, total).
export function download(url, to, sha256, onBytes = () => {}, signal) {
  return new Promise((resolve, reject) => {
    const part = to + '.part';
    const get = (u, hops) => {
      const req = https.get(u, { headers: { 'User-Agent': 'Showntask' }, signal }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 8) {
          res.resume();
          return get(new URL(res.headers.location, u).href, hops + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Download failed: HTTP ${res.statusCode} for ${u}`)); }
        const total = Number(res.headers['content-length']) || 0, hash = crypto.createHash('sha256'), out = fs.createWriteStream(part);
        let done = 0;
        res.on('data', d => { hash.update(d); done += d.length; onBytes(done, total); });
        res.pipe(out);
        out.on('finish', () => {
          const got = hash.digest('hex');
          if (sha256 && got !== sha256) { fs.rmSync(part, { force: true }); return reject(new Error(`The download of ${path.basename(to)} did not match its checksum`)); }
          fs.renameSync(part, to);
          resolve(to);
        });
        res.on('error', reject);
        out.on('error', reject);
      });
      req.on('error', reject);
    };
    fs.mkdirSync(path.dirname(to), { recursive: true });
    get(url, 0);
  });
}

// Downloads what locate() found missing. onProgress({ what, done, total }).
export async function ensure(settings, onProgress = () => {}, signal) {
  let at = locate(settings);
  if (!at.missing.length) return at;
  if (at.missing.includes('cli')) {
    const zip = path.join(at.dir, `whisper-${CLI.tag}.zip`), into = path.join(at.dir, `whisper-${CLI.tag}`);
    await download(CLI.url, zip, CLI.sha256, (done, total) => onProgress({ what: 'Whisper', done, total }), signal);
    fs.mkdirSync(into, { recursive: true });
    // Windows 10 and 11 ship bsdtar, which reads zip files.
    await new Promise((res, rej) => execFile('tar', ['-xf', zip, '-C', into], { windowsHide: true }, e => (e ? rej(new Error(`Could not unpack Whisper: ${e.message}`)) : res())));
    fs.rmSync(zip, { force: true });
  }
  if (at.missing.includes('model')) {
    if (!MODELS[settings.model] || !MODEL_SHA[settings.model]) throw new Error(`Unknown Whisper model ${settings.model}`);
    await download(modelUrl(settings.model), at.model, MODEL_SHA[settings.model], (done, total) => onProgress({ what: settings.model, done, total }), signal);
  }
  at = locate(settings);
  if (at.missing.length) throw new Error('Whisper is still missing after the download');
  return at;
}
