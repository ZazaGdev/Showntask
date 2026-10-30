// The hidden worker page: records the picked area and the mic with MediaRecorder,
// appending each second to video.webm as it arrives so a crash keeps what was recorded, and runs
// the processing steps that need a page (WebCodecs): the sound to audio.wav, the scene samples,
// the candidate frames. The main side calls it through 'call' and gets one 'reply' per call.
// It has Node (a local page in a window nobody sees), so big files never cross IPC.
const fs = require('node:fs');
const path = require('node:path');
const { ipcRenderer } = require('electron');
const { reader } = await import('../lib/ebml.js');
const { openMedia, soundTrack, videoTrack } = await import('../lib/demux.js');
const { audioToPcm, wavHeader, decodable, sampleSeconds, grabAt } = await import('./media.js');
const { sceneChanges, candidates, nearest } = await import('../lib/candidates.js');
const { frameName, tileLabel } = await import('../lib/frames.js');
const { clock } = await import('../lib/transcript.js');
const { micLevel, micLit } = await import('../lib/area.js');

const MIME = 'video/webm;codecs=vp8,opus';
const progress = (id, what) => ipcRenderer.send('worker:progress', { id, ...what });

function fileReader(f) {
  const fd = fs.openSync(f, 'r');
  const r = reader((pos, len) => { const b = new Uint8Array(len); return b.subarray(0, fs.readSync(fd, b, 0, len, pos)); }, fs.fstatSync(fd).size);
  r.close = () => fs.closeSync(fd);
  return r;
}

// ---------- capture ----------
let cap = null;

// The display's track cut down to the area, frame by frame, with no canvas or timer, so a
// covered or minimised window does not slow it.
function cropped(track, source, crop) {
  const proc = new MediaStreamTrackProcessor({ track }), gen = new MediaStreamTrackGenerator({ kind: 'video' });
  const even = n => Math.floor(n / 2) * 2, stopper = new AbortController();
  const cut = new TransformStream({
    transform(frame, out) {
      try {
        const v = frame.visibleRect, k = v.width / source.width;
        const x = even(v.x + crop.x * k), y = even(v.y + crop.y * k);
        const width = Math.max(2, even(Math.min(crop.width * k, v.x + v.width - x))), height = Math.max(2, even(Math.min(crop.height * k, v.y + v.height - y)));
        out.enqueue(new VideoFrame(frame, { visibleRect: { x, y, width, height }, displayWidth: width, displayHeight: height }));
      } finally { frame.close(); }
    },
  });
  proc.readable.pipeThrough(cut, { signal: stopper.signal }).pipeTo(gen.writable, { signal: stopper.signal }).catch(() => { /* stopped */ });
  return { track: gen, end: () => { stopper.abort(); track.stop(); gen.stop(); } };
}

// A painted canvas and a tone, so the smoke run never records the owner's screen or voice.
function fakeStreams() {
  const cv = new OffscreenCanvas(640, 360), g = cv.getContext('2d');
  const shown = document.createElement('canvas'); shown.width = 640; shown.height = 360;
  const sg = shown.getContext('2d');
  let n = 0;
  const paint = setInterval(() => {
    g.fillStyle = `hsl(${(n++ * 40) % 360} 60% 40%)`; g.fillRect(0, 0, 640, 360);
    g.fillStyle = '#fff'; g.font = 'bold 120px sans-serif'; g.fillText(String(Math.floor(n / 5)), 40, 200);
    sg.drawImage(cv, 0, 0);
  }, 200);
  const ac = new AudioContext(), osc = ac.createOscillator(), dest = ac.createMediaStreamDestination();
  osc.connect(dest); osc.start();
  return { video: shown.captureStream(5).getVideoTracks()[0], voice: dest.stream, end: () => { clearInterval(paint); osc.stop(); ac.close(); } };
}

async function realStreams({ source, crop, mic }) {
  const screen = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
    chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, maxFrameRate: 5, maxWidth: source.width, maxHeight: source.height } } });
  const area = crop ? cropped(screen.getVideoTracks()[0], source, crop) : { track: screen.getVideoTracks()[0], end: () => {} };
  let voice = null;
  if (mic) {
    try { voice = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch (e) {
      area.end();
      throw new Error(`the mic could not be opened (${e.message})`);
    }
  }
  return { video: area.track, voice, end: () => { area.end(); if (voice) for (const t of voice.getTracks()) t.stop(); } };
}

