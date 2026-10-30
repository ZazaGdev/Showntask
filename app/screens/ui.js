// Small helpers shared by the screens.

// An element: h('button', { class: 'primary', onclick }, 'Save').
export function h(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'value') n.value = v;
    else if (k === 'style') n.style.cssText = v; // through the CSSOM, which the page's CSP allows
    else if (k === 'checked') n.checked = !!v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k);
  return n;
}

// A local file as a URL the page may load.
export const fileUrl = p => 'file:///' + String(p).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:');

export function clock(secs) {
  const t = Math.max(0, Math.floor(secs || 0)), hr = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60, two = n => String(n).padStart(2, '0');
  return hr ? `${hr}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

let toastTimer = null;
export function toast(text, bad = false) {
  const t = document.getElementById('toast');
  t.textContent = text; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 3000);
}

// A request to the main side; an { error } answer becomes a red toast and null.
export async function call(name, ...args) {
  const r = await window.api.call(name, ...args);
  if (r && typeof r === 'object' && !Array.isArray(r) && 'error' in r && Object.keys(r).length === 1) { toast(r.error, true); return null; }
  return r;
}

export const when = t => new Date(t).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export const STEP = { audio: 'Pulling out the sound', scenes: 'Looking for scene changes', chunks: 'Cutting the sound at pauses', transcript: 'Transcribing', frames: 'Saving frames' };

export function zoom(src) {
  const z = h('div', { class: 'zoom', onclick: () => z.remove() }, h('img', { src }));
  document.body.append(z);
}
