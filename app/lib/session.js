// A recording's life, as a pure state machine:
// recording -> processing (one step at a time) -> ready; a failed step waits in failed until
// Retry. The main side applies events with next() and saves recording.json after each one, and
// each step writes its file before the next starts, so after a crash processing picks up at the
// first step whose file is missing.

// audio: audio.wav; scenes: frames/samples.bin; chunks: chunks/*.wav; transcript: transcript.json
// and transcript.md; frames: candidates.json, the frames and MAKE-TASKS.md.
export const STEPS = ['audio', 'scenes', 'chunks', 'transcript', 'frames'];

export function newRecording(id, at, extra = {}) {
  return { id, title: '', state: 'recording', startedAt: at, stoppedAt: null, duration: 0, step: null, done: [], error: null, ...extra };
}

// An imported video goes straight to processing.
export function imported(id, at, video, duration) {
  return { ...newRecording(id, at, { video, imported: true, duration }), state: 'processing', stoppedAt: at, step: STEPS[0] };
}

export function next(s, ev) {
  if (!s || !ev) return s;
  const to = patch => ({ ...s, ...patch });
  switch (`${s.state}:${ev.type}`) {
    case 'recording:stop':
    case 'recording:resume': // closed or crashed mid-recording: what was saved is processed
      return to({ state: 'processing', stoppedAt: ev.at ?? null, duration: ev.duration ?? s.duration, step: STEPS[0], done: [], error: null });
    case 'processing:stepDone': {
      if (ev.step !== s.step) return s;
      const done = [...s.done, s.step], i = STEPS.indexOf(s.step) + 1, extra = ev.patch || {};
      return i < STEPS.length ? to({ step: STEPS[i], done, ...extra }) : to({ state: 'ready', step: null, done, ...extra });
    }
    case 'processing:stepFailed':
      return ev.step === s.step ? to({ state: 'failed', error: String(ev.error || 'failed') }) : s;
    case 'failed:retry':
      return to({ state: 'processing', error: null });
    // Again from a step (a new Whisper model, say): that step and the ones after it are redone.
    case 'ready:redo':
    case 'failed:redo': {
      const i = STEPS.indexOf(ev.from);
      return i < 0 ? s : to({ state: 'processing', step: ev.from, done: s.done.filter(x => STEPS.indexOf(x) < i), error: null });
    }
    default:
      return s;
  }
}

// The recording processing should carry on with: the oldest one waiting in processing.
export const nextToProcess = list => (list || []).filter(s => s && s.state === 'processing').sort((a, b) => a.startedAt - b.startedAt)[0] || null;

// The words for a step, for the screens.
export const STEP_LABEL = {
  audio: 'Pulling out the sound', scenes: 'Looking for scene changes', chunks: 'Cutting the sound at pauses',
  transcript: 'Transcribing with Whisper', frames: 'Picking and saving frames',
};
