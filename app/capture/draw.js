// The drawing layer: sits exactly over the recorded area and is recorded with it.
// With drawing on, a drag draws with the tool picked on the bar: a red freehand line, a wide
// see-through highlighter, or a rectangle, circle or arrow from where the drag starts to where
// it ends. Everything stays until Clear or a right-click. A second canvas above it shows a soft
// spot under the cursor and a ring at each click, so a viewer can follow the mouse.
'use strict';
(() => {
  const INK = '#ff2b2b', WIDTH = 5, HEAD = 18;
  const cv = document.getElementById('ink'), g = cv.getContext('2d');
  const fx = document.getElementById('fx'), f = fx.getContext('2d');
  let pen = false, tool = 'pen', last = null, start = null, under = null, cursor = null;
  const rings = [];

  function fit() {
    const r = window.devicePixelRatio || 1, w = Math.round(innerWidth * r), h = Math.round(innerHeight * r);
    if (cv.width === w && cv.height === h) return;
    const keep = cv.width && cv.height ? g.getImageData(0, 0, cv.width, cv.height) : null;
    cv.width = fx.width = w; cv.height = fx.height = h;
    if (keep) g.putImageData(keep, 0, 0);
  }
  const style = kind => {
    const r = window.devicePixelRatio || 1;
    g.globalCompositeOperation = 'source-over';
    if (kind === 'highlight') { g.strokeStyle = 'rgba(255, 221, 0, 0.35)'; g.lineWidth = 22 * r; g.lineCap = 'butt'; }
    else { g.strokeStyle = INK; g.lineWidth = WIDTH * r; g.lineCap = 'round'; }
    g.lineJoin = 'round';
    return r;
  };
  function line(a, b) {
    const r = style('pen');
    g.beginPath(); g.moveTo(a.x * r, a.y * r); g.lineTo(b.x * r, b.y * r); g.stroke();
  }
  // A highlighter stroke is drawn whole on each move, so its overlaps do not darken.
  function path(kind, pts) {
    const r = style(kind);
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(p.x * r, p.y * r) : g.moveTo(p.x * r, p.y * r)));
    g.stroke();
  }
  function shape(kind, a, b) {
    const r = style(kind);
    const x = Math.min(a.x, b.x) * r, y = Math.min(a.y, b.y) * r, w = Math.abs(b.x - a.x) * r, h = Math.abs(b.y - a.y) * r;
    g.beginPath();
    if (kind === 'rect') g.rect(x, y, w, h);
    else if (kind === 'circle') g.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, 2 * Math.PI);
    else if (kind === 'arrow') {
      const ang = Math.atan2(b.y - a.y, b.x - a.x), tip = { x: b.x * r, y: b.y * r }, head = HEAD * r;
      g.moveTo(a.x * r, a.y * r); g.lineTo(tip.x, tip.y);
      for (const s of [-1, 1]) { g.moveTo(tip.x, tip.y); g.lineTo(tip.x - head * Math.cos(ang + s * Math.PI / 6), tip.y - head * Math.sin(ang + s * Math.PI / 6)); }
    }
    g.stroke();
  }
  const clear = () => { g.clearRect(0, 0, cv.width, cv.height); last = start = under = null; };

  let marks = null; // the highlighter's points so far
  document.addEventListener('pointerdown', e => {
    if (!pen) return;
    if (e.button === 2) { clear(); return; }
    if (e.button !== 0) return;
    const p = { x: e.clientX, y: e.clientY };
    if (tool === 'pen') { last = p; line(last, last); }
    else { start = p; under = g.getImageData(0, 0, cv.width, cv.height); if (tool === 'highlight') marks = [p]; }
    cv.setPointerCapture(e.pointerId);
  });
  document.addEventListener('pointermove', e => {
    if (!pen) return;
    const p = { x: e.clientX, y: e.clientY };
    if (last) { line(last, p); last = p; }
    else if (start) {
      g.putImageData(under, 0, 0);
      if (marks) { marks.push(p); path('highlight', marks); } else shape(tool, start, p);
    }
  });
  const up = () => { last = start = under = marks = null; };
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
  document.addEventListener('contextmenu', e => e.preventDefault());

  // The cursor's spot and the click rings, redrawn while there is something to show.
  let running = false;
  function frame() {
    const r = window.devicePixelRatio || 1, now = performance.now();
    f.clearRect(0, 0, fx.width, fx.height);
    if (cursor && !pen) {
      const grad = f.createRadialGradient(cursor.x * r, cursor.y * r, 0, cursor.x * r, cursor.y * r, 28 * r);
      grad.addColorStop(0, 'rgba(255, 214, 0, 0.35)'); grad.addColorStop(1, 'rgba(255, 214, 0, 0)');
      f.fillStyle = grad; f.beginPath(); f.arc(cursor.x * r, cursor.y * r, 28 * r, 0, 2 * Math.PI); f.fill();
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const k = (now - rings[i].t) / 600;
      if (k >= 1) { rings.splice(i, 1); continue; }
      f.strokeStyle = `rgba(255, 60, 60, ${1 - k})`; f.lineWidth = 3 * r;
      f.beginPath(); f.arc(rings[i].x * r, rings[i].y * r, (10 + 26 * k) * r, 0, 2 * Math.PI); f.stroke();
    }
    running = !!(rings.length || cursor);
    if (running) requestAnimationFrame(frame); else f.clearRect(0, 0, fx.width, fx.height);
  }
  const wake = () => { if (!running) { running = true; requestAnimationFrame(frame); } };

  window.recwin.onState(s => {
    if (!s) return;
    if ('tool' in s) tool = s.tool || 'pen';
    if ('pen' in s) { pen = !!s.pen; document.body.classList.toggle('pen', pen); if (!pen) up(); }
    if (s.clear) clear();
    if (Array.isArray(s.stroke)) for (let i = 1; i < s.stroke.length; i++) line(s.stroke[i - 1], s.stroke[i]);
    if ('cursor' in s) { cursor = s.cursor; wake(); }
    if (s.click) { rings.push({ ...s.click, t: performance.now() }); wake(); }
  });
  addEventListener('resize', fit);
  fit();
})();
