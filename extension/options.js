// ---------- profile schema: [key, label, type, extra] ----------
const YN = ['', 'Yes', 'No'];
const SCHEMA = [
  { title: 'Personal', fields: [
    ['firstName', 'First name'], ['lastName', 'Last name'],
    ['preferredName', 'Preferred name'], ['pronouns', 'Pronouns'],
    ['email', 'Email', 'email'], ['phone', 'Phone', 'tel'],
  ] },
  { title: 'Work eligibility', needs: true, note: "Your résumé can't tell us these. Most applications ask.", fields: [
    ['workAuthorized', 'Legally authorized to work in your country?', 'select', YN],
    ['needsSponsorship', 'Will you need visa sponsorship?', 'select', YN],
    ['relocate', 'Willing to relocate?', 'select', YN],
    ['salary', 'Salary expectation (optional)'],
    ['startDate', 'Earliest start date (optional)'],
  ] },
  { title: 'Links', fields: [
    ['linkedin', 'LinkedIn URL', 'url'], ['github', 'GitHub URL', 'url'],
    ['website', 'Portfolio / website', 'url'],
  ] },
  { title: 'Location', fields: [
    ['address', 'Street address'], ['city', 'City'], ['state', 'State / province'],
    ['zip', 'ZIP / postal code'], ['country', 'Country'],
    ['location', 'Location (leave blank to use "City, State")'],
  ] },
  { title: 'Work', fields: [
    ['currentCompany', 'Current / most recent company'], ['currentTitle', 'Current title'],
    ['yearsExperience', 'Years of experience'], ['howHeard', 'Default "How did you hear about us?"'],
  ] },
  { title: 'Education', fields: [
    ['school', 'School'], ['degree', "Degree (e.g. Bachelor's)"], ['major', 'Major'],
    ['gpa', 'GPA'], ['gradYear', 'Graduation year'],
  ] },
  { title: 'Voluntary self-identification', note: 'Optional. Leave blank and the AI will pick "decline to answer" when it can.', fields: [
    ['gender', 'Gender', 'list', ['Male', 'Female', 'Non-binary', 'Decline to self-identify']],
    ['hispanic', 'Hispanic or Latino?', 'list', ['Yes', 'No', 'Decline to self-identify']],
    ['race', 'Race / ethnicity', 'list', ['Asian', 'Black or African American', 'White', 'Two or more races', 'Native Hawaiian or Other Pacific Islander', 'American Indian or Alaska Native', 'Decline to self-identify']],
    ['veteran', 'Veteran status', 'list', ['I am not a protected veteran', 'I identify as one or more of the classifications of protected veteran', 'Decline to self-identify']],
    ['disability', 'Disability status', 'list', ['No, I do not have a disability', 'Yes, I have a disability', 'I do not want to answer']],
  ] },
  { title: 'Long answers', fields: [
    ['coverLetterText', 'Cover letter (pasted into cover letter text boxes)', 'textarea'],
  ] },
];
const NEEDED = ['workAuthorized', 'needsSponsorship'];

const $ = (id) => document.getElementById(id);
const form = $('form');
const show = (id) => ['welcome', 'wizard', 'main', 'done'].forEach((s) => ($(s).hidden = s !== id));

// ---------- render form ----------
for (const section of SCHEMA) {
  const wrap = document.createElement('div');
  if (section.needs) wrap.className = 'section-needs';
  const h = document.createElement('h2');
  h.textContent = section.title;
  wrap.appendChild(h);
  if (section.note) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = section.note;
    wrap.appendChild(p);
  }
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const [key, label, type = 'text', extra] of section.fields) {
    const l = document.createElement('label');
    l.textContent = label;
    let input;
    if (type === 'select') {
      input = document.createElement('select');
      extra.forEach((o) => input.add(new Option(o || '—', o)));
    } else if (type === 'textarea') {
      input = document.createElement('textarea');
      l.className = 'full';
    } else {
      input = document.createElement('input');
      input.type = type === 'list' ? 'text' : type;
      if (type === 'list') {
        const dl = document.createElement('datalist');
        dl.id = 'dl-' + key;
        extra.forEach((o) => dl.appendChild(new Option(o)));
        l.appendChild(dl);
        input.setAttribute('list', dl.id);
      }
    }
    input.name = key;
    input.addEventListener('input', () => { input.classList.remove('from-resume'); markNeeded(); });
    l.appendChild(input);
    grid.appendChild(l);
  }
  wrap.appendChild(grid);
  form.appendChild(wrap);
}

