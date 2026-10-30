// Transcript rules:whisper.cpp's JSON to timed lines,
// the transcript Markdown, the recording folder's name, and the whisper-cli arguments.

const NOISE = /^[[(][^\])]*[\])]$/; // [BLANK_AUDIO], (music) and the like

// whisper-cli -oj output to [{ at, end, text }] in seconds, spoken lines only. shift moves every
// line on by that many seconds (a chunk cut from the middle of a long recording).
export function parseWhisper(j, shift = 0) {
  const segs = j && Array.isArray(j.transcription) ? j.transcription : [];
  return segs.map(x => ({
    at: Number(x && x.offsets && x.offsets.from) / 1000 + shift,
    end: Number(x && x.offsets && x.offsets.to) / 1000 + shift,
    text: String((x && x.text) || '').trim(),
  })).filter(l => l.text && !NOISE.test(l.text) && Number.isFinite(l.at));
}

const two = n => String(n).padStart(2, '0');

// Seconds as mm:ss, or h:mm:ss past an hour.
export function clock(secs) {
  const t = Math.max(0, Math.floor(secs)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

// Each line as [start-end] text, the form the agent reads.
export const timedLine = l => `[${clock(l.at)}${Number.isFinite(l.end) && l.end > l.at ? `-${clock(l.end)}` : ''}] ${l.text}`;

// The transcript file: a title, the video's path, then one timed line each.
export function transcriptMd(lines, { title, video }) {
  const body = lines.length ? lines.map(timedLine).join('\n') : 'Nothing was said.';
  return `# ${title}\n\nVideo: ${video}\n\n${body}\n`;
}

// A recording's folder name from the local time it started: 2026-10-16-0930.
export function folderName(d) {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
}

// %VAR% in a settings path, from env; a variable env does not have stays as written.
export function expandEnv(p, env) {
  const keys = Object.keys(env || {});
  return String(p || '').replace(/%([^%]+)%/g, (all, name) => {
    const k = keys.find(x => x.toLowerCase() === name.toLowerCase());
    return k ? env[k] : all;
  });
}

// whisper-cli on several wavs in one run (one model load): each one's timed JSON is written
// beside it as <wav>.json, nothing printed. lang 'auto' lets Whisper guess, which only a
// multilingual model can.
export const whisperArgs = ({ model, wavs, threads, lang = 'en' }) => ['-m', model, ...wavs.flatMap(w => ['-f', w]), '-l', lang || 'auto', '-t', String(threads), '-oj', '-np'];
