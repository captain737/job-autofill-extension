// Orchestration: detects job pages, runs autofill / analysis / tailoring / autopilot
// through the backend, learns from submitted answers, and drives the sidebar.
(() => {
  const JA = (window.__JA = window.__JA || {});
  if (JA.started) return;
  JA.started = true;
  const C = JA.core;
  const ui = () => JA.ui;

  // ---------- state ----------
  const st = (JA.state = {
    job: null, isApp: false, isAuth: false, isPosting: false, paused: false, ready: true,
    fill: { status: 'idle', items: [], empty: [] },
    analysis: null, analysisStatus: 'idle', analysisError: '',
    tailor: { status: 'idle' },
    app: null, resumes: [], resumeId: null, profile: {}, settings: {},
  });
  let asked = new Set();
  let aiFilled = new WeakMap(); // anchor -> value the AI put there
  let fieldsById = new Map();
  let running = false, expanded = false, openedOnce = false, analyzeTried = false, autoRuns = 0;

  // ---------- storage & backend ----------
  const KEYS = ['profile', 'resume', 'resumes', 'activeResumeId', 'resumeData', 'resumeDataVersion', 'settings', 'memory', 'jobResume', 'analyses', 'jobs', 'applications'];
  async function store() {
    const s = await chrome.storage.local.get(KEYS);
    if (!s.resumes && s.resume) { // migrate single résumé -> list
      const r = { id: 'r' + Date.now(), createdAt: Date.now(), label: 'Original', ...s.resume };
      s.resumes = [r];
      s.activeResumeId = r.id;
      await chrome.storage.local.set({ resumes: s.resumes, activeResumeId: r.id });
    }
    s.resumes = s.resumes || [];
    s.settings = s.settings || {};
    s.profile = s.profile || {};
    return s;
  }

  async function api(path, payload) {
    const res = await chrome.runtime.sendMessage({ type: 'api', path, payload });
    if (!res || !res.ok) throw new Error(res ? res.error : 'No response from the extension background');
    return res.data;
  }

  function selectedResume(s) {
    const key = st.job && st.job.key;
    const id = (key && s.jobResume && s.jobResume[key]) || s.activeResumeId;
    return s.resumes.find((r) => r.id === id) || s.resumes[0] || null;
  }
  const baseResume = (s) => s.resumes.find((r) => r.id === s.activeResumeId) || s.resumes.find((r) => !r.tailoredFor) || s.resumes[0] || null;

  // Work history without empty fields (and without the one-line summary when the full description is there).
  function compactHistory(h) {
    if (!h) return null;
    const clean = (o) => Object.fromEntries(Object.entries(o).filter(([k, v]) => v && !(k === 'summary' && o.description)));
    const out = {};
    for (const [k, v] of Object.entries(h)) {
      if (Array.isArray(v) && v.length) out[k] = v.map((x) => (x && typeof x === 'object' ? clean(x) : x));
    }
    return out;
  }

  // mode 'fill': the extracted work history replaces the raw résumé (same facts, far fewer tokens),
  //   and the job description is only sent when a question needs it (opts.withJob).
  // other modes (fit, tailoring): the full résumé, without the duplicate history.
  function basePayload(s, resume, mode = 'full', opts = {}) {
    const isPdf = resume && /pdf/i.test(resume.type || resume.name || '');
    const profile = Object.fromEntries(Object.entries(s.profile).filter(([, v]) => v));
    const hist = compactHistory(s.resumeData);
    const histReady = !!(hist && hist.experience && s.resumeDataVersion === HISTORY_VERSION);
    const sendResume = !(mode === 'fill' && histReady);
    const resumeText = sendResume && !isPdf ? (resume && resume.text) || s.settings.resumeText || '' : '';
    const j = st.job;
    return {
      profile,
      resume: sendResume && isPdf ? { media_type: 'application/pdf', data: resume.data.split(',')[1] } : null,
      resumeText,
      history: mode === 'fill' || !(isPdf || resumeText) ? hist : null,
      job: j ? {
        title: j.title, company: j.company, location: j.location,
        description: mode !== 'fill' || opts.withJob ? j.description : '',
      } : null,
    };
  }

  // Questions that need the job description to answer well.
  const OPEN_ENDED = /\bwhy\b|describe|tell us|explain|interest|cover letter|motivat|what makes|how would|how do you|anything else|additional information|about yourself|excite|passion|fit for|relevant experience/i;
  const LONG_LIST = 25; // dropdowns longer than this are answered as plain text and matched locally

  const listResumes = (s) => s.resumes.map(({ data, text, ...meta }) => meta);

  // ---------- job context ----------
  async function refreshJob() {
    const s = await store();
    const j = C.getJob();
    const jobs = s.jobs || {};
    const cached = jobs[j.key];
    if (cached) {
      if ((cached.description || '').length > (j.description || '').length) j.description = cached.description;
      if (!j.fromLd) { j.title = cached.title || j.title; j.company = cached.company || j.company; }
      j.location = j.location || cached.location || '';
    }
    if (st.isPosting && j.description.length > 600) {
      jobs[j.key] = { title: j.title, company: j.company, location: j.location, description: j.description, url: j.url, t: Date.now() };
      const keys = Object.keys(jobs).sort((a, b) => jobs[b].t - jobs[a].t);
      for (const k of keys.slice(80)) delete jobs[k];
      await chrome.storage.local.set({ jobs });
    }
    const changed = !st.job || st.job.key !== j.key;
    st.job = j;
    st.profile = s.profile;
    st.settings = s.settings;
    st.paused = (s.settings.pausedHosts || []).includes(location.host);
    st.ready = s.resumes.length > 0 || Object.values(s.profile).some(Boolean);
    st.resumes = listResumes(s);
    const sel = selectedResume(s);
    st.resumeId = sel ? sel.id : null;
    st.app = (s.applications || []).find((a) => a.key === j.key) || null;
    if (st.tailor.status === 'idle' || (st.tailor.status === 'done' && changed)) {
      const mapped = (s.jobResume || {})[j.key];
      const t = s.resumes.find((r) => r.doc && r.id === mapped) || s.resumes.find((r) => r.doc && r.tailoredFor && r.tailoredFor.key === j.key);
      st.tailor = t ? { status: 'done', resumeId: t.id, filename: t.name, changes: t.doc.changes || [], doc: t.doc } : { status: 'idle' };
    }
    if (changed || !st.analysis) {
      const a = (s.analyses || {})[j.key];
      if (a) { st.analysis = a; st.analysisStatus = 'done'; }
    }
    return s;
  }

  // ---------- answer memory retrieval ----------
  const STOP = new Set('the a an and or of to for in on at is are you your do does did have has with this that what which please if we our be by from as it any will would can'.split(' '));
  const tokens = (s) => new Set(C.norm(s).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter((w) => w.length > 2 && !STOP.has(w)));
  function similarity(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    return inter / (a.size + b.size - inter);
  }
  function relevantMemory(fields, memory) {
    if (!memory || !memory.length) return [];
    const mem = memory.map((m) => ({ m, tok: tokens(m.q) }));
    const picked = new Map();
    for (const f of fields) {
      const ft = tokens(f.label);
      mem.map((x) => ({ x, s: x.m.key === C.norm(f.label) ? 1 : similarity(ft, x.tok) }))
        .filter((y) => y.s >= 0.3).sort((a, b) => b.s - a.s).slice(0, 3)
        .forEach(({ x }) => picked.set(x.m.key + '|' + x.m.type, x.m));
    }
    return [...picked.values()].slice(0, 60).map((m) => ({ question: m.q, answer: m.a, source: m.src, type: m.type }));
  }

  // ---------- autofill ----------
  const show = (v) => (Array.isArray(v) ? v.join(', ') : String(v));

  // Résumés parsed before full job descriptions were extracted get re-read once.
  const HISTORY_VERSION = 2;
  async function ensureHistory(s) {
    if (s.resumeDataVersion === HISTORY_VERSION && s.resumeData) return s.resumeData;
    const base = baseResume(s);
    if (!base) return s.resumeData || null;
    try {
      st.fill = { ...st.fill, status: 'working', note: 'Re-reading your résumé for full job descriptions (one time)…' };
      ui().render();
      const isPdf = /pdf/i.test(base.type || base.name || '');
      const parsed = await api('/parse', {
        resume: isPdf || !base.text
          ? { name: base.name, media_type: base.type, data: base.data.split(',')[1] }
          : { name: base.name.replace(/\.\w+$/, '') + '.txt', media_type: 'text/plain', data: btoa(unescape(encodeURIComponent(base.text))) },
      });
      const resumeData = {
        experience: parsed.experience || [], education: parsed.education || [], skills: parsed.skills || [],
        projects: parsed.projects || [], certifications: parsed.certifications || [], languages: parsed.languages || [],
      };
      await chrome.storage.local.set({ resumeData, resumeDataVersion: HISTORY_VERSION });
      s.resumeData = resumeData;
      s.resumeDataVersion = HISTORY_VERSION;
      return resumeData;
    } catch (e) {
      console.warn('[autofill] re-reading résumé failed', e);
      return s.resumeData || null;
    }
  }

  // Fills every field on the page with AI answers, correcting values that are already there.
  // opts.auth: sign-in / sign-up page (password fields included, values substituted locally).
  async function autofill({ force = false, auth = false, creds = null } = {}) {
    if (running) return null;
    running = true;
    const report = { filled: 0, asked: 0, review: 0, corrected: 0, error: null };
    let fields = [];
    try {
      const s = await refreshJob();
      const resume = selectedResume(s);
      const override = s.settings.overwrite !== false;
      if (!auth) s.resumeData = await ensureHistory(s);
      if (!auth && !expanded && s.resumeData) {
        expanded = true;
        st.fill = { ...st.fill, status: 'working', note: 'Adding work history and education sections…' };
        ui().render();
        await C.expandRepeaters(s.resumeData);
      }
      const all = C.scan({ auth });
      all.forEach((f) => fieldsById.set(f.id, f));
      fields = all.filter((f) => (force || !asked.has(C.signature(f)))
        && (!f.filled || (override && f.kind !== 'file')));
      if (auth && !creds) fields = fields.filter((f) => f.kind !== 'password');
      if (!fields.length) {
        const empty = C.scan({ auth }).filter((f) => f.required && !f.filled && f.kind !== 'file' && !C.readValue(f).length);
        empty.forEach((f) => fieldsById.set(f.id, f));
        st.fill = { ...st.fill, status: st.fill.items.length ? 'done' : 'idle', note: '', empty: empty.map((f) => ({ id: f.id, label: f.label, entry: f.entry })) };
        return report;
      }
      report.asked = fields.length;
      st.fill = { ...st.fill, status: 'working', count: fields.length, note: auth ? 'Filling sign-in details…' : '' };
      ui().render();
      fields.forEach((f) => asked.add(C.signature(f)));
      for (const f of fields) {
        if ((f.kind === 'combobox' || f.kind === 'listbox') && !f.options) f.options = await C.readPopupOptions(f.el);
      }
      const withJob = !auth && fields.some((f) => f.kind === 'textarea' || OPEN_ENDED.test(f.label || ''));
      const base = basePayload(s, resume, 'fill', { withJob });
      if (auth) Object.assign(base, { history: null, job: null, resume: null, resumeText: '' }); // sign-in only needs the email
      if (auth && creds) base.profile = { ...base.profile, email: creds.email };
      const payload = {
        ...base,
        acceptTerms: !!s.settings.acceptTerms,
        fields: fields.slice(0, 80).map((f) => {
          const out = { id: f.id, type: C.aiType(f), question: (f.label || '').slice(0, 300) || '(no label)' };
          if (f.hint && f.hint !== C.norm(f.label)) out.hint = f.hint.slice(0, 80);
          if (f.options && f.options.length > LONG_LIST) { out.optionCount = f.options.length; out.examples = f.options.slice(0, 5); }
          else if (f.options && f.options.length) out.options = f.options;
          if (f.required) out.required = true;
          if (f.section) out.section = f.section;
          if (f.entry) out.entry = f.entry;
          if (f.kind !== 'password' && f.current) out.current = f.current;
          return out;
        }),
        memory: auth ? [] : relevantMemory(fields, s.memory),
      };
      const { answers = [] } = await api('/fill', payload);
      const byId = new Map(fields.map((f) => [f.id, f]));
      const items = st.fill.items.filter((it) => !byId.has(it.id));
      for (const a of answers) {
        const f = byId.get(a.id);
        if (!f) continue;
        let value = a.value;
        if (f.kind === 'password') {
          if (!creds || String(value).trim() !== '{{PASSWORD}}') continue;
          value = creds.password;
        } else if (String(value).includes('{{PASSWORD}}')) continue;
        const before = f.current;
        let ok = false;
        try { ok = await C.fillField(f, value, resume); } catch (e) { console.warn('[autofill] fill', e); }
        if (!ok) continue;
        report.filled++;
        const after = C.readValue(f);
        aiFilled.set(C.anchor(f), JSON.stringify(after));
        const corrected = !!before && JSON.stringify(before) !== JSON.stringify(Array.isArray(after) ? after : String(after).slice(0, 1500));
        if (corrected) report.corrected++;
        const review = f.kind !== 'password' && (a.confidence !== 'high' || f.kind === 'textarea');
        if (review) report.review++;
        C.highlight(f, review ? '#f59e0b' : '#6366f1', review ? `AI-filled, please review${a.reason ? ': ' + a.reason : ''}` : 'AI-filled', review);
        if (f.kind === 'file' && resume) attached = { id: resume.id, v: version(resume) };
        items.push({
          id: f.id, label: f.label, entry: f.entry, review, reason: a.reason,
          value: f.kind === 'password' ? '••••••••' : f.kind === 'file' ? (resume && resume.name) : show(value),
          was: corrected ? show(before) : undefined,
        });
      }
      const empty = C.scan({ auth }).filter((f) => f.required && !f.filled && f.kind !== 'file' && !C.readValue(f).length);
      empty.forEach((f) => fieldsById.set(f.id, f));
      st.fill = { status: 'done', items, empty: empty.map((f) => ({ id: f.id, label: f.label, entry: f.entry })), report, note: '' };
    } catch (e) {
      report.error = String(e.message || e);
      fields.forEach((f) => asked.delete(C.signature(f)));
      st.fill = { ...st.fill, status: 'error', error: report.error, note: '' };
      console.warn('[autofill]', e);
    } finally {
      running = false;
      ui().render();
    }
    return report;
  }

  // ---------- fit analysis ----------
  async function analyze({ force = false } = {}) {
    analyzeTried = true;
    const s = await refreshJob();
    if (!st.job || (st.job.description || '').length < 200) {
      st.analysisStatus = 'error';
      st.analysisError = 'No job description on this page. Open the job posting to analyze fit.';
      ui().render();
      return;
    }
    if (st.analysis && !force) return;
    st.analysisStatus = 'working';
    ui().render();
    try {
      const a = await api('/analyze', basePayload(s, baseResume(s)));
      a.t = Date.now();
      st.analysis = a;
      st.analysisStatus = 'done';
      const analyses = (await chrome.storage.local.get('analyses')).analyses || {};
      analyses[st.job.key] = a;
      const keys = Object.keys(analyses).sort((x, y) => (analyses[y].t || 0) - (analyses[x].t || 0));
      for (const k of keys.slice(150)) delete analyses[k];
      await chrome.storage.local.set({ analyses });
      if (st.app) await track({}, true);
    } catch (e) {
      st.analysisStatus = 'error';
      st.analysisError = String(e.message || e);
    }
    ui().render();
  }

  // ---------- tailored résumé ----------
  async function tailor() {
    const s = await refreshJob();
    if (!st.job || (st.job.description || '').length < 200) {
      st.tailor = { status: 'error', error: 'Open the job posting first so the AI can read the description.' };
      ui().render();
      return;
    }
    const base = baseResume(s);
    if (!base) {
      st.tailor = { status: 'error', error: 'Upload your résumé in settings first.' };
      ui().render();
      return;
    }
    st.tailor = { status: 'working' };
    ui().render();
    try {
      const out = await api('/tailor', { ...basePayload(s, base), analysis: st.analysis });
      const r = {
        id: 'r' + Date.now(), name: out.filename, type: 'application/pdf',
        data: 'data:application/pdf;base64,' + out.pdf, createdAt: Date.now(),
        label: `Tailored · ${st.job.company || st.job.title}`,
        tailoredFor: { key: st.job.key, company: st.job.company, title: st.job.title },
        doc: out.resume, // editable version for the résumé editor
      };
      const cur = await chrome.storage.local.get(['resumes', 'jobResume']);
      const resumes = (cur.resumes || s.resumes).concat(r);
      const jobResume = { ...(cur.jobResume || {}), [st.job.key]: r.id };
      await chrome.storage.local.set({ resumes, jobResume });
      st.tailor = { status: 'done', resumeId: r.id, filename: r.name, changes: out.resume.changes || [], doc: out.resume };
      await refreshJob();
      await reattachResume();
    } catch (e) {
      st.tailor = { status: 'error', error: String(e.message || e) };
    }
    ui().render();
  }

  async function chooseResume(id) {
    const { jobResume = {} } = await chrome.storage.local.get('jobResume');
    if (st.job) jobResume[st.job.key] = id;
    await chrome.storage.local.set({ jobResume });
    st.resumeId = id;
    await reattachResume();
    ui().render();
  }

  // If a résumé is already attached on this form, swap in the newly selected (or newly edited) one.
  let attached = null; // { id, v } of the résumé we last attached on this page
  const version = (r) => r.updatedAt || r.createdAt || 0;
  async function reattachResume(force = false) {
    const s = await store();
    const r = selectedResume(s);
    if (!r) return;
    for (const f of C.scan()) {
      if (f.kind !== 'file' || !/resume|résumé|\bcv\b/.test(f.label) || /cover/.test(f.label)) continue;
      if (!f.el.files.length || (f.el.files[0].name === r.name && !force)) continue;
      try {
        await C.fillField(f, 'resume', r);
        attached = { id: r.id, v: version(r) };
        const it = st.fill.items.find((i) => i.id === f.id);
        if (it) it.value = r.name;
      } catch (e) { console.warn('[autofill] reattach', e); }
    }
  }

  // ---------- editing the tailored résumé in the Match tab ----------
  async function saveTailored(id, doc) {
    try {
      const { pdf } = await api('/render', { resume: doc, profile: st.profile });
      const { resumes = [] } = await chrome.storage.local.get('resumes');
      const i = resumes.findIndex((r) => r.id === id);
      if (i < 0) return { ok: false, error: 'This résumé was deleted.' };
      resumes[i] = { ...resumes[i], doc, data: 'data:application/pdf;base64,' + pdf, updatedAt: Date.now() };
      await chrome.storage.local.set({ resumes });
      if (st.tailor.resumeId === id) { st.tailor.doc = doc; st.tailor.score = null; }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  function docText(d) {
    const lines = [d.name, d.headline, [d.location, d.email, d.phone, ...(d.links || [])].filter(Boolean).join(' | '), '', 'SUMMARY', d.summary, '', 'SKILLS'];
    for (const g of d.skills || []) lines.push(`${g.group}: ${(g.items || []).join(', ')}`);
    lines.push('', 'EXPERIENCE');
    for (const e of d.experience || []) { lines.push(`${e.title}, ${e.company} (${e.start} - ${e.end}) ${e.location || ''}`); for (const b of e.bullets || []) lines.push('- ' + b); }
    if ((d.projects || []).length) { lines.push('', 'PROJECTS'); for (const x of d.projects) { lines.push(`${x.name}: ${x.subtitle || ''}`); for (const b of x.bullets || []) lines.push('- ' + b); } }
    lines.push('', 'EDUCATION');
    for (const e of d.education || []) lines.push(`${e.school}, ${e.degree} ${e.major} (${e.start} - ${e.end}) ${e.details || ''}`);
    for (const x of d.extras || []) { lines.push('', (x.heading || '').toUpperCase()); for (const b of x.items || []) lines.push('- ' + b); }
    return lines.filter((l) => l != null).join('\n');
  }

  // Scores the tailored version (as currently edited) against this job.
  async function rescoreTailored() {
    const t = st.tailor;
    if (!t || !t.doc || !st.job) return;
    t.scoreStatus = 'working';
    ui().render();
    try {
      const s = await store();
      const base = basePayload(s, null);
      const a = await api('/analyze', { ...base, resume: null, history: null, resumeText: docText(t.doc) });
      if (st.tailor === t) t.score = a;
    } catch (e) {
      t.score = null;
      console.warn('[autofill] scoring tailored résumé', e);
    }
    t.scoreStatus = 'idle';
    ui().render();
  }

  // Coming back from another tab: attach the latest saved version of the résumé once.
  async function refreshEditedResume() {
    if (document.hidden || !attached) return;
    const s = await store();
    const r = selectedResume(s);
    if (r && r.id === attached.id && version(r) !== attached.v) {
      await reattachResume(true);
      if (st.tailor && st.tailor.resumeId === r.id) st.tailor.filename = r.name;
      ui().render();
    }
  }
  document.addEventListener('visibilitychange', refreshEditedResume);
  window.addEventListener('focus', refreshEditedResume);

  async function downloadResume(id) {
    const { resumes = [] } = await chrome.storage.local.get('resumes');
    const r = resumes.find((x) => x.id === id);
    if (!r) return;
    const blob = await (await fetch(r.data)).blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = r.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  // ---------- tracker ----------
  async function track(fields, onlyIfExists = false) {
    if (!st.job) await refreshJob();
    const s = await chrome.storage.local.get(['resumes', 'jobResume', 'activeResumeId']);
    const rid = (s.jobResume || {})[st.job.key] || s.activeResumeId;
    const r = (s.resumes || []).find((x) => x.id === rid);
    const entry = {
      key: st.job.key, url: st.job.url, title: st.job.title, company: st.job.company, location: st.job.location,
      fit: st.analysis ? st.analysis.fitScore : undefined, verdict: st.analysis ? st.analysis.verdict : undefined,
      resumeName: r ? r.name : undefined, resumeId: r ? r.id : undefined, ...fields,
    };
    const res = await chrome.runtime.sendMessage({ type: 'track', entry, onlyIfExists });
    if (res && res.ok) st.app = res.app;
    ui().render();
  }
  const setStatus = (status) => (status === 'none' ? track({ remove: true }) : track({ status }));
  const setNotes = (notes) => track({ notes }, true);

  // ---------- learning: remember answers when the user moves on ----------
  function captureAnswers() {
    const entries = [];
    for (const f of C.scan()) {
      if (f.kind === 'file' || f.single || !f.label || f.label.length < 3) continue;
      const v = C.readValue(f);
      if (!v || (Array.isArray(v) && !v.length)) continue;
      const a = Array.isArray(v) ? v : String(v).slice(0, 2000);
      const byAI = aiFilled.get(C.anchor(f));
      entries.push({
        q: f.label.replace(/\*/g, '').trim().slice(0, 300),
        key: C.norm(f.label.replace(/\*/g, '')),
        type: C.aiType(f),
        a,
        src: byAI !== undefined && byAI === JSON.stringify(v) ? 'ai' : 'you',
        host: location.host,
      });
    }
    if (entries.length) chrome.runtime.sendMessage({ type: 'remember', entries }).catch(() => {});
  }

  let lastCapture = 0;
  // ---------- keep copies of attached files until the application is submitted ----------
  // Multi-step forms drop the upload field from the page after its step, so files are copied
  // the moment they're attached (by autopilot or by you) rather than at Submit.
  const readFile = (file) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
  document.addEventListener('change', async (e) => {
    const el = e.target;
    if (!el || el.type !== 'file' || C.ours(el) || !el.files || !el.files.length) return;
    try {
      if (!st.job) await refreshJob();
      const files = [];
      for (const f of [...el.files].slice(0, 3)) {
        if (f.size > 10 * 1024 * 1024) continue;
        files.push({ name: f.name, type: f.type, size: f.size, data: await readFile(f) });
      }
      if (!files.length) return;
      const field = (C.labelFor(el) || el.name || 'file').replace(/\*/g, '').trim().slice(0, 80);
      chrome.runtime.sendMessage({ type: 'pending-files', key: st.job.key, field, files }).catch(() => {});
    } catch (err) { console.warn('[autofill] copying attached file', err); }
  }, true);

  async function downloadSubmitted(i) {
    if (!st.job) return;
    const k = 'submission:' + st.job.key;
    const sub = (await chrome.storage.local.get(k))[k];
    const f = sub && sub.files[i];
    if (!f) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await (await fetch(f.data)).blob());
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  function onAdvance(final) {
    if (Date.now() - lastCapture < 1500) return;
    lastCapture = Date.now();
    try { captureAnswers(); } catch (e) { console.warn('[autofill] capture', e); }
    if (final && st.job) {
      // snapshot: file away copies of everything attached during this application
      track({ status: 'applied', appliedAt: Date.now(), snapshot: true }).catch(() => {});
      flowMsg('clear');
      st.ap.status = 'done';
      st.ap.message = 'Submitted. Logged in your tracker.';
    }
  }
  document.addEventListener('submit', (e) => {
    const form = e.target;
    const filled = form && form.querySelectorAll ? [...form.querySelectorAll('input, textarea, select')].filter((x) => x.value).length : 0;
    onAdvance(filled >= 3 && (st.isApp || C.looksLikeApplication()));
  }, true);
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button, input[type=submit], [role="button"], a');
    if (!b || C.ours(b)) return;
    const t = C.norm(C.textOf(b) || b.value || b.getAttribute('aria-label'));
    if (/\bsubmit\b|send application|submit application/.test(t)) return onAdvance(true);
    if (/\bapply\b/.test(t) && b.closest('form') && st.isApp) return onAdvance(false);
    if (/\b(next|continue|save and continue|save & continue|review)\b/.test(t)) onAdvance(false);
  }, true);

  // ---------- autopilot ----------
  // Moves the application forward one click at a time (Apply → account → each form step),
  // and always stops before anything that submits.
  st.ap = { status: 'idle', message: '', log: [], account: null, needsPassword: false };
  let apBusy = false, apSteps = 0, lastClick = null, sameCount = 0, cooldownUntil = 0, stopSig = '';
  const site = () => location.host;
  const flowMsg = (op, data) => chrome.runtime.sendMessage({ type: 'flow', op, data }).then((r) => (r && r.flow) || null).catch(() => null);
  const vault = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

  function apLog(text) {
    st.ap.log = [...st.ap.log, { t: Date.now(), text }].slice(-8);
    st.ap.message = text;
    ui().render();
  }
  function apStop(message, status = 'stopped') {
    st.ap.status = status;
    stopSig = C.pageSignature();
    apLog(message);
  }
  function reachedSubmit(message) {
    for (const b of C.listButtons()) {
      if (/\bsubmit\b|send application/i.test(b.text)) {
        b.el.style.outline = '3px solid #16a34a';
        b.el.style.outlineOffset = '3px';
        b.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
    apStop(message || 'Ready to submit. Review everything, then click Submit yourself.', 'ready');
  }

  function looksLikeSignup() {
    const pw = [...document.querySelectorAll('input[type=password]')].filter((e) => C.isVisible(e) && !C.ours(e));
    if (pw.length >= 2) return true;
    const heads = C.pageInfo().headings.join(' ');
    return /create (an |your )?account|sign ?up|register|new account/i.test(heads) && !/sign ?in|log ?in/i.test(heads);
  }

  async function autopilotAllowed() {
    if (st.settings.autopilot === false || st.paused || C.isAggregator() || !st.ready) return false;
    if (!canUI()) return false;
    const fl = await flowMsg('get');
    if (fl && fl.stopped) {
      if (st.ap.status !== 'stopped') { st.ap.status = 'stopped'; st.ap.message = 'Autopilot is paused in this tab.'; }
      return false;
    }
    if (st.isAuth) return C.isATS() || !!(fl && fl.active);
    return st.isApp || st.isPosting;
  }

  async function runAutopilot() {
    if (apBusy || running) return;
    if (Date.now() < cooldownUntil) { // let the page react to the last click, then look again
      clearTimeout(debounce);
      debounce = setTimeout(check, cooldownUntil - Date.now() + 150);
      return;
    }
    if (['stopped', 'captcha', 'ready', 'done'].includes(st.ap.status)) return; // waits for Resume or a page change
    if (!(await autopilotAllowed())) return;
    apBusy = true;
    st.ap.status = 'running';
    ui().render();
    try {
      if (apSteps >= 40) return apStop('Stopped after 40 steps to be safe. Click Resume to keep going.');
      if (C.captchaPresent()) return apStop('There’s a CAPTCHA on this page. Solve it, then click Resume.', 'captcha');

      let creds = null;
      if (st.isAuth) {
        const got = await vault({ type: 'vault-get', site: site() });
        creds = (got && got.creds) || null;
        if (!creds && looksLikeSignup()) {
          if (st.settings.autoAccount === false) return apStop('This site needs an account. Automatic account creation is off in settings.');
          if (!st.profile.email) return apStop('Add your email to your profile so I can create the account.');
          const r = await vault({ type: 'vault-create', site: site(), email: st.profile.email, url: location.href });
          creds = r && r.creds;
          if (r && r.created) apLog(`Created a strong password for ${site()}. It's saved in Settings → Accounts.`);
        }
        st.ap.account = creds ? { email: creds.email } : null;
        if (creds) await autofill({ auth: true, creds, force: true });
        if (creds && !st.settings.acceptTerms && looksLikeSignup()) {
          const terms = C.scan({ auth: true }).find((f) => f.kind === 'checkbox' && f.single && !f.els[0].checked && /agree|terms|consent|privacy/.test(f.label));
          if (terms) {
            C.scrollToField(terms);
            C.highlight(terms, '#f59e0b', 'Tick this yourself', true);
            return apStop('Tick the site’s terms box yourself, then click Resume. (To let me do it, turn it on in Settings.)');
          }
        }
      } else if (st.isApp) {
        await autofill();
        if (st.fill.status === 'error') return apStop(`Autofill failed: ${st.fill.error}`);
      }

      const info = C.pageInfo();
      const buttons = C.listButtons();
      const empty = st.isAuth ? [] : (st.fill.empty || []);
      // The AI would only say "stop" here, so skip the call.
      if (st.isApp && empty.length) {
        empty.slice(0, 1).forEach((e) => { const f = fieldsById.get(e.id); if (f) C.scrollToField(f); });
        return apStop(`Stopped: ${empty.length} required field${empty.length === 1 ? '' : 's'} need${empty.length === 1 ? 's' : ''} your input (${empty.slice(0, 3).map((e) => (e.label || '').replace(/\*/g, '').trim()).join(', ')}). Fill ${empty.length === 1 ? 'it' : 'them'}, then click Resume.`);
      }
      const nav = await api('/navigate', {
        ...info, buttons: buttons.map(({ el, ...b }) => b),
        emptyRequired: empty.length, emptyLabels: empty.map((e) => e.label), hasCredentials: !!creds,
      });

      if (nav.action !== 'click') {
        if (nav.page === 'final_review') return reachedSubmit(nav.reason);
        if (nav.page === 'confirmation') { await flowMsg('clear'); return apStop(nav.reason || 'Application submitted.', 'done'); }
        if (st.isAuth && /already|exist|in use|registered/i.test((info.errors || []).join(' ') + ' ' + info.excerpt)) {
          st.ap.needsPassword = true;
          return apStop('An account already exists for this email. Sign in once yourself, or save that password below so I can sign in next time.');
        }
        return apStop(nav.reason || 'Stopped. Check the page, then click Resume.');
      }

      const btn = C.buttonById(nav.buttonId);
      if (!btn) return apStop('Couldn’t find the button to continue.');
      const text = (btn.innerText || btn.value || btn.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const authSubmit = st.isAuth && /^(submit|continue)$/i.test(text) && btn.closest('form') && btn.closest('form').querySelector('input[type=password]');
      if (C.NEVER_RE.test(text) && !authSubmit) return reachedSubmit(`Reached “${text}”. Review everything, then submit it yourself.`);

      const sig = C.pageSignature();
      if (lastClick && lastClick.sig === sig && lastClick.text === text) {
        sameCount++;
        if (sameCount >= 2) {
          const err = (info.errors || [])[0];
          return apStop(`Clicking “${text}” didn’t move forward. ${err ? `The page says: ${err}` : 'Check the page for errors, then click Resume.'}`);
        }
      } else sameCount = 0;
      lastClick = { sig, text };
      apSteps++;
      // Score the job once when autopilot decides to apply, so the tracker has its fit.
      if (nav.page === 'job_posting' && !st.analysis && (st.job && (st.job.description || '').length >= 200)) {
        apLog('Scoring your fit for this job…');
        await analyze();
      }
      if (['job_posting', 'apply_options', 'sign_in', 'create_account'].includes(nav.page)) {
        await flowMsg('set', { active: true, stopped: false, jobKey: st.job && st.job.key });
      }
      apLog(nav.reason || `Clicked “${text}”`);
      btn.scrollIntoView({ block: 'center' });
      await C.sleep(350);
      const href = btn.tagName === 'A' && btn.getAttribute('href');
      if (href && !/^(#|javascript:)/i.test(href) && btn.target === '_blank') location.assign(btn.href); // stay in this tab
      else C.realClick(btn);
      cooldownUntil = Date.now() + 2500;
      st.ap.status = 'idle';
      clearTimeout(debounce);
      debounce = setTimeout(check, 2600);
    } catch (e) {
      apStop(`Autopilot error: ${e.message || e}`);
    } finally {
      apBusy = false;
      if (st.ap.status === 'running') st.ap.status = 'idle';
      ui().render();
    }
  }

  // ---------- detection loop ----------
  // Sidebar lives in the top page, or in a large embedded application frame (e.g. Greenhouse iframes).
  const canUI = () => window === window.top || (innerWidth >= 500 && innerHeight >= 400);
  let lastCheck = 0;
  async function check() {
    if (running || apBusy) return;
    if (document.hidden || Date.now() - lastCheck < 2000) { clearTimeout(debounce); debounce = setTimeout(check, 2500); return; }
    lastCheck = Date.now();
    const fl = await flowMsg('get');
    const inFlow = !!(fl && fl.active && !C.isAggregator());
    st.isAuth = C.isAuthPage();
    st.isApp = !st.isAuth && C.looksLikeApplication(inFlow);
    st.isPosting = !st.isAuth && !st.isApp && C.looksLikeJobPosting();
    const authRelevant = st.isAuth && (C.isATS() || inFlow);
    if (!st.isApp && !st.isPosting && !authRelevant) {
      st.isAuth = false;
      if (ui().mounted) ui().render();
      return;
    }
    await refreshJob();
    if (canUI()) ui().mount();
    if ((st.isApp || st.isAuth) && canUI() && !openedOnce && st.settings.autoOpen !== false && !st.paused) { openedOnce = true; ui().open('autofill'); }
    if (!st.ready) { ui().render(); return; }

    // A stopped autopilot picks up again once the page has changed (e.g. you fixed a field and clicked Next).
    if (['stopped', 'captcha'].includes(st.ap.status) && stopSig && C.pageSignature() !== stopSig) {
      const fl = await flowMsg('get');
      if (!(fl && fl.stopped)) { st.ap.status = 'idle'; sameCount = 0; }
    }

    if (await autopilotAllowed()) {
      if (st.isPosting && st.settings.autoAnalyze === true && !st.analysis && !analyzeTried) analyze();
      runAutopilot();
      return;
    }
    // Autopilot off: fill and score only.
    if (st.isApp) {
      if (st.settings.autoFill === false || st.paused || autoRuns >= 15) { ui().render(); return; }
      const fresh = C.scan().filter((f) => !asked.has(C.signature(f)));
      if (fresh.length >= 2) { autoRuns++; autofill(); } else ui().render();
    } else {
      ui().render();
      if (st.isPosting && st.settings.autoAnalyze === true && !st.paused && !st.analysis && !analyzeTried) analyze();
    }
  }

  let debounce;
  new MutationObserver((muts) => {
    if (running || apBusy) return;
    if (muts.every((m) => C.ours(m.target) || (m.target.id === '__ja-root'))) return;
    clearTimeout(debounce);
    debounce = setTimeout(check, 1200);
  }).observe(document.documentElement, { childList: true, subtree: true });

  // Single-page apps change URL without reloading: reset per-page state.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    const oldKey = C.jobKey(lastUrl);
    lastUrl = location.href;
    asked = new Set();
    aiFilled = new WeakMap();
    fieldsById = new Map();
    expanded = false;
    autoRuns = 0;
    sameCount = 0;
    st.fill = { status: 'idle', items: [], empty: [] };
    if (['stopped', 'captcha'].includes(st.ap.status)) st.ap.status = 'idle'; // still blocked if you paused it
    if (C.jobKey(location.href) !== oldKey) {
      st.analysis = null; st.analysisStatus = 'idle'; analyzeTried = false;
      st.tailor = { status: 'idle' }; st.app = null;
    }
    clearTimeout(debounce);
    debounce = setTimeout(check, 900);
  }, 800);

  setTimeout(check, 900);

  async function autopilotResume() {
    await flowMsg('set', { stopped: false, active: true });
    st.ap.status = 'idle';
    st.ap.needsPassword = false;
    sameCount = 0;
    lastClick = null;
    if (apSteps >= 40) apSteps = 0;
    cooldownUntil = 0;
    lastCheck = 0;
    apLog('Autopilot resumed');
    await check();
  }
  async function autopilotStop() {
    await flowMsg('set', { stopped: true });
    apStop('Autopilot paused by you. Click Resume to continue.');
  }
  async function saveCreds(email, password) {
    if (!email || !password) return;
    await vault({ type: 'vault-save', site: site(), email, password, url: location.href });
    st.ap.needsPassword = false;
    apLog(`Saved your password for ${site()}`);
    await autopilotResume();
  }
  async function revealPassword() {
    const got = await vault({ type: 'vault-get', site: site() });
    return got && got.creds ? got.creds.password : '';
  }

  // ---------- actions used by the sidebar and popup ----------
  async function pauseSite(on = true) {
    const { settings = {} } = await chrome.storage.local.get('settings');
    const set = new Set(settings.pausedHosts || []);
    on ? set.add(location.host) : set.delete(location.host);
    await chrome.storage.local.set({ settings: { ...settings, pausedHosts: [...set] } });
    st.paused = on;
    ui().render();
  }

  JA.actions = {
    autofill: () => autofill({ force: true }),
    analyze: () => analyze({ force: true }),
    tailor, chooseResume, downloadResume, setStatus, setNotes, pauseSite,
    autopilotResume, autopilotStop, saveCreds, revealPassword,
    saveTailored, rescoreTailored,
    reattachResume: () => reattachResume(true),
    downloadSubmitted,
    focusField: (id) => { const f = fieldsById.get(id); if (f) C.scrollToField(f); },
    openOptions: () => chrome.runtime.sendMessage({ type: 'open-options' }),
    openTracker: () => chrome.runtime.sendMessage({ type: 'open-tracker' }),
    analyzeIfNeeded: () => { if (!st.analysis && st.analysisStatus !== 'working' && (st.isPosting || (st.job && (st.job.description || '').length >= 200))) analyze(); },
    open: async (tab) => { await refreshJob(); ui().mount(); ui().open(tab || (st.isPosting && !st.isApp ? 'match' : 'autofill')); },
    toggle: async () => {
      if (ui().isOpen) return ui().close();
      await refreshJob();
      ui().mount();
      ui().open(st.isPosting && !st.isApp ? 'match' : 'autofill');
    },
  };
  // Popup entry points
  window.__autofill = (opts) => autofill(opts);
})();