function markNeeded() {
  for (const k of NEEDED) {
    const el = form.elements[k];
    el.classList.toggle('needs', !el.value);
  }
}

// ---------- state ----------
let pendingResume = null;   // { name, type, data } not yet saved
let pendingResumeData = null; // experience / education / skills from the parser
let onboarding = false;

async function getSettings() {
  return (await chrome.storage.local.get('settings')).settings || {};
}

async function migrate() {
  const { resume, resumes } = await chrome.storage.local.get(['resume', 'resumes']);
  if (!resumes && resume) {
    const r = { id: 'r' + Date.now(), createdAt: Date.now(), label: 'Original', ...resume };
    await chrome.storage.local.set({ resumes: [r], activeResumeId: r.id });
  }
}

async function load() {
  await migrate();
  const { profile = {}, resumes = [], settings = {} } = await chrome.storage.local.get(['profile', 'resumes', 'settings']);
  for (const el of form.elements) if (el.name) el.value = profile[el.name] ?? '';
  await renderResumes();
  $('autopilot').checked = settings.autopilot !== false;
  $('autoAccount').checked = settings.autoAccount !== false;
  $('acceptTerms').checked = !!settings.acceptTerms;
  $('autoOpen').checked = settings.autoOpen !== false;
  $('autoAnalyze').checked = settings.autoAnalyze === true;
  $('autoFill').checked = settings.autoFill !== false;
  $('overwrite').checked = settings.overwrite !== false;
  renderPaused(settings.pausedHosts || []);
  $('backendUrl').value = settings.backendUrl || '';
  $('resumeText').value = settings.resumeText || '';
  markNeeded();
  return { profile, resumes };
}

// ---------- résumé list ----------
async function renderResumes() {
  const { resumes = [], activeResumeId } = await chrome.storage.local.get(['resumes', 'activeResumeId']);
  const list = $('resumeList');
  const rows = resumes.slice().sort((a, b) => (b.id === activeResumeId) - (a.id === activeResumeId) || (b.createdAt || 0) - (a.createdAt || 0));
  if (pendingResume) rows.unshift({ id: '__pending', name: pendingResume.name, label: 'New (not saved yet)', pending: true });
  if (!rows.length) { list.innerHTML = '<div class="empty">No résumé yet. Upload one below.</div>'; return; }
  list.innerHTML = '';
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'res';
    const sub = r.pending ? 'Click Save profile to keep it'
      : r.tailoredFor ? `Tailored for ${r.tailoredFor.title || ''} at ${r.tailoredFor.company || ''} · ${new Date(r.updatedAt || r.createdAt).toLocaleDateString()}${r.updatedAt ? ' (edited)' : ''}`
      : `${r.label || 'Uploaded'} · ${r.createdAt ? new Date(r.createdAt).toLocaleDateString() : ''}`;
    row.innerHTML = `<input type="radio" name="defaultResume" ${r.id === activeResumeId ? 'checked' : ''} ${r.pending ? 'disabled' : ''} title="Use by default">
      <div style="min-width:0"><div class="nm">${escapeHtml(r.name)}${r.id === activeResumeId ? ' <span class="tag brand">default</span>' : ''}</div><div class="sub">${escapeHtml(sub)}</div></div>
      <div class="acts">${r.pending ? '' : '<button data-a="dl">Download</button><button data-a="del">Delete</button>'}</div>`;
    if (!r.pending) {
      row.querySelector('input').onchange = async () => { await chrome.storage.local.set({ activeResumeId: r.id }); renderResumes(); };
      row.querySelector('[data-a=dl]').onclick = async () => {
        const { resumes: all = [] } = await chrome.storage.local.get('resumes');
        const full = all.find((x) => x.id === r.id);
        if (!full) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(await (await fetch(full.data)).blob());
        a.download = full.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      };
      row.querySelector('[data-a=del]').onclick = async () => {
        if (!confirm(`Delete ${r.name}?`)) return;
        const cur = await chrome.storage.local.get(['resumes', 'activeResumeId', 'jobResume']);
        const left = (cur.resumes || []).filter((x) => x.id !== r.id);
        const jobResume = Object.fromEntries(Object.entries(cur.jobResume || {}).filter(([, id]) => id !== r.id));
        const activeResumeId = cur.activeResumeId === r.id ? (left.find((x) => !x.tailoredFor) || left[0] || {}).id || null : cur.activeResumeId;
        await chrome.storage.local.set({ resumes: left, activeResumeId, jobResume });
        renderResumes();
      };
    }
    list.appendChild(row);
  }
}

