// On-page sidebar: Autofill · Match · Track.
// Renders from JA.state and calls JA.actions; holds no job logic itself.
(() => {
  const JA = (window.__JA = window.__JA || {});
  if (JA.ui) return;

  const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pretty = (l) => { const t = String(l || '').replace(/\s*\*+\s*/g, ' ').trim(); return t ? t[0].toUpperCase() + t.slice(1) : '(unlabeled)'; };
  const VERDICT = { strong: ['Strong fit', '#16a34a'], good: ['Good fit', '#4f46e5'], fair: ['Fair fit', '#d97706'], low: ['Low fit', '#dc2626'] };
  const STATUSES = [['none', 'Not tracked'], ['saved', 'Saved'], ['applied', 'Applied'], ['interviewing', 'Interviewing'], ['offer', 'Offer'], ['rejected', 'Rejected']];

  const CSS = `
  :host { all: initial; }
  [hidden] { display: none !important; }
  * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .handle { position: fixed; right: 0; top: 38%; z-index: 2147483646; display: flex; flex-direction: column; align-items: center; gap: 2px;
    background: #4f46e5; color: #fff; border: 0; border-radius: 12px 0 0 12px; padding: 10px 7px 10px 9px; cursor: pointer;
    box-shadow: 0 6px 20px rgba(17,24,39,.25); font: 600 15px/1 system-ui; transition: transform .15s; }
  .handle:hover { transform: translateX(-2px); }
  .handle .sc { font: 700 11px/1 system-ui; background: #fff; color: #4f46e5; border-radius: 99px; padding: 3px 5px; margin-top: 4px; }
  .frame { position: fixed; top: 12px; right: 12px; bottom: 12px; width: 372px; max-width: calc(100vw - 24px); z-index: 2147483647;
    opacity: 0; visibility: hidden; transform: translateX(18px); transition: opacity .18s ease, transform .18s ease, visibility 0s linear .18s; }
  .frame.open { opacity: 1; visibility: visible; transform: none; transition: opacity .18s ease, transform .18s ease; }
  .frame.free { right: auto; bottom: auto; max-width: none; }
  .frame.moving { transition: none; }
  .frame.moving .panel { user-select: none; }
  .panel { position: absolute; inset: 0;
    background: #fff; color: #111827; border: 1px solid #e5e7eb; border-radius: 14px; box-shadow: 0 18px 50px rgba(17,24,39,.22);
    display: flex; flex-direction: column; overflow: hidden; font-size: 13px; line-height: 1.45; }
  .grip { position: absolute; z-index: 2; }
  .grip.l, .grip.r { top: 16px; bottom: 16px; width: 10px; cursor: ew-resize; }
  .grip.l { left: -5px; } .grip.r { right: -5px; }
  .grip.t, .grip.b { left: 16px; right: 16px; height: 10px; cursor: ns-resize; }
  .grip.t { top: -5px; } .grip.b { bottom: -5px; }
  .grip.tl, .grip.tr, .grip.bl, .grip.br { width: 18px; height: 18px; }
  .grip.tl { top: -6px; left: -6px; cursor: nwse-resize; } .grip.br { bottom: -6px; right: -6px; cursor: nwse-resize; }
  .grip.tr { top: -6px; right: -6px; cursor: nesw-resize; } .grip.bl { bottom: -6px; left: -6px; cursor: nesw-resize; }
  .grip.br::after { content: ""; position: absolute; right: 9px; bottom: 9px; width: 8px; height: 8px;
    border-right: 2px solid #c7cbd4; border-bottom: 2px solid #c7cbd4; border-bottom-right-radius: 3px; }
  header { padding: 12px 14px 10px; border-bottom: 1px solid #f0f1f3; cursor: move; touch-action: none; }
  header button, header .pill { cursor: pointer; }
  .top { display: flex; align-items: center; gap: 8px; }
  .brand { font-weight: 700; color: #4f46e5; font-size: 13px; }
  .top .sp { flex: 1; }
  .icon { border: 0; background: none; color: #9ca3af; font-size: 18px; cursor: pointer; padding: 0 2px; line-height: 1; }
  .icon:hover { color: #111827; }
  .job { margin-top: 8px; display: flex; gap: 10px; align-items: center; }
  .job .t { font-weight: 650; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .job .c { color: #6b7280; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .job .meta { min-width: 0; flex: 1; }
  .pill { font-size: 11px; font-weight: 700; border-radius: 99px; padding: 3px 8px; color: #fff; white-space: nowrap; }
  nav { display: flex; padding: 0 8px; border-bottom: 1px solid #f0f1f3; }
  nav button { flex: 1; border: 0; background: none; padding: 10px 4px 9px; font: 600 12.5px system-ui; color: #6b7280; cursor: pointer; border-bottom: 2px solid transparent; }
  nav button.on { color: #4f46e5; border-bottom-color: #4f46e5; }
  .body { flex: 1; overflow-y: auto; padding: 14px; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid #c7d2fe; background: #fff; color: #4f46e5;
    border-radius: 9px; padding: 8px 12px; font: 600 12.5px system-ui; cursor: pointer; text-decoration: none; }
  .btn:hover { background: #eef2ff; }
  .btn.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
  .btn.primary:hover { background: #4338ca; }
  .btn.block { width: 100%; padding: 10px 12px; font-size: 13px; }
  .btn:disabled { opacity: .6; cursor: default; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .muted { color: #6b7280; }
  .small { font-size: 12px; }
  .note { background: #f9fafb; border: 1px solid #f0f1f3; border-radius: 10px; padding: 10px 12px; color: #4b5563; margin-bottom: 12px; }
  .err { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; border-radius: 10px; padding: 10px 12px; margin: 10px 0; white-space: pre-wrap; }
  .spin { display: inline-block; width: 14px; height: 14px; border: 2px solid #c7d2fe; border-top-color: #4f46e5; border-radius: 50%; animation: s .8s linear infinite; vertical-align: -2px; }
  @keyframes s { to { transform: rotate(360deg); } }
  .working { display: flex; gap: 10px; align-items: center; padding: 12px; background: #eef2ff; border-radius: 10px; color: #3730a3; font-weight: 600; margin: 10px 0; }
  label.f { display: block; font-weight: 600; font-size: 12px; color: #374151; margin: 0 0 5px; }
  select, textarea, input.t { width: 100%; font: 13px system-ui; padding: 8px 9px; border: 1px solid #d1d5db; border-radius: 8px; background: #fff; color: #111827; }
  textarea { resize: vertical; min-height: 70px; }
  .sec { margin-top: 16px; }
  .sec h4 { margin: 0 0 7px; font-size: 11.5px; letter-spacing: .04em; text-transform: uppercase; color: #6b7280; font-weight: 700; display: flex; gap: 6px; align-items: center; }
  .count { background: #f3f4f6; color: #374151; border-radius: 99px; padding: 0 7px; font-size: 11px; letter-spacing: 0; }
  .item { display: block; width: 100%; text-align: left; border: 1px solid #f0f1f3; background: #fff; border-radius: 9px; padding: 8px 10px; margin-bottom: 6px; cursor: pointer; color: inherit; font: inherit; }
  .item:hover { border-color: #c7d2fe; background: #fafaff; }
  .item .q { font-size: 11.5px; color: #6b7280; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .item .v { font-size: 12.5px; color: #111827; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .item.rev { border-left: 3px solid #f59e0b; }
  .item.empty { border-left: 3px solid #ef4444; }
  .item .why { font-size: 11.5px; color: #b45309; margin-top: 2px; }
  .item .was { font-size: 11.5px; color: #6b7280; margin-top: 2px; text-decoration: none; }
  .ap { border-radius: 11px; padding: 10px 12px; margin-bottom: 12px; }
  .aph { display: flex; align-items: center; gap: 7px; }
  .aph .sp { flex: 1; }
  .apm { font-size: 12.5px; margin-top: 4px; color: #374151; }
  .apl { margin-top: 6px; font-size: 12px; color: #4b5563; }
  .apl summary { cursor: pointer; }
  .apl div { padding: 2px 0 0 10px; }
  .mini { border: 1px solid currentColor; background: #fff; color: inherit; border-radius: 7px; padding: 3px 10px; font: 600 12px system-ui; cursor: pointer; }
  .score { display: flex; gap: 14px; align-items: center; }
  .ring { width: 74px; height: 74px; border-radius: 50%; display: grid; place-items: center; flex: none; }
  .ring > div { width: 58px; height: 58px; border-radius: 50%; background: #fff; display: grid; place-items: center; font: 800 20px system-ui; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .chip { font-size: 11.5px; border-radius: 99px; padding: 3px 9px; border: 1px solid; }
  .chip.ok { background: #f0fdf4; border-color: #bbf7d0; color: #166534; }
  .chip.miss { background: #fffbeb; border-color: #fde68a; color: #92400e; }
  ul.l { margin: 0; padding-left: 17px; }
  ul.l li { margin-bottom: 5px; }
  .card { border: 1px solid #e5e7eb; border-radius: 11px; padding: 12px; margin-top: 10px; }
  .lrow { display: grid; grid-template-columns: 1fr auto auto; gap: 6px; align-items: center; padding: 7px 10px; border: 1px solid #f0f1f3; border-radius: 9px; margin-bottom: 6px; font-size: 12.5px; }
  .lrow a { color: #4f46e5; text-decoration: none; border: 1px solid #e0e7ff; border-radius: 99px; padding: 2px 8px; font-size: 11.5px; font-weight: 600; white-space: nowrap; }
  .lrow a:hover { background: #eef2ff; }
  .lrow .na { width: 1px; }
  details.more summary { cursor: pointer; color: #4f46e5; font-size: 12.5px; font-weight: 600; }
  details.more h4 { margin-top: 10px; }
  .pp-bar { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
  .pp-file { font-weight: 650; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pp-status { font-size: 11.5px; color: #6b7280; white-space: nowrap; }
  .pp-status.bad { color: #b91c1c; white-space: normal; }
  .paper { background: #fff; border: 1px solid #e5e7eb; box-shadow: 0 2px 10px rgba(17,24,39,.08); border-radius: 4px; padding: 22px 22px 18px;
    font: 10.5px/1.38 Helvetica, Arial, sans-serif; color: #1c1f26; }
  .paper .ce { outline: none; border-radius: 3px; padding: 0 1px; transition: background .1s; }
  .paper .ce:hover { background: #f5f7ff; }
  .paper .ce:focus { background: #eef2ff; box-shadow: 0 0 0 1px #c7d2fe; }
  .paper .ce:empty::before { content: attr(data-ph); color: #b6bcc8; }
  .pp-name { font-size: 20px; font-weight: 700; line-height: 1.15; }
  .pp-headline { color: #343d8c; font-size: 11.5px; margin-top: 2px; }
  .pp-contact { color: #5d6370; font-size: 9.5px; margin-top: 3px; }
  .pp-sec { margin-top: 10px; position: relative; }
  .pp-h { color: #343d8c; font-weight: 700; font-size: 10px; text-transform: uppercase; letter-spacing: .02em; border-bottom: 1px solid #d1d5de; padding-bottom: 3px; margin-bottom: 5px; }
  .pp-p { display: block; }
  .pp-b { font-weight: 700; }
  .pp-i { font-style: italic; color: #5d6370; font-size: 9.5px; }
  .pp-row { display: flex; justify-content: space-between; gap: 8px; font-size: 10.8px; }
  .pp-d { color: #5d6370; font-size: 9.5px; white-space: nowrap; }
  .pp-entry { position: relative; margin-bottom: 6px; border-radius: 4px; }
  .pp-entry:hover { box-shadow: 0 0 0 1px #eef0f4; }
  .pp-ul { margin: 2px 0 0; padding-left: 13px; }
  .pp-ul li { margin: 1px 0; }
  .pp-ul li::marker { color: #8b919c; }
  .pp-tools { position: absolute; top: -9px; right: -6px; display: none; gap: 2px; }
  .pp-entry:hover > .pp-tools { display: flex; }
  .pp-tools button { width: 18px; height: 18px; border: 1px solid #d1d5db; background: #fff; border-radius: 4px; font: 11px/1 system-ui; cursor: pointer; color: #4b5563; padding: 0; }
  .pp-tools button:hover { color: #4f46e5; border-color: #a5b4fc; }
  .pp-add { border: 1px dashed #c7d2fe; background: #fff; color: #4f46e5; border-radius: 6px; padding: 2px 8px; font: 600 10.5px system-ui; cursor: pointer; margin-top: 4px; opacity: 0; transition: opacity .12s; }
  .pp-add.sm { padding: 0 6px; margin: 0 0 0 4px; }
  .paper:hover .pp-add, .pp-add:focus { opacity: 1; }
  .pp-more { margin-top: 10px; display: flex; gap: 6px; }
  a.link { display: flex; justify-content: space-between; gap: 8px; padding: 8px 10px; border: 1px solid #f0f1f3; border-radius: 9px; margin-bottom: 6px; color: #111827; text-decoration: none; }
  a.link:hover { border-color: #c7d2fe; background: #fafaff; }
  a.link span:last-child { color: #4f46e5; }
  .foot { margin-top: 16px; display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
  .foot a { color: #6b7280; cursor: pointer; text-decoration: underline; }
  `;

  let host, root, frame, panel, handle, tab = 'autofill', isOpen = false;

  // ---------- position & size (remembered across sites) ----------
  const MINW = 300, MINH = 320;
  let geom = null; // null = docked on the right; else { left, top, width, height }
  function clampGeom(g) {
    const vw = innerWidth, vh = innerHeight;
    g.width = Math.min(Math.max(g.width, MINW), Math.max(MINW, vw - 8));
    g.height = Math.min(Math.max(g.height, MINH), Math.max(MINH, vh - 8));
    g.left = Math.min(Math.max(g.left, 0), Math.max(0, vw - g.width));
    g.top = Math.min(Math.max(g.top, 0), Math.max(0, vh - g.height));
    return g;
  }
  function applyGeom() {
    if (!frame) return;
    if (!geom) {
      frame.classList.remove('free');
      for (const k of ['left', 'top', 'width', 'height']) frame.style[k] = '';
      return;
    }
    clampGeom(geom);
    frame.classList.add('free');
    for (const k of ['left', 'top', 'width', 'height']) frame.style[k] = Math.round(geom[k]) + 'px';
  }
  const saveGeom = () => chrome.storage.local.set({ sidebarGeom: geom }).catch(() => {});

  function startMove(e, dir) {
    if (e.button !== 0) return;
    if (dir !== 'move') e.preventDefault();
    const r = frame.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, width: r.width, height: r.height };
    let active = dir !== 'move'; // header drags start after a few pixels, so clicks and double-clicks still work
    if (active) { frame.classList.add('moving'); frame.setPointerCapture(e.pointerId); }
    const move = (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!active) {
        if (Math.abs(dx) + Math.abs(dy) < 4) return;
        active = true;
        frame.classList.add('moving');
        frame.setPointerCapture(ev.pointerId);
      }
      const g = { left: start.left, top: start.top, width: start.width, height: start.height };
      if (dir === 'move') { g.left += dx; g.top += dy; }
      if (dir.includes('r')) g.width = start.width + dx;
      if (dir.includes('b')) g.height = start.height + dy;
      if (dir.includes('l')) { g.width = Math.max(MINW, start.width - dx); g.left = start.left + start.width - g.width; }
      if (dir.includes('t')) { g.height = Math.max(MINH, start.height - dy); g.top = start.top + start.height - g.height; }
      geom = g;
      applyGeom();
    };
    const up = () => {
      frame.classList.remove('moving');
      frame.removeEventListener('pointermove', move);
      frame.removeEventListener('pointerup', up);
      frame.removeEventListener('pointercancel', up);
      if (active) saveGeom();
    };
    frame.addEventListener('pointermove', move);
    frame.addEventListener('pointerup', up);
    frame.addEventListener('pointercancel', up);
  }

  const ui = (JA.ui = {
    mounted: false,
    mount() {
      if (host && host.isConnected) return;
      host = document.createElement('div');
      host.id = '__ja-root';
      root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${CSS}</style><button class="handle" title="Fillup">⚡<span class="sc" hidden></span></button>
        <div class="frame"><aside class="panel"></aside>${['l', 'r', 't', 'b', 'tl', 'tr', 'bl', 'br'].map((d) => `<div class="grip ${d}" data-dir="${d}"></div>`).join('')}</div>`;
      frame = root.querySelector('.frame');
      panel = root.querySelector('.panel');
      handle = root.querySelector('.handle');
      handle.onclick = () => ui.open();
      // Drag by the header, resize from any edge or corner, double-click the header to dock it back.
      frame.querySelectorAll('.grip').forEach((g) => g.addEventListener('pointerdown', (e) => startMove(e, g.dataset.dir)));
      panel.addEventListener('pointerdown', (e) => {
        if (e.target.closest('header') && !e.target.closest('button, a, select, input, textarea, .pill')) startMove(e, 'move');
      });
      panel.addEventListener('dblclick', (e) => {
        if (e.target.closest('header') && !e.target.closest('button')) { geom = null; applyGeom(); saveGeom(); }
      });
      addEventListener('resize', () => { if (geom) applyGeom(); });
      chrome.storage.local.get('sidebarGeom').then(({ sidebarGeom }) => { geom = sidebarGeom || null; applyGeom(); }).catch(() => {});
      // Typing in the sidebar shouldn't trigger the host page's keyboard shortcuts.
      for (const ev of ['keydown', 'keyup', 'keypress']) panel.addEventListener(ev, (e) => e.stopPropagation());
      document.documentElement.appendChild(host);
      ui.mounted = true;
      ui.render();
    },
    open(t) {
      ui.mount();
      if (t) tab = t;
      if (!['autofill', 'match', 'track'].includes(tab)) tab = 'autofill';
      isOpen = true;
      ui.render();
      requestAnimationFrame(() => frame.classList.add('open'));
      if (tab === 'match') A('analyzeIfNeeded');
    },
    close() {
      isOpen = false;
      if (frame) frame.classList.remove('open');
      ui.render();
    },
    toggle(t) { isOpen ? ui.close() : ui.open(t); },
    isWide: () => !!(geom && geom.width >= 600),
    toggleWide() {
      const r = frame.getBoundingClientRect();
      const w = ui.isWide() ? 372 : Math.min(760, innerWidth - 24);
      geom = { left: r.right - w, top: r.top, width: w, height: r.height };
      applyGeom();
      saveGeom();
    },
    get isOpen() { return isOpen; },
    render,
  });

  function A(name, ...args) { return JA.actions && JA.actions[name] && JA.actions[name](...args); }

  function render() {
    if (!ui.mounted || !panel) return;
    const s = JA.state;
    const relevant = s.isApp || s.isPosting || s.isAuth || isOpen;
    handle.hidden = isOpen || !relevant;
    const sc = handle.querySelector('.sc');
    if (s.analysis && s.analysis.fitScore != null) { sc.hidden = false; sc.textContent = s.analysis.fitScore; } else sc.hidden = true;
    if (!isOpen) return;

    // Don't redraw under the user while they're typing (notes, password form, the résumé).
    const active = root.activeElement;
    if (active && active.closest && (active.matches('textarea.notes, input.t') || active.closest('.paper')) && panel.querySelector('nav button.on')?.dataset.tab === tab) {
      ed.skipped = true;
      return;
    }

    const job = s.job || {};
    const a = s.analysis;
    const v = a && VERDICT[a.verdict];
    panel.innerHTML = `
      <header title="Drag to move · double-click to dock">
        <div class="top"><span class="brand">⚡ Fillup</span><span class="sp"></span>
          <button class="icon" data-a="settings" title="Settings">⚙</button>
          <button class="icon" data-a="close" title="Close">×</button></div>
        <div class="job"><div class="meta"><div class="t">${h(job.title || 'Job application')}</div>
          <div class="c">${h([job.company, job.location].filter(Boolean).join(' · '))}</div></div>
          ${a ? `<span class="pill" style="background:${v ? v[1] : '#4f46e5'}">${a.fitScore}% fit</span>` : ''}</div>
      </header>
      <nav>${[['autofill', 'Autofill'], ['match', 'Match'], ['track', 'Track']]
        .map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</nav>
      <div class="body">${({ autofill: tabFill, match: tabMatch, track: tabTrack })[tab || 'autofill']()}</div>`;
    wire();
  }

  // ---------- Autopilot ----------
  const AP = {
    running: ['#eef2ff', '#3730a3', 'Autopilot working'],
    idle: ['#eef2ff', '#3730a3', 'Autopilot on'],
    stopped: ['#fffbeb', '#92400e', 'Autopilot paused'],
    captcha: ['#fffbeb', '#92400e', 'Waiting for you'],
    ready: ['#f0fdf4', '#166534', 'Ready to submit'],
    done: ['#f0fdf4', '#166534', 'Done'],
  };
  function autopilotCard() {
    const s = JA.state, ap = s.ap;
    if (!ap || s.settings.autopilot === false) return '';
    const [bg, fg, title] = AP[ap.status] || AP.idle;
    const busy = ap.status === 'running';
    const canResume = ['stopped', 'captcha'].includes(ap.status);
    let out = `<div class="ap" style="background:${bg};color:${fg}">
      <div class="aph">${busy ? '<span class="spin"></span>' : ap.status === 'ready' || ap.status === 'done' ? '✓' : '🤖'} <b>${h(title)}</b><span class="sp"></span>
        ${canResume ? '<button class="mini" data-a="apResume">Resume</button>' : ['done', 'ready'].includes(ap.status) ? '' : '<button class="mini" data-a="apStop">Stop</button>'}</div>
      ${ap.message ? `<div class="apm">${h(ap.message)}</div>` : ''}
      ${ap.log && ap.log.length > 1 ? `<details class="apl"><summary>Steps (${ap.log.length})</summary>${ap.log.map((l) => `<div>${h(l.text)}</div>`).join('')}</details>` : ''}
    </div>`;
    if (s.isAuth) {
      out += `<div class="card" style="margin:0 0 12px">`;
      if (ap.account) {
        out += `<div class="small"><b>Account for ${h(location.host)}</b><br>${h(ap.account.email)}</div>
          <div class="row" style="margin-top:8px"><button class="btn" data-a="showPw">Show password</button><span class="pw small" style="font-family:ui-monospace,monospace"></span></div>`;
      } else {
        out += `<div class="small muted">No saved account for ${h(location.host)} yet.${ap.needsPassword ? '' : ' I\'ll create one when you reach the sign-up form.'}</div>`;
      }
      if (ap.needsPassword || !ap.account) {
        out += `<details ${ap.needsPassword ? 'open' : ''} style="margin-top:8px"><summary class="small" style="cursor:pointer;color:#4f46e5">Already have an account here? Save its password</summary>
          <input class="t" data-k="email" placeholder="Email" value="${h((s.profile && s.profile.email) || '')}" style="margin-top:8px">
          <input class="t" data-k="password" type="password" placeholder="Password" style="margin-top:6px">
          <button class="btn primary" data-a="savePw" style="margin-top:8px">Save &amp; sign in</button></details>`;
      }
      out += `</div>`;
    }
    return out;
  }

  // ---------- Autofill ----------
  function tabFill() {
    const s = JA.state, f = s.fill;
    if (!s.ready) {
      return `<div class="note">Set up your profile first: upload your résumé and the AI fills in the rest.</div>
        <button class="btn primary block" data-a="settings">Set up profile</button>`;
    }
    const resumeSel = s.resumes.length ? `<label class="f">Résumé for this job</label>
      <select data-a="resume">${s.resumes.slice().sort((x, y) => (y.tailoredFor && y.tailoredFor.key === (s.job || {}).key) - (x.tailoredFor && x.tailoredFor.key === (s.job || {}).key))
        .map((r) => `<option value="${h(r.id)}" ${r.id === s.resumeId ? 'selected' : ''}>${h(r.label ? `${r.label} — ${r.name}` : r.name)}</option>`).join('')}</select>` : '';
    let out = autopilotCard();
    if (s.paused) out += `<div class="note">Autofill is paused on ${h(location.host)}. <a class="link-inline" data-a="unpause" style="color:#4f46e5;cursor:pointer">Resume</a></div>`;
    if (!s.isApp && !s.isAuth && !(s.ap && ['ready', 'done', 'running'].includes(s.ap.status))) {
      out += `<div class="note">${s.isPosting ? 'This looks like a job posting. Check your fit in <b>Match</b>, then click Apply on the page; filling starts on the application form.' : 'No application form detected on this page.'}</div>`;
    }
    out += resumeSel;
    if (f.status === 'working') {
      out += `<div class="working"><span class="spin"></span>${h(f.note || `Filling ${f.count || ''} field${f.count === 1 ? '' : 's'}…`)}</div>`;
    } else {
      out += `<div style="margin-top:10px"><button class="btn primary block" data-a="fill">⚡ ${f.items.length ? 'Fill remaining fields' : s.isApp ? 'Autofill this page' : 'Autofill anyway'}</button></div>`;
    }
    if (f.status === 'error') out += `<div class="err">${h(f.error)}</div>`;
    if (f.report && f.status === 'done') {
      const r = f.report;
      out += `<p class="muted small" style="margin:10px 0 0">Filled ${r.filled} of ${r.asked} fields on the last run${r.corrected ? `, corrected ${r.corrected} the site had pre-filled` : ''}.${r.review ? ` <b>${r.review}</b> need a look.` : ''}</p>`;
    }
    const rev = f.items.filter((i) => i.review), ok = f.items.filter((i) => !i.review);
    const item = (i, cls) => `<button class="item ${cls}" data-field="${h(i.id)}"><div class="q">${h(pretty(i.label))}${i.entry ? ` · #${h(i.entry.split(' ')[0])}` : ''}</div>
      ${i.value != null ? `<div class="v">${h(i.value)}</div>` : ''}${i.was ? `<div class="was">Corrected · was: ${h(String(i.was).slice(0, 90))}</div>` : ''}${i.reason && cls === 'rev' ? `<div class="why">${h(i.reason)}</div>` : ''}</button>`;
    if (f.empty && f.empty.length) out += `<div class="sec"><h4>Still empty <span class="count">${f.empty.length}</span></h4>${f.empty.map((i) => item(i, 'empty')).join('')}</div>`;
    if (rev.length) out += `<div class="sec"><h4>Please review <span class="count">${rev.length}</span></h4>${rev.map((i) => item(i, 'rev')).join('')}</div>`;
    if (ok.length) out += `<div class="sec"><h4>Filled <span class="count">${ok.length}</span></h4>${ok.map((i) => item(i, '')).join('')}</div>`;
    out += `<div class="foot"><span class="muted">Your edits are remembered when you submit.</span>${s.paused ? '' : '<a data-a="pause">Pause on this site</a>'}</div>`;
    return out;
  }

  // ---------- Match: fit score + the tailored résumé, edited right on the page ----------
  let ed = { id: null, doc: null, timer: null, needsAttach: false, status: '', statusErr: false, skipped: false };
  const BLANK = {
    links: () => '', skills: () => ({ group: '', items: [] }), bullets: () => '', items: () => '',
    experience: () => ({ title: '', company: '', location: '', start: '', end: '', bullets: [''] }),
    projects: () => ({ name: '', subtitle: '', bullets: [''] }),
    education: () => ({ school: '', degree: '', major: '', start: '', end: '', details: '' }),
    extras: () => ({ heading: 'Certifications', items: [''] }),
  };
  const P = (p) => p.split('.').map((x) => (/^\d+$/.test(x) ? +x : x));
  const dget = (p) => P(p).reduce((o, k) => (o == null ? o : o[k]), ed.doc);
  const dset = (p, v) => { const ks = P(p), last = ks.pop(); const o = ks.reduce((a, k) => a[k], ed.doc); o[last] = v; };

  function syncDoc() {
    const t = JA.state.tailor;
    if (t && t.status === 'done' && t.doc && t.resumeId !== ed.id) {
      ed = { ...ed, id: t.resumeId, doc: JSON.parse(JSON.stringify(t.doc)), status: '', statusErr: false, needsAttach: false };
      for (const k of ['links', 'skills', 'experience', 'projects', 'education', 'extras']) ed.doc[k] = ed.doc[k] || [];
    }
    if (!t || t.status !== 'done') ed.id = null;
  }

  const ce = (path, ph, cls = '', tag = 'span', extra = '') => {
    const v = dget(path);
    return `<${tag} class="ce ${cls}" contenteditable="plaintext-only" spellcheck="true" data-p="${path}" data-ph="${h(ph)}" ${extra}>${h(Array.isArray(v) ? v.join(', ') : v || '')}</${tag}>`;
  };
  const mv = (list, i) => `<span class="pp-tools"><button data-mv="up" data-list="${list}" data-i="${i}" title="Move up">↑</button><button data-mv="down" data-list="${list}" data-i="${i}" title="Move down">↓</button><button data-mv="del" data-list="${list}" data-i="${i}" title="Remove">×</button></span>`;
  const bul = (path) => `<ul class="pp-ul">${(dget(path) || []).map((b, j) => `<li>${ce(`${path}.${j}`, 'Describe an accomplishment', '', 'span', 'data-bullet')}</li>`).join('')}</ul>`;

  function paperHTML() {
    const d = ed.doc;
    const sec = (title, inner, add) => `<div class="pp-sec"><div class="pp-h">${title}</div>${inner}${add ? `<button class="pp-add" data-add="${add[0]}">+ ${add[1]}</button>` : ''}</div>`;
    let out = `${ce('name', 'Your name', 'pp-name', 'div')}${ce('headline', 'Headline, e.g. Data Engineer · Python, Airflow', 'pp-headline', 'div')}
      <div class="pp-contact">${ce('location', 'Location')} · ${ce('email', 'Email')} · ${ce('phone', 'Phone')}${d.links.map((_, i) => ` · ${ce(`links.${i}`, 'link')}`).join('')}
        <button class="pp-add sm" data-add="links">+ link</button></div>`;
    out += sec('Summary', ce('summary', '2–3 sentences for this job', 'pp-p', 'div'));
    out += sec('Skills', d.skills.map((g, i) => `<div class="pp-entry pp-skill">${ce(`skills.${i}.group`, 'Group', 'pp-b')}: ${ce(`skills.${i}.items`, 'skills, comma, separated', '', 'span', 'data-join="comma"')}${mv('skills', i)}</div>`).join(''), ['skills', 'skill group']);
    out += sec('Experience', d.experience.map((e, i) => `<div class="pp-entry">
        <div class="pp-row"><span class="pp-b">${ce(`experience.${i}.title`, 'Title')}, ${ce(`experience.${i}.company`, 'Company')}</span>
        <span class="pp-d">${ce(`experience.${i}.start`, 'Start')} – ${ce(`experience.${i}.end`, 'End')}</span></div>
        ${ce(`experience.${i}.location`, 'Location', 'pp-i', 'div')}${bul(`experience.${i}.bullets`)}${mv('experience', i)}</div>`).join(''), ['experience', 'role']);
    if (d.projects.length) out += sec('Projects', d.projects.map((x, i) => `<div class="pp-entry">${ce(`projects.${i}.name`, 'Project', 'pp-b', 'div')}
        ${ce(`projects.${i}.subtitle`, 'One line: what it is', 'pp-i', 'div')}${bul(`projects.${i}.bullets`)}${mv('projects', i)}</div>`).join(''), ['projects', 'project']);
    out += sec('Education', d.education.map((e, i) => `<div class="pp-entry">
        <div class="pp-row"><span class="pp-b">${ce(`education.${i}.school`, 'School')} — ${ce(`education.${i}.degree`, 'Degree')}, ${ce(`education.${i}.major`, 'Major')}</span>
        <span class="pp-d">${ce(`education.${i}.start`, 'Start')} – ${ce(`education.${i}.end`, 'End')}</span></div>
        ${ce(`education.${i}.details`, 'GPA, honors, coursework', 'pp-i', 'div')}${mv('education', i)}</div>`).join(''), ['education', 'education']);
    d.extras.forEach((x, i) => {
      out += `<div class="pp-sec pp-entry">${ce(`extras.${i}.heading`, 'Section title', 'pp-h', 'div')}
        <ul class="pp-ul">${(x.items || []).map((_, j) => `<li>${ce(`extras.${i}.items.${j}`, 'Item', '', 'span', 'data-bullet')}</li>`).join('')}</ul>
        <button class="pp-add sm" data-add="extras.${i}.items">+ item</button>${mv('extras', i)}</div>`;
    });
    out += `<div class="pp-more">${d.projects.length ? '' : '<button class="pp-add" data-add="projects">+ Projects section</button>'}<button class="pp-add" data-add="extras">+ Other section</button></div>`;
    return out;
  }

  function tabMatch() {
    const s = JA.state, a = s.analysis, t = s.tailor;
    syncDoc();
    let out = '';
    // Fit
    if (s.analysisStatus === 'working') out += `<div class="working"><span class="spin"></span>Scoring your fit for this job…</div>`;
    else if (!a) {
      out += `<div class="note">See how well your résumé matches this job: a fit score, the keywords you're missing, and specific edits.</div>`;
      if (s.analysisStatus === 'error') out += `<div class="err">${h(s.analysisError)}</div>`;
      out += `<button class="btn primary block" data-a="analyze">Score my fit</button>`;
    } else {
      const v = VERDICT[a.verdict] || VERDICT.good;
      const ts = t && t.score;
      const tv = ts && (VERDICT[ts.verdict] || VERDICT.good);
      out += `<div class="score"><div class="ring" style="background:conic-gradient(${v[1]} ${a.fitScore * 3.6}deg,#e5e7eb 0)"><div style="color:${v[1]}">${a.fitScore}</div></div>
        <div><div style="font-weight:700;color:${v[1]}">${v[0]} <span class="muted small" style="font-weight:500">· your résumé</span></div><div class="small">${h(a.summary)}</div>
        ${ts ? `<div class="small" style="margin-top:4px"><b style="color:${tv[1]}">Tailored version: ${ts.fitScore}</b> <span class="muted">(${ts.fitScore - a.fitScore >= 0 ? '+' : ''}${ts.fitScore - a.fitScore})</span></div>` : ''}</div></div>`;
      if (a.matchedSkills.length) out += `<div class="sec"><h4>You match <span class="count">${a.matchedSkills.length}</span></h4><div class="chips">${a.matchedSkills.map((k) => `<span class="chip ok">${h(k)}</span>`).join('')}</div></div>`;
      const miss = ts ? ts.missingKeywords : a.missingKeywords;
      if (miss.length) out += `<div class="sec"><h4>Missing keywords${ts ? ' (tailored version)' : ''} <span class="count">${miss.length}</span></h4><div class="chips">${miss.map((k) => `<span class="chip miss">${h(k)}</span>`).join('')}</div></div>`;
      const more = [['Strengths', a.strengths], ['Gaps', a.gaps], ['Résumé suggestions', a.suggestions]].filter(([, l]) => l.length);
      if (more.length) out += `<details class="sec more"><summary>Strengths, gaps & suggestions</summary>${more.map(([t2, l]) => `<h4>${t2}</h4><ul class="l">${l.map((x) => `<li>${h(x)}</li>`).join('')}</ul>`).join('')}</details>`;
    }
    // Tailored résumé
    out += `<div class="sec"><h4>Tailored résumé</h4>`;
    if (t.status === 'working') out += `<div class="working"><span class="spin"></span>Writing your tailored résumé… (about 20–40s)</div>`;
    else if (t.status === 'done' && ed.doc) {
      out += `<div class="pp-bar"><span class="pp-file">📄 ${h(t.filename)}</span><span class="pp-status ${ed.statusErr ? 'bad' : ''}">${h(ed.status || 'Click any text to edit')}</span></div>
        <div class="row" style="margin:6px 0 8px"><button class="btn" data-a="rescore">${t.scoreStatus === 'working' ? '<span class="spin"></span> Scoring…' : 'Score this version'}</button>
          <button class="btn" data-a="download" data-id="${h(t.resumeId)}">Download</button><button class="btn" data-a="wide">${ui.isWide() ? '⤡ Narrower' : '⤢ Wider'}</button>
          <button class="btn" data-a="tailor">Regenerate</button></div>
        ${t.changes && t.changes.length ? `<details class="more" style="margin-bottom:8px"><summary>What the AI tailored</summary><ul class="l small">${t.changes.map((x) => `<li>${h(x)}</li>`).join('')}</ul></details>` : ''}
        <div class="paper">${paperHTML()}</div>
        <p class="muted small" style="margin:8px 0 0">Enter adds a bullet, Backspace on an empty one removes it. Edits are saved as you type and replace the résumé on this application when you click away.</p>`;
    } else {
      out += `<p class="muted small" style="margin:0 0 8px">Rewrites your résumé for this job using its wording, without adding anything you haven't done. You can then edit it right here.</p>
        <button class="btn primary block" data-a="tailor">Generate tailored résumé</button>`;
      if (t.status === 'error') out += `<div class="err">${h(t.error)}</div>`;
    }
    out += `</div>`;
    if (a) out += `<div class="foot"><span class="muted">Scored ${a.t ? new Date(a.t).toLocaleDateString() : ''}</span><a data-a="analyze">Re-score</a></div>`;
    return out;
  }

  function setEdStatus(text, err = false) {
    ed.status = text; ed.statusErr = err;
    const el = panel && panel.querySelector('.pp-status');
    if (el) { el.textContent = text; el.classList.toggle('bad', err); }
  }
  function scheduleSave() { setEdStatus('Editing…'); clearTimeout(ed.timer); ed.timer = setTimeout(saveDoc, 800); }
  async function saveDoc() {
    clearTimeout(ed.timer); ed.timer = null;
    if (!ed.id) return;
    setEdStatus('Saving…');
    const r = await A('saveTailored', ed.id, JSON.parse(JSON.stringify(ed.doc)));
    if (r && r.ok) { setEdStatus('✓ Saved'); ed.needsAttach = true; } else setEdStatus((r && r.error) || 'Save failed', true);
  }
  let rebuilding = false;
  function rebuildPaper(focusPath, atEnd) {
    const paper = panel.querySelector('.paper');
    if (!paper) return;
    rebuilding = true;
    paper.innerHTML = paperHTML();
    setTimeout(() => { rebuilding = false; }, 0);
    if (focusPath) {
      const el = paper.querySelector(`[data-p="${focusPath}"]`);
      if (el) {
        el.focus();
        if (atEnd) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const sel = root.getSelection ? root.getSelection() : getSelection(); sel.removeAllRanges(); sel.addRange(r); }
      }
    }
  }
  function wirePaper() {
    const paper = panel.querySelector('.paper');
    if (!paper) return;
    paper.addEventListener('input', (e) => {
      const el = e.target.closest('[data-p]');
      if (!el) return;
      let v = el.textContent.replace(/\n+/g, ' ');
      if (el.dataset.join === 'comma') v = v.split(',').map((x) => x.trim()).filter(Boolean);
      dset(el.dataset.p, v);
      scheduleSave();
    });
    paper.addEventListener('keydown', (e) => {
      const el = e.target.closest('[data-p]');
      if (!el) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (el.hasAttribute('data-bullet')) {
          const ks = el.dataset.p.split('.'), j = +ks.pop(), listPath = ks.join('.');
          dget(listPath).splice(j + 1, 0, '');
          rebuildPaper(`${listPath}.${j + 1}`);
          scheduleSave();
        } else el.blur();
      } else if (e.key === 'Backspace' && el.hasAttribute('data-bullet') && !el.textContent) {
        e.preventDefault();
        const ks = el.dataset.p.split('.'), j = +ks.pop(), listPath = ks.join('.');
        dget(listPath).splice(j, 1);
        rebuildPaper(j > 0 ? `${listPath}.${j - 1}` : null, true);
        scheduleSave();
      }
    });
    paper.addEventListener('click', (e) => {
      const m = e.target.closest('[data-mv]');
      const add = e.target.closest('[data-add]');
      if (m) {
        const list = dget(m.dataset.list), i = +m.dataset.i;
        if (m.dataset.mv === 'del') list.splice(i, 1);
        if (m.dataset.mv === 'up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
        if (m.dataset.mv === 'down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
        rebuildPaper();
        scheduleSave();
      } else if (add) {
        const path = add.dataset.add;
        if (!dget(path)) dset(path, []);
        const list = dget(path), kind = path.split('.').pop();
        list.push(BLANK[kind] ? BLANK[kind]() : '');
        const i = list.length - 1;
        const first = { links: `links.${i}`, skills: `skills.${i}.group`, experience: `experience.${i}.title`, projects: `projects.${i}.name`, education: `education.${i}.school`, extras: `extras.${i}.items.0` }[kind] || `${path}.${i}`;
        rebuildPaper(first);
        scheduleSave();
      }
    });
    // Leaving the résumé: make sure the latest version is saved and attached to the application.
    paper.addEventListener('focusout', async (e) => {
      if (rebuilding || (e.relatedTarget && paper.contains(e.relatedTarget))) return;
      if (!e.relatedTarget) await new Promise((r) => setTimeout(r, 0)); // focus may be landing back inside after a rebuild
      if (root.activeElement && paper.contains(root.activeElement)) return;
      if (ed.timer) await saveDoc();
      if (ed.needsAttach) { ed.needsAttach = false; A('reattachResume'); }
      if (ed.skipped) { ed.skipped = false; setTimeout(render, 0); }
    });
  }

  // ---------- Track ----------
  function tabTrack() {
    const s = JA.state, app = s.app, job = s.job || {}, a = s.analysis;
    const co = job.company || '';
    const li = (q, extra = '') => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}${extra}`;
    const ap = (q) => `https://app.apollo.io/#/people?qKeywords=${encodeURIComponent(q)}`;
    const rows = [];
    if (co) {
      rows.push([`Recruiters at ${co}`, li(`${co} recruiter`), ap(`${co} recruiter`)]);
      (a && a.hiringManagerTitles.length ? a.hiringManagerTitles : ['Hiring Manager']).forEach((t2) => rows.push([`${t2} at ${co}`, li(`${co} ${t2}`), ap(`${co} ${t2}`)]));
      if (s.profile.school) rows.push([`${s.profile.school} alumni at ${co}`, li(`${co} ${s.profile.school}`), ap(`${co} ${s.profile.school}`)]);
      rows.push([`Your connections at ${co}`, li(co, '&network=%5B%22F%22%2C%22S%22%5D'), null]);
      rows.push([`Everyone at ${co}`, li(co), ap(co)]);
    }
    let out = `<label class="f">Status</label>
      <select data-a="status">${STATUSES.map(([k, l]) => `<option value="${k}" ${(app ? app.status : 'none') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    if (app) {
      out += `<p class="muted small" style="margin:6px 0 0">${app.appliedAt ? `Applied ${new Date(app.appliedAt).toLocaleDateString()}` : `Saved ${new Date(app.createdAt).toLocaleDateString()}`}${app.resumeName && !app.files ? ` · ${h(app.resumeName)}` : ''}</p>`;
      if (app.files && app.files.length) {
        out += `<div class="sec"><h4>Files you submitted</h4>${app.files.map((f, i) => `<button class="item" data-sub="${i}"><div class="q">${h(pretty(f.field || 'File'))}</div>
          <div class="v">📄 ${h(f.name)} <span class="muted small">· ${Math.max(1, Math.round((f.size || 0) / 1024))} KB · download</span></div></button>`).join('')}</div>`;
      }
      out += `<div class="sec"><label class="f">Notes</label><textarea class="notes" placeholder="Recruiter name, salary range, next steps…">${h(app.notes || '')}</textarea></div>`;
    } else {
      out += `<p class="muted small" style="margin:6px 0 0">Applications are tracked automatically when you submit. Save this job to come back to it.</p>`;
    }
    if (rows.length) {
      out += `<div class="sec"><h4>Find the hiring team & referrals</h4>${rows.map(([l, u1, u2]) => `<div class="lrow"><span>${h(l)}</span>
        <a href="${h(u1)}" target="_blank" rel="noopener">LinkedIn ↗</a>${u2 ? `<a href="${h(u2)}" target="_blank" rel="noopener">Apollo ↗</a>` : '<span class="na"></span>'}</div>`).join('')}
        <p class="muted small" style="margin:6px 0 0">Opens a people search on each site (Apollo needs you to be signed in).</p></div>`;
    }
    out += `<div class="foot"><a data-a="tracker">Open tracker</a></div>`;
    return out;
  }

  // ---------- events ----------
  function wire() {
    panel.querySelectorAll('nav button').forEach((b) => {
      b.onclick = () => { tab = b.dataset.tab; render(); if (tab === 'match') A('analyzeIfNeeded'); };
    });
    panel.querySelectorAll('[data-field]').forEach((b) => { b.onclick = () => A('focusField', b.dataset.field); });
    const on = (sel, ev, fn) => panel.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, fn));
    on('[data-a=close]', 'click', () => ui.close());
    on('[data-a=settings]', 'click', () => A('openOptions'));
    on('[data-a=fill]', 'click', () => A('autofill'));
    on('[data-a=pause]', 'click', () => A('pauseSite', true));
    on('[data-a=unpause]', 'click', () => A('pauseSite', false));
    on('[data-a=analyze]', 'click', () => A('analyze'));
    on('[data-a=tailor]', 'click', () => A('tailor'));
    on('[data-a=download]', 'click', (e) => A('downloadResume', e.currentTarget.dataset.id));
    on('[data-a=rescore]', 'click', async () => { if (ed.timer) await saveDoc(); A('rescoreTailored'); });
    on('[data-a=wide]', 'click', () => { ui.toggleWide(); render(); });
    wirePaper();
    panel.querySelectorAll('[data-sub]').forEach((el) => { el.onclick = () => A('downloadSubmitted', +el.dataset.sub); });
    on('[data-a=resume]', 'change', (e) => A('chooseResume', e.target.value));
    on('[data-a=status]', 'change', (e) => A('setStatus', e.target.value));
    on('textarea.notes', 'change', (e) => A('setNotes', e.target.value));
    on('[data-a=tracker]', 'click', () => A('openTracker'));
    on('[data-a=apStop]', 'click', () => A('autopilotStop'));
    on('[data-a=apResume]', 'click', () => A('autopilotResume'));
    on('[data-a=showPw]', 'click', async (e) => {
      const span = panel.querySelector('.pw');
      if (span.textContent) { span.textContent = ''; e.currentTarget.textContent = 'Show password'; return; }
      span.textContent = (await A('revealPassword')) || '(none saved)';
      e.currentTarget.textContent = 'Hide';
    });
    on('[data-a=savePw]', 'click', () => {
      const v = (k) => (panel.querySelector(`[data-k=${k}]`) || {}).value || '';
      A('saveCreds', v('email').trim(), v('password'));
    });
  }
})();
