// Spike page: sound to wav, frame sampling and seeking, all without ffmpeg.
const fs = require('node:fs');
const path = require('node:path');
const { ipcRenderer } = require('electron');
const { reader, open } = await import('../../app/lib/ebml.js');
const { wavHeader } = await import('../../app/record/media.js');

const q = new URLSearchParams(location.search);
const mode = q.get('mode'), file = q.get('file'), out = q.get('out') || path.dirname(file);
const log = s => ipcRenderer.send('log', `[${((performance.now()) / 1000).toFixed(1)}s] ${s}`);
const done = s => ipcRenderer.send('done', s);

function fileReader(f) {
  const fd = fs.openSync(f, 'r');
  return reader((pos, len) => { const b = new Uint8Array(len); return b.subarray(0, fs.readSync(fd, b, 0, len, pos)); }, fs.fstatSync(fd).size);
}

async function wav(r, m, track, to) {
  const fd = fs.openSync(to, 'w');
  fs.writeSync(fd, wavHeader(0));
  const n = await audioToPcm(r, m, track, pcm => fs.writeSync(fd, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)), t => log(`audio ${Math.round(t)}s`));
  fs.writeSync(fd, wavHeader(n), 0, 44, 0);
  fs.closeSync(fd);
  return n;
}

// 160 px wide grey pictures of the frames handed in, kept with their times.
function sampler(w, h) {
  const sw = 160, sh = Math.max(2, Math.round((160 * h) / w));
  const cv = new OffscreenCanvas(sw, sh), g = cv.getContext('2d', { willReadFrequently: true });
  const list = [];
  return {
    sw, sh, list,
    take(frame) {
      g.drawImage(frame, 0, 0, sw, sh);
      const d = g.getImageData(0, 0, sw, sh).data, grey = new Uint8Array(sw * sh);
      for (let i = 0; i < grey.length; i++) grey[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
      list.push({ time: frame.timestamp / 1e6, grey });
    },
    save(to) {
      fs.writeFileSync(to + '.json', JSON.stringify({ sw, sh, times: list.map(s => s.time) }));
      const all = new Uint8Array(list.length * sw * sh);
      list.forEach((s, i) => all.set(s.grey, i * sw * sh));
      fs.writeFileSync(to + '.bin', all);
    },
  };
}

// True when every slice in an H.264 AVCC frame is never referenced (a B-frame nothing waits on).
function nonRef(bytes) {
  let p = 0, slices = 0;
  while (p + 4 < bytes.length) {
    const n = (bytes[p] << 24 | bytes[p + 1] << 16 | bytes[p + 2] << 8 | bytes[p + 3]) >>> 0, h = bytes[p + 4], type = h & 31;
    if (type === 1 || type === 5) { slices++; if ((h >> 5) & 3) return false; }
    p += 4 + n;
  }
  return slices > 0;
}

async function mkv() {
  const t0 = performance.now(), r = fileReader(file), m = open(r), res = { file };
  const audio = m.tracks.find(t => t.kind === 'audio'), video = m.tracks.find(t => t.kind === 'video');
  res.tracks = m.tracks.length;
  // 1. Sound
  let t = performance.now();
  const n = await wav(r, m, audio, path.join(out, 'audio.wav'));
  res.wav = { samples: n, seconds: n / 16000, ms: Math.round(performance.now() - t) };
  log(`wav ${JSON.stringify(res.wav)}`);
  // 2. Index
  t = performance.now();
  const idx = videoIndex(r, m, video);
  res.index = { frames: idx.length, keys: idx.filter(f => f.key).length, ms: Math.round(performance.now() - t) };
  log(`index ${JSON.stringify(res.index)}`);
  // 3. Reference frames only (B-frames skipped), one sampled a second
  t = performance.now();
  const s = sampler(video.width, video.height);
  const { decodable, sampleSeconds } = await import('../../app/record/media.js');
  const list = decodable(r, video, idx);
  await sampleSeconds(r, video, list, f => s.take(f));
  res.sampled = { fed: list.length, samples: s.list.length, ms: Math.round(performance.now() - t) };
  s.save(path.join(out, 'secs'));
  log(`sampled ${JSON.stringify(res.sampled)}`);
  res.totalMs = Math.round(performance.now() - t0);
  done(res);
}

// Records `secs` seconds of a painted canvas and a tone with MediaRecorder, as the app will.
async function record() {
  const secs = Number(q.get('secs') || 60);
  const cv = document.getElementById('c'), g = cv.getContext('2d');
  const start = performance.now();
  const paint = () => {
    const s = (performance.now() - start) / 1000;
    g.fillStyle = `hsl(${Math.floor(s) * 6 % 360} 70% 45%)`; g.fillRect(0, 0, 1280, 720);
    g.fillStyle = '#fff'; g.font = 'bold 200px sans-serif'; g.fillText(String(Math.floor(s)), 100, 400);
  };
  const timer = setInterval(paint, 50);
  const ac = new AudioContext(), osc = ac.createOscillator(), dest = ac.createMediaStreamDestination();
  osc.connect(dest); osc.start();
  const stream = new MediaStream([...cv.captureStream(5).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 1_500_000, audioBitsPerSecond: 96_000, videoKeyFrameIntervalDuration: 2000 });
  const fd = fs.openSync(file, 'w');
  let q2 = Promise.resolve();
  rec.ondataavailable = e => { q2 = q2.then(async () => fs.writeSync(fd, new Uint8Array(await e.data.arrayBuffer()))); };
  rec.start(1000);
  await new Promise(res => setTimeout(res, secs * 1000));
  await new Promise(res => { rec.onstop = res; rec.stop(); });
  await q2; fs.closeSync(fd); clearInterval(timer);
  done({ recorded: file, bytes: fs.statSync(file).size });
}

// A long MediaRecorder WebM made seekable: decode every frame once, sampling one a second, then
// seek a <video> to random seconds and check the painted second matches.
async function webm() {
  const t0 = performance.now(), r = fileReader(file), m = open(r), res = { file, duration: m.duration };
  const video = m.tracks.find(t => t.kind === 'video'), audio = m.tracks.find(t => t.kind === 'audio');
  let t = performance.now();
  const n = await wav(r, m, audio, path.join(out, 'audio.wav'));
  res.wav = { samples: n, seconds: n / 16000, ms: Math.round(performance.now() - t) };
  log(`wav ${JSON.stringify(res.wav)}`);
  t = performance.now();
  const idx = videoIndex(r, m, video);
  res.index = { frames: idx.length, keys: idx.filter(f => f.key).length, ms: Math.round(performance.now() - t) };
  t = performance.now();
  const s = sampler(video.width, video.height);
  let nextSec = 0;
  const dec = videoDecoder(video, f => { const ts = f.timestamp / 1e6; if (ts >= nextSec) { s.take(f); nextSec = Math.floor(ts) + 1; } });
  for (const f of idx) await dec.decode(r, f);
  await dec.flush(); dec.close();
  res.sampled = { samples: s.list.length, ms: Math.round(performance.now() - t) };
  s.save(path.join(out, 'secs'));
  log(`sampled ${JSON.stringify(res.sampled)}`);
  // Seeking in a <video>
  const v = document.getElementById('v');
  v.src = 'file:///' + file.replace(/\\/g, '/');
  await new Promise((ok, bad) => { v.onloadedmetadata = ok; v.onerror = () => bad(new Error('video would not load')); });
  res.videoDuration = v.duration;
  const g = document.getElementById('c').getContext('2d', { willReadFrequently: true });
  const checks = [];
  t = performance.now();
  for (let i = 0; i < 40; i++) {
    const at = Math.floor(Math.random() * (v.duration - 5)) + 0.5;
    const s0 = performance.now();
    v.currentTime = at;
    await new Promise(res2 => { v.onseeked = res2; });
    g.drawImage(v, 0, 0, 1280, 720);
    const px = g.getImageData(10, 10, 1, 1).data;
    checks.push({ at, ms: Math.round(performance.now() - s0), rgb: [px[0], px[1], px[2]] });
  }
  res.seek = { n: checks.length, avgMs: Math.round((performance.now() - t) / checks.length), sample: checks.slice(0, 5) };
  res.totalMs = Math.round(performance.now() - t0);
  done(res);
}

// The candidates in <out>/candidates.json written as 1280 px JPEGs and 320 px thumbnails.
async function grab() {
  const { decodable, grabAt } = await import('../../app/record/media.js');
  const { clock } = await import('../../app/lib/transcript.js');
  const { openMedia } = await import('../../app/lib/demux.js');
  const t0 = performance.now(), r = fileReader(file), media = openMedia(r), video = media.tracks.find(t => t.kind === 'video');
  const list = decodable(r, video, media.frames(video));
  const cands = JSON.parse(fs.readFileSync(path.join(out, 'candidates.json'), 'utf8'));
  fs.mkdirSync(path.join(out, 'frames', 'thumbs'), { recursive: true });
  const jobs = [];
  let bytes = 0;
  const shot = async (cv, to) => { const b = new Uint8Array(await (await cv.convertToBlob({ type: 'image/jpeg', quality: 0.82 })).arrayBuffer()); bytes += b.length; fs.writeFileSync(to, b); };
  const n = await grabAt(r, video, list, cands.map(c => c.at), (f, t) => {
    const name = clock(t).replace(/:/g, '') + '.jpg';
    for (const [w, sub] of [[1280, ''], [320, 'thumbs']]) {
      const h = Math.round((w * f.displayHeight) / f.displayWidth / 2) * 2, cv = new OffscreenCanvas(w, h);
      cv.getContext('2d').drawImage(f, 0, 0, w, h);
      jobs.push(shot(cv, path.join(out, 'frames', sub, name)));
    }
  });
  await Promise.all(jobs);
  done({ candidates: cands.length, grabbed: n, files: jobs.length, mb: +(bytes / 1e6).toFixed(1), ms: Math.round(performance.now() - t0) });
}

try {
  await ({ mkv, record, webm, grab })[mode]();
} catch (e) { done({ error: String(e && e.stack || e) }); }
