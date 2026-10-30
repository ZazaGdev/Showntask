// One way into any video Showntask reads: its own WebM, OBS's MKV, or an imported MP4.
// open(r) gives { kind, duration, tracks, frames(track) }, frames being [{ time, key, pos, len }]
// in decode order, for reader r from lib/ebml.js.
import { open as openMkv, clusters, frames as framesOf } from './ebml.js';
import { isMp4, openMp4 } from './mp4.js';

export function openMedia(r) {
  if (isMp4(r)) {
    const m = openMp4(r);
    const lastTime = Math.max(0, ...m.tracks.map(t => (t.samples.length ? t.samples[t.samples.length - 1].time : 0)));
    return { kind: 'mp4', duration: m.duration || lastTime, tracks: m.tracks, frames: t => t.samples };
  }
  const m = openMkv(r);
  const cache = new Map();
  // One walk over the file fills the lists of the tracks used (the first video and the first
  // sound), so a 12 GB file is read once and OBS's other five sound tracks are not kept.
  const walk = () => {
    for (const t of [m.tracks.find(x => x.kind === 'video'), m.tracks.find(x => x.kind === 'audio')]) if (t) cache.set(t.number, []);
    for (const c of clusters(r, m)) for (const f of framesOf(r, m, c)) cache.get(f.track)?.push({ time: f.time, key: f.key, pos: f.pos, len: f.len });
  };
  const frames = t => { if (!cache.size) walk(); return cache.get(t.number) || []; };
  let duration = m.duration;
  if (duration === null) {
    for (const t of m.tracks) for (const f of frames(t)) if (f.time > (duration || 0)) duration = f.time;
  }
  return { kind: 'mkv', duration: duration || 0, tracks: m.tracks, frames, mkv: m };
}

// The track to transcribe: the first sound track, which OBS uses for the mix of everything.
export const soundTrack = media => media.tracks.find(t => t.kind === 'audio') || null;
export const videoTrack = media => media.tracks.find(t => t.kind === 'video') || null;
