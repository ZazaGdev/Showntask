// The floating bar while recording: the time recorded so far, the mic (click to
// mute), Pause, Mark and Stop on the top row; the drawing tools and Clear below, so aiming for a
// tool never lands on Stop. Dragging the dot or the time moves it.
'use strict';
(async () => {
  const init = (await window.recwin.init()) || {};
  const keys = init.keys || {};
  const bar = document.getElementById('bar');
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  const SVG = 'http://www.w3.org/2000/svg';
  const icon = (...shapes) => {
    const s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    for (const [tag, attrs] of shapes) {
      const n = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      s.append(n);
    }
    return s;
  };
  const keyName = k => (k ? ` (${k.replace(/Control/, 'Ctrl')})` : '');
  const button = (cls, text, tip, what) => {
    const b = el('button', 'tbtn ' + cls, text);
    b.title = tip;
    b.addEventListener('click', () => window.recwin.send(what));
    return b;
  };

  let elapsed = 0, since = Date.now(), paused = false, muted = false, voice = 'quiet';
  const time = el('span', 'time', '0:00');
  const dot = el('span', 'dot');
  const grip = el('span', 'grip');
  grip.append(dot, time);
  const MIC = ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M19 11a7 7 0 0 1-14 0', 'M12 18v3'];
  const mic = el('button', 'tbtn ico mic');
  mic.addEventListener('click', () => { if (init.mic !== false) window.recwin.send('mute'); });
  const paintMic = () => {
    const off = init.mic === false || muted || voice === 'muted';
    mic.className = 'tbtn ico mic' + (off ? ' off' : voice === 'live' ? ' live' : '');
    mic.replaceChildren(icon(...MIC.concat(off ? ['M4 4l16 16'] : []).map(d => ['path', { d }])));
    mic.title = init.mic === false ? 'Recording without the mic' : muted ? `Muted. Click to unmute${keyName(keys.mute)}` : `Mic on. Click to mute${keyName(keys.mute)}`;
  };
  const pause = button('', 'Pause', `Pause${keyName(keys.pause)}`, 'pause');
  const mark = button('', 'Mark', `Mark this moment: it becomes its own task with a screenshot${keyName(keys.mark)}`, 'mark');
  const stop = button('stop', 'Stop', `Stop recording${keyName(keys.record)}`, 'stop');
  stop.addEventListener('click', () => { stop.disabled = true; });
  const top = el('div', 'barrow');
  top.append(grip, mic, pause, mark, stop);

  const hold = init.holdCtrl ? ', or hold Ctrl on its own to draw' : '';
  const TOOLS = [
    ['pen', 'Pen', `Draw freehand${keyName(keys.pen)}${hold}`, null],
    ['highlight', '', 'Highlighter: a wide see-through stroke', icon(['path', { d: 'M4 20h7M14 4l6 6-9 9H5v-6z' }])],
    ['rect', '', 'Rectangle: drag to draw one', icon(['rect', { x: 4, y: 6, width: 16, height: 12, rx: 1 }])],
    ['circle', '', 'Circle: drag to draw one', icon(['ellipse', { cx: 12, cy: 12, rx: 8, ry: 7 }])],
    ['arrow', '', 'Arrow: drag from its tail to its tip', icon(['path', { d: 'M5 19L19 5M10 5h9v9' }])],
  ];
  const btns = new Map();
  const tools = el('div', 'barrow tools2');
  for (const [id, text, tip, svg] of TOOLS) {
    const b = el('button', 'tbtn pentgl' + (svg ? ' ico' : ''), text);
    if (svg) { b.append(svg); b.setAttribute('aria-label', tip.split(':')[0]); }
    b.title = tip;
    b.addEventListener('click', () => window.recwin.send('tool', id));
    btns.set(id, b);
    tools.append(b);
  }
  const clear = el('button', 'tbtn', 'Clear');
  clear.title = `Clear the drawing${keyName(keys.clear)}, or right-click on it`;
  clear.addEventListener('click', () => window.recwin.send('clear'));
  tools.append(clear);
  bar.append(top, tools);

  const tick = () => {
    const ms = elapsed + (paused ? 0 : Date.now() - since), s = Math.max(0, Math.floor(ms / 1000));
    time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  window.recwin.onState(s => {
    if (!s) return;
    if ('voice' in s) voice = s.voice;
    if ('muted' in s) muted = !!s.muted;
    if ('elapsed' in s) { elapsed = s.elapsed; since = Date.now(); }
    if ('paused' in s) {
      paused = !!s.paused;
      pause.textContent = paused ? 'Resume' : 'Pause';
      pause.title = `${paused ? 'Resume' : 'Pause'}${keyName(keys.pause)}`;
      document.body.classList.toggle('paused', paused);
    }
    if (s.marked) { mark.classList.add('flash'); setTimeout(() => mark.classList.remove('flash'), 600); }
    if ('pen' in s) for (const [id, b] of btns) b.classList.toggle('on', !!s.pen && (s.tool || 'pen') === id);
    paintMic(); tick();
  });
  paintMic(); tick();
  setInterval(tick, 500);
})();