// The mic's state for the bar: 'live' while it hears the owner, 'quiet', or 'muted'.
function micMeter(stream, isMuted) {
  const ac = new AudioContext(), an = ac.createAnalyser(), buf = new Float32Array(1024), track = stream.getAudioTracks()[0];
  an.fftSize = buf.length;
  ac.createMediaStreamSource(stream).connect(an);
  let lit = false, said = null;
  const tick = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    lit = micLit(micLevel(buf), lit);
    const now = isMuted() || (track && track.muted) ? 'muted' : lit ? 'live' : 'quiet';
    if (now !== said) { said = now; ipcRenderer.send('worker:voice', now); }
  }, 100);
  return () => { clearInterval(tick); ac.close(); };
}

const jobs = {
  async start({ dir, source, crop, mic, fake }) {
    if (cap) throw new Error('Already recording');
    const got = fake ? fakeStreams() : await realStreams({ source, crop, mic });
    const tracks = [got.video, ...(got.voice ? got.voice.getAudioTracks() : [])];
    // A silent track when the mic is off, so every recording has the same two tracks.
    let silent = null;
    if (!got.voice) { silent = new AudioContext(); tracks.push(silent.createMediaStreamDestination().stream.getAudioTracks()[0]); }
    const stream = new MediaStream(tracks);
    const rec = new MediaRecorder(stream, { mimeType: MIME, videoBitsPerSecond: 1_500_000, audioBitsPerSecond: 96_000, videoKeyFrameIntervalDuration: 2000 });
    const file = path.join(dir, 'video.webm');
    const c = { rec, got, silent, muted: false, queue: Promise.resolve(), meter: () => {} };
    rec.ondataavailable = e => {
      if (!e.data || !e.data.size) return;
      c.queue = c.queue.then(async () => fs.appendFileSync(file, new Uint8Array(await e.data.arrayBuffer())));
    };
    if (got.voice) c.meter = micMeter(got.voice, () => c.muted);
    rec.start(1000);
    cap = c;
    return { mime: MIME };
  },
  pause() { if (cap && cap.rec.state === 'recording') cap.rec.pause(); return true; },
  resume() { if (cap && cap.rec.state === 'paused') cap.rec.resume(); return true; },
  mute({ on }) {
    if (!cap || !cap.got.voice) return false;
    cap.muted = !!on;
    for (const t of cap.got.voice.getAudioTracks()) t.enabled = !on;
    return true;
  },
  async stop() {
    const c = cap;
    cap = null;
    if (!c) return false;
    if (c.rec.state !== 'inactive') await new Promise(res => { c.rec.onstop = res; c.rec.stop(); });
    await c.queue; // the last chunk is queued before onstop
    c.meter();
    for (const t of c.rec.stream.getTracks()) t.stop();
    c.got.end();
    if (c.silent) c.silent.close();
    return true;
  },

  // ---------- processing ----------
  // The video's sound to a 16 kHz mono wav, written beside as .part and renamed when whole.
  async audio({ id, video, wav }) {
    const r = fileReader(video);
    try {
      const media = openMedia(r), track = soundTrack(media);
      const fd = fs.openSync(wav + '.part', 'w');
      fs.writeSync(fd, wavHeader(0));
      let n = 0;
      if (track) n = await audioToPcm(r, track, media.frames(track), pcm => fs.writeSync(fd, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)), t => progress(id, { at: t, of: media.duration }));
      fs.writeSync(fd, wavHeader(n), 0, 44, 0);
      fs.closeSync(fd);
      fs.renameSync(wav + '.part', wav);
      return { samples: n, seconds: n / 16000, duration: media.duration, sound: !!track };
    } finally { r.close(); }
  },

  // One 160 px grey picture a second, for the scene check: samples.bin and samples.json.
  async scenes({ id, video, out }) {
    const r = fileReader(video);
    try {
      const media = openMedia(r), track = videoTrack(media);
      if (!track) throw new Error('The file has no video');
      const sw = 160, sh = Math.max(2, Math.round((160 * (track.height || 9)) / (track.width || 16)));
      const cv = new OffscreenCanvas(sw, sh), g = cv.getContext('2d', { willReadFrequently: true });
      const times = [], greys = [];
      await sampleSeconds(r, track, decodable(r, track, media.frames(track)), (f, ts) => {
        g.drawImage(f, 0, 0, sw, sh);
        const d = g.getImageData(0, 0, sw, sh).data, grey = new Uint8Array(sw * sh);
        for (let i = 0; i < grey.length; i++) grey[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
        times.push(ts); greys.push(grey);
      }, t => progress(id, { at: t, of: media.duration }));
      const all = new Uint8Array(greys.length * sw * sh);
      greys.forEach((x, i) => all.set(x, i * sw * sh));
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'samples.bin'), all);
      fs.writeFileSync(path.join(out, 'samples.json'), JSON.stringify({ sw, sh, times, width: track.width, height: track.height }));
      return { samples: times.length };
    } finally { r.close(); }
  },

  // The candidates picked and written as full frames and thumbnails in frames/. Returns them.
  async frames({ id, video, dir, lines, clicks, markers, width }) {
    const out = path.join(dir, 'frames');
    const meta = JSON.parse(fs.readFileSync(path.join(out, 'samples.json'), 'utf8')), bin = fs.readFileSync(path.join(out, 'samples.bin'));
    const px = meta.sw * meta.sh, samples = meta.times.map((time, i) => ({ time, grey: bin.subarray(i * px, (i + 1) * px) }));
    const r = fileReader(video);
    try {
      const media = openMedia(r), track = videoTrack(media);
      const list = candidates({ lines, clicks, markers, scenes: sceneChanges(samples), duration: media.duration, pictureAt: t => nearest(samples, t)?.grey });
      fs.mkdirSync(path.join(out, 'thumbs'), { recursive: true });
      fs.mkdirSync(path.join(out, 'tiles'), { recursive: true });
      const writes = [];
      const jpeg = async (cv, to) => fs.writeFileSync(to, new Uint8Array(await (await cv.convertToBlob({ type: 'image/jpeg', quality: 0.82 })).arrayBuffer()));
      let done = 0;
      const byTime = new Map(list.map(c => [c.at, c]));
      await grabAt(r, track, decodable(r, track, media.frames(track)), list.map(c => c.at), (f, t) => {
        const c = byTime.get(t), name = frameName(t), aspect = f.displayWidth / f.displayHeight;
        // Wide captures (two screens side by side) keep 720 px of height, so their text stays readable.
        const full = Math.min(f.displayWidth, Math.max(width, Math.round(720 * aspect)));
        for (const [w, sub] of [[full, ''], [320, 'thumbs']]) {
          const h = Math.max(2, Math.round(w / aspect / 2) * 2), cv = new OffscreenCanvas(w, h);
          cv.getContext('2d').drawImage(f, 0, 0, w, h);
          writes.push(jpeg(cv, path.join(out, sub, name)));
        }
        // The contact sheet's tile: the picture with its second and reason written under it.
        const tw = 320, th = Math.round(tw / aspect), tv = new OffscreenCanvas(tw, th + 22), g = tv.getContext('2d');
        g.drawImage(f, 0, 0, tw, th);
        g.fillStyle = '#18191d'; g.fillRect(0, th, tw, 22);
        g.fillStyle = '#ffffff'; g.font = '13px "Segoe UI", sans-serif'; g.textBaseline = 'middle';
        g.fillText(tileLabel({ ...c, at: t }, clock), 6, th + 11, tw - 12);
        writes.push((async () => fs.writeFileSync(path.join(out, 'tiles', frameName(t, 'png')), new Uint8Array(await (await tv.convertToBlob({ type: 'image/png' })).arrayBuffer())))());
        c.file = name;
        if (++done % 25 === 0) progress(id, { at: t, of: media.duration });
      });
      await Promise.all(writes);
      return list.filter(c => c.file);
    } finally { r.close(); }
  },

  // The length and tracks of a video, for Import: whether it can be read at all.
  probe({ video }) {
    const r = fileReader(video);
    try {
      const m = openMedia(r);
      return { kind: m.kind, duration: m.duration, tracks: m.tracks.map(t => ({ kind: t.kind, codec: t.codec, width: t.width, height: t.height })) };
    } finally { r.close(); }
  },
};

ipcRenderer.on('worker:call', async (e, { id, kind, args }) => {
  try {
    const value = await jobs[kind]({ id, ...(args || {}) });
    ipcRenderer.send('worker:reply', { id, ok: true, value });
  } catch (err) {
    ipcRenderer.send('worker:reply', { id, ok: false, error: String((err && err.message) || err) });
  }
});
ipcRenderer.send('worker:ready');
