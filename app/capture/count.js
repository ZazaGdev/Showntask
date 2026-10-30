// The countdown before recording starts: 3, 2, 1 over the area.
'use strict';
(async () => {
  const init = (await window.recwin.init()) || {};
  const n = document.getElementById('n'), end = Date.now() + (init.secs || 3) * 1000;
  const tick = () => { n.textContent = String(Math.max(1, Math.ceil((end - Date.now()) / 1000))); };
  tick();
  setInterval(tick, 100);
})();