// ---------- résumé -> profile ----------
const readAsDataURL = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

async function parseResume(file) {
  if (file.size > 10 * 1024 * 1024) throw new Error('That file is over 10 MB. Try a smaller PDF.');
  const dataUrl = await readAsDataURL(file);
  const settings = await getSettings();
  const base = ($('backendUrl').value.trim() || settings.backendUrl || 'http://localhost:8787').replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(base + '/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resume: { name: file.name, media_type: file.type, data: dataUrl.split(',')[1] } }),
    });
  } catch {
    throw new Error(`Couldn't reach the backend at ${base}.\nStart it in the server folder with:  node --env-file=.env server.js`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Backend returned ${res.status}`);
  return { file: { name: file.name, type: file.type, data: dataUrl }, parsed: body };
}

// Put extracted values into the form and highlight them.
function applyParsed({ file, parsed }) {
  let count = 0;
  for (const [k, v] of Object.entries(parsed.profile || {})) {
    const el = form.elements[k];
    if (!el || !v) continue;
    el.value = v;
    el.classList.add('from-resume');
    count++;
  }
  if (parsed.resumeText) $('resumeText').value = parsed.resumeText;
  pendingResume = { ...file, text: parsed.resumeText || '' };
  pendingResumeData = {
    experience: parsed.experience || [], education: parsed.education || [], skills: parsed.skills || [],
    projects: parsed.projects || [], certifications: parsed.certifications || [], languages: parsed.languages || [],
  };
  renderResumes();
  markNeeded();

  const missing = NEEDED.filter((k) => !form.elements[k].value).length;
  const b = $('banner');
  b.hidden = false;
  b.innerHTML = `<b>Filled ${count} field${count === 1 ? '' : 's'} from ${escapeHtml(file.name)}</b><span class="tag brand">highlighted</span><br>`
    + (missing ? `Check them, then answer the <b>work eligibility</b> questions<span class="tag warn">needed</span> and click <b>Save profile</b>.`
               : 'Check them, then click <b>Save profile</b>.');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- step 1: welcome ----------
async function handleWelcomeFile(file) {
  if (!file) return;
  const status = $('welcomeStatus');
  status.innerHTML = '<p><span class="spinner"></span>Reading your résumé… this takes about 10–20 seconds.</p>';
  try {
    const result = await parseResume(file);
    status.innerHTML = '';
    startWizard(result);
  } catch (e) {
    status.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'error';
    err.textContent = e.message;
    status.appendChild(err);
  }
}

const drop = $('drop');
$('welcomeFile').onchange = (e) => handleWelcomeFile(e.target.files[0]);
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => handleWelcomeFile(e.dataTransfer.files[0]));

$('manual').onclick = (e) => { e.preventDefault(); startWizard(null); };
$('rerun').onclick = (e) => { e.preventDefault(); startWizard(null); };

// ---------- guided setup ----------
async function startWizard(result) {
  const { profile = {}, settings = {} } = await chrome.storage.local.get(['profile', 'settings']);
  if (result) {
    pendingResume = { ...result.file, text: result.parsed.resumeText || '' };
    const p = result.parsed;
    pendingResumeData = {
      experience: p.experience || [], education: p.education || [], skills: p.skills || [],
      projects: p.projects || [], certifications: p.certifications || [], languages: p.languages || [],
    };
  }
  show('wizard');
  JAWizard.start({ profile, parsed: (result && result.parsed.profile) || {}, existingSettings: settings }, async (wizProfile, wizSettings) => {
    const cur = await chrome.storage.local.get(['profile', 'settings', 'resumes']);
    const data = {
      profile: { ...(cur.profile || {}), ...wizProfile },
      settings: { ...(cur.settings || {}), ...wizSettings },
    };
    if (pendingResume) {
      const r = { id: 'r' + Date.now(), createdAt: Date.now(), label: 'Uploaded', ...pendingResume };
      data.resumes = (cur.resumes || []).concat(r);
      data.activeResumeId = r.id;
    }
    if (pendingResumeData) { data.resumeData = pendingResumeData; data.resumeDataVersion = 2; }
    await chrome.storage.local.set(data);
    pendingResume = pendingResumeData = null;
    onboarding = false;
    await load();
    show('done');
  });
}
$('editAgain').onclick = (e) => { e.preventDefault(); onboarding = false; show('main'); };

// ---------- re-upload from the profile page ----------
$('resumeFile').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = $('resumeStatus');
  status.innerHTML = '<span class="spinner"></span>Reading…';
  try {
    const result = await parseResume(file);
    status.textContent = '';
    startWizard(result); // check the new résumé's details step by step
  } catch (err) {
    status.textContent = '';
    alert(err.message);
  }
  e.target.value = '';
};

// ---------- save ----------
$('save').onclick = async () => {
  const profile = {};
  for (const el of form.elements) if (el.name) profile[el.name] = el.value.trim();
  const data = {
    profile,
    settings: {
      ...(await getSettings()),
      autopilot: $('autopilot').checked,
      autoAccount: $('autoAccount').checked,
      acceptTerms: $('acceptTerms').checked,
      autoOpen: $('autoOpen').checked,
      autoAnalyze: $('autoAnalyze').checked,
      autoFill: $('autoFill').checked,
      overwrite: $('overwrite').checked,
      backendUrl: $('backendUrl').value.trim(),
      resumeText: $('resumeText').value.trim(),
    },
  };
  if (pendingResume) {
    const { resumes = [] } = await chrome.storage.local.get('resumes');
    const r = { id: 'r' + Date.now(), createdAt: Date.now(), label: 'Uploaded', ...pendingResume };
    data.resumes = resumes.concat(r);
    data.activeResumeId = r.id;
  }
  if (pendingResumeData) { data.resumeData = pendingResumeData; data.resumeDataVersion = 2; }
  await chrome.storage.local.set(data);
  pendingResume = pendingResumeData = null;
  $('banner').hidden = true;
  form.querySelectorAll('.from-resume').forEach((el) => el.classList.remove('from-resume'));
  await load();
  if (onboarding) { onboarding = false; show('done'); return; }
  $('saved').textContent = '✓ Saved';
  setTimeout(() => ($('saved').textContent = ''), 2000);
};

// ---------- start ----------
load().then(({ profile, resumes }) => {
  const isNew = !resumes.length && !Object.values(profile).some(Boolean);
  onboarding = isNew;
  show(isNew ? 'welcome' : 'main');
});

// ---------- paused sites ----------
function renderPaused(hosts) {
  const row = $('pausedRow');
  row.hidden = !hosts.length;
  if (!hosts.length) return;
  row.innerHTML = `Paused on: ${hosts.map(escapeHtml).join(', ')} · <a href="#" id="resumeAll">Resume all</a>`;
  $('resumeAll').onclick = async (e) => {
    e.preventDefault();
    const settings = await getSettings();
    await chrome.storage.local.set({ settings: { ...settings, pausedHosts: [] } });
    renderPaused([]);
  };
}

// ---------- answer memory ----------
let memory = [];

async function loadMemory() {
  memory = (await chrome.storage.local.get('memory')).memory || [];
  renderMemory();
}

async function saveMemory() {
  await chrome.storage.local.set({ memory });
}

function renderMemory() {
  $('memCount').textContent = String(memory.length);
  const q = $('memSearch').value.trim().toLowerCase();
  const list = $('memList');
  const rows = memory
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => !q || (m.q + ' ' + [].concat(m.a).join(' ')).toLowerCase().includes(q));
  if (!rows.length) {
    list.innerHTML = `<div class="empty">${memory.length ? 'No matches.' : 'Nothing yet. Answers are saved here when you submit an application or click Next.'}</div>`;
    return;
  }
  list.innerHTML = '';
  for (const { m, i } of rows) {
    const row = document.createElement('div');
    row.className = 'mem';
    const answer = Array.isArray(m.a) ? m.a.join(', ') : m.a;
    const long = !Array.isArray(m.a) && (answer.length > 80 || m.type === 'textarea');
    const when = new Date(m.t).toLocaleDateString();
    row.innerHTML = `
      <div class="q"><span class="src ${m.src === 'you' ? 'you' : 'ai'}">${m.src === 'you' ? 'You' : 'AI'}</span>${escapeHtml(m.q)}</div>
      <div class="meta">${escapeHtml(m.host || '')} · used ${m.n || 1}× · ${when} <button class="del" title="Forget this answer">×</button></div>
      <div class="a">${long ? '<textarea></textarea>' : '<input>'}</div>`;
    const input = row.querySelector('textarea, input');
    input.value = answer;
    input.onchange = async () => {
      const v = input.value.trim();
      memory[i].a = Array.isArray(m.a) ? v.split(/\s*,\s*/).filter(Boolean) : v;
      memory[i].src = 'you'; // an edit here counts as your own answer
      memory[i].t = Date.now();
      await saveMemory();
      renderMemory();
    };
    row.querySelector('.del').onclick = async () => {
      memory.splice(i, 1);
      await saveMemory();
      renderMemory();
    };
    list.appendChild(row);
  }
}

$('memSearch').oninput = renderMemory;

$('memExport').onclick = () => {
  const blob = new Blob([JSON.stringify(memory, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'fillup-answer-memory.json';
  a.click();
  URL.revokeObjectURL(a.href);
};

$('memImport').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const incoming = JSON.parse(await file.text());
    if (!Array.isArray(incoming)) throw new Error('Expected a list of answers');
    const byKey = new Map(memory.map((m) => [m.key + '|' + m.type, m]));
    for (const m of incoming) {
      if (!m || !m.q || m.a == null) continue;
      const entry = { key: (m.key || m.q).toLowerCase().replace(/\s+/g, ' ').trim(), type: m.type || 'text', src: m.src || 'you', n: m.n || 1, t: m.t || Date.now(), host: m.host || '', q: m.q, a: m.a };
      byKey.set(entry.key + '|' + entry.type, entry);
    }
    memory = [...byKey.values()].sort((a, b) => b.t - a.t);
    await saveMemory();
    renderMemory();
  } catch (err) {
    alert('Could not import: ' + err.message);
  }
};

$('memClear').onclick = async () => {
  if (!confirm(`Forget all ${memory.length} remembered answers?`)) return;
  memory = [];
  await saveMemory();
  renderMemory();
};

// Refresh when an application is submitted in another tab.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.memory && document.activeElement?.closest?.('.mem') == null) loadMemory();
  if (changes.settings) renderPaused((changes.settings.newValue || {}).pausedHosts || []);
  if (changes.resumes || changes.activeResumeId) renderResumes();
});

loadMemory();

// ---------- accounts ----------
async function renderAccounts() {
  const res = await chrome.runtime.sendMessage({ type: 'vault-list' }).catch(() => null);
  const accounts = (res && res.accounts) || [];
  $('accCount').textContent = String(accounts.length);
  const list = $('accList');
  if (!accounts.length) { list.innerHTML = '<div class="empty">No accounts yet. Autopilot adds them when a job site asks you to sign up.</div>'; return; }
  list.innerHTML = '';
  for (const a of accounts.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0))) {
    const row = document.createElement('div');
    row.className = 'res';
    row.innerHTML = `<span style="font-size:18px">🔑</span>
      <div style="min-width:0"><div class="nm">${escapeHtml(a.site)}</div><div class="sub">${escapeHtml(a.email || '')} · ${a.source === 'saved' ? 'saved by you' : 'created by autopilot'} · ${a.createdAt ? new Date(a.createdAt).toLocaleDateString() : ''} <span class="pwv" style="font-family:ui-monospace,monospace;color:#111827"></span></div></div>
      <div class="acts"><button data-a="show">Show</button><button data-a="copy">Copy</button><button data-a="del">Delete</button></div>`;
    const reveal = async () => ((await chrome.runtime.sendMessage({ type: 'vault-get', site: a.site })) || {}).creds?.password || '';
    row.querySelector('[data-a=show]').onclick = async (e) => {
      const span = row.querySelector('.pwv');
      if (span.textContent) { span.textContent = ''; e.target.textContent = 'Show'; return; }
      span.textContent = '· ' + (await reveal());
      e.target.textContent = 'Hide';
    };
    row.querySelector('[data-a=copy]').onclick = async (e) => {
      try { await navigator.clipboard.writeText(await reveal()); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Failed'; }
      setTimeout(() => (e.target.textContent = 'Copy'), 1500);
    };
    row.querySelector('[data-a=del]').onclick = async () => {
      if (!confirm(`Forget the saved password for ${a.site}? (Your account on the site stays.)`)) return;
      await chrome.runtime.sendMessage({ type: 'vault-delete', site: a.site });
      renderAccounts();
    };
    list.appendChild(row);
  }
}
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.vault) renderAccounts(); });
renderAccounts();

// ---------- keyboard shortcut ----------
chrome.commands.getAll().then((cmds) => {
  const c = cmds.find((x) => x.name === 'toggle-sidebar');
  const el = $('shortcut');
  el.innerHTML = (c && c.shortcut ? `Open / close the sidebar with <b>${escapeHtml(c.shortcut)}</b>. ` : 'No keyboard shortcut is set for the sidebar. ')
    + '<a href="#" id="scLink">Change shortcut</a> · Drag the sidebar by its header, resize from any edge, double-click the header to dock it.';
  $('scLink').onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); };
}).catch(() => {});
