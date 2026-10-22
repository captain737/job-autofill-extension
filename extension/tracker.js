const $ = (id) => document.getElementById(id);
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUSES = [['saved', 'Saved'], ['applied', 'Applied'], ['interviewing', 'Interviewing'], ['offer', 'Offer'], ['rejected', 'Rejected']];
const fitColor = (f) => (f >= 85 ? '#16a34a' : f >= 70 ? '#4f46e5' : f >= 50 ? '#d97706' : '#dc2626');
let apps = [];

STATUSES.forEach(([k, l]) => $('status').add(new Option(l, k)));

async function load() {
  apps = (await chrome.storage.local.get('applications')).applications || [];
  render();
}

async function save() {
  await chrome.storage.local.set({ applications: apps });
}

function render() {
  const count = (s) => apps.filter((a) => a.status === s).length;
  const fits = apps.map((a) => a.fit).filter((f) => typeof f === 'number');
  const stats = [
    [count('saved'), 'Saved'],
    [count('applied') + count('interviewing') + count('offer') + count('rejected'), 'Applied'],
    [count('interviewing'), 'Interviewing'],
    [count('offer'), 'Offers'],
    [fits.length ? Math.round(fits.reduce((x, y) => x + y, 0) / fits.length) + '%' : '–', 'Average fit'],
  ];
  $('stats').innerHTML = stats.map(([n, l]) => `<div class="stat"><div class="n">${h(n)}</div><div class="l">${h(l)}</div></div>`).join('');

  const q = $('q').value.trim().toLowerCase();
  const st = $('status').value;
  const sort = $('sort').value;
  let rows = apps.map((a, i) => ({ a, i }))
    .filter(({ a }) => (!st || a.status === st) && (!q || [a.company, a.title, a.location, a.notes].join(' ').toLowerCase().includes(q)));
  if (sort === 'fit') rows.sort((x, y) => (y.a.fit ?? -1) - (x.a.fit ?? -1));
  else if (sort === 'company') rows.sort((x, y) => String(x.a.company).localeCompare(String(y.a.company)));
  else rows.sort((x, y) => (y.a.updatedAt || 0) - (x.a.updatedAt || 0));

  const list = $('list');
  if (!rows.length) {
    list.innerHTML = `<div class="empty">${apps.length ? 'No applications match.' : 'Nothing tracked yet. Submit an application or save a job from the sidebar, and it shows up here.'}</div>`;
    return;
  }
  list.innerHTML = rows.map(({ a, i }) => {
    const when = a.appliedAt ? `Applied ${new Date(a.appliedAt).toLocaleDateString()}` : `Saved ${new Date(a.createdAt).toLocaleDateString()}`;
    return `<div class="row" data-i="${i}">
      <div style="min-width:0"><div class="t"><a href="${h(a.url)}" target="_blank" rel="noopener">${h(a.title || 'Untitled role')}</a></div>
        <div class="c">${h([a.company, a.location].filter(Boolean).join(' · '))}${a.files && a.files.length ? '' : a.resumeName ? ` · 📄 ${h(a.resumeName)}` : ''}</div>
        ${a.files && a.files.length ? `<div class="files">${a.files.map((f, j) => `<a href="#" data-file="${j}" title="${h(f.field || '')}">📄 ${h(f.name)}</a>`).join('')}<span class="muted small">submitted</span></div>` : ''}</div>
      <div>${typeof a.fit === 'number' ? `<div class="fit" style="background:${fitColor(a.fit)}">${a.fit}%</div>` : '<div class="muted small" style="text-align:center">–</div>'}</div>
      <div class="st"><select data-a="status">${STATUSES.map(([k, l]) => `<option value="${k}" ${a.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="date">${h(when)}</div>
      <button class="del" data-a="del" title="Remove">×</button>
      <div class="notes"><textarea data-a="notes" placeholder="Notes: recruiter, salary range, next steps…">${h(a.notes || '')}</textarea></div>
    </div>`;
  }).join('');
  list.querySelectorAll('.row').forEach((row) => {
    const a = apps[+row.dataset.i];
    row.querySelector('[data-a=status]').onchange = async (e) => {
      a.status = e.target.value;
      if (a.status !== 'saved' && !a.appliedAt) a.appliedAt = Date.now();
      a.updatedAt = Date.now();
      await save();
      render();
    };
    row.querySelectorAll('[data-file]').forEach((link) => {
      link.onclick = async (e) => {
        e.preventDefault();
        const k = 'submission:' + a.key;
        const sub = (await chrome.storage.local.get(k))[k];
        const f = sub && sub.files[+link.dataset.file];
        if (!f) { alert('That file is no longer saved.'); return; }
        const dl = document.createElement('a');
        dl.href = URL.createObjectURL(await (await fetch(f.data)).blob());
        dl.download = f.name;
        dl.click();
        setTimeout(() => URL.revokeObjectURL(dl.href), 2000);
      };
    });
    row.querySelector('[data-a=notes]').onchange = async (e) => { a.notes = e.target.value; a.updatedAt = Date.now(); await save(); };
    row.querySelector('[data-a=del]').onclick = async () => {
      if (!confirm(`Remove ${a.title} at ${a.company}?`)) return;
      apps.splice(+row.dataset.i, 1);
      await save();
      await chrome.storage.local.remove('submission:' + a.key);
      render();
    };
  });
}

['q', 'status', 'sort'].forEach((id) => $(id).addEventListener('input', render));

$('export').onclick = () => {
  const cols = ['company', 'title', 'location', 'status', 'fit', 'appliedAt', 'createdAt', 'submittedFiles', 'url', 'notes'];
  const cell = (v, k) => {
    if (v == null) return '';
    if ((k === 'appliedAt' || k === 'createdAt') && v) v = new Date(v).toISOString().slice(0, 10);
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(','), ...apps.map((a) => cols.map((k) => cell(k === 'submittedFiles' ? (a.files ? a.files.map((f) => f.name).join('; ') : a.resumeName) : a[k], k)).join(','))].join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = `job-applications-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
};

// ---------- job search suggestions ----------
function searchLinks(title, loc) {
  const q = encodeURIComponent(title), l = encodeURIComponent(loc || '');
  const ats = encodeURIComponent(`(site:boards.greenhouse.io OR site:job-boards.greenhouse.io OR site:jobs.lever.co OR site:jobs.ashbyhq.com) "${title}" ${loc && !/remote/i.test(loc) ? `"${loc}"` : loc || ''}`);
  return [
    ['LinkedIn', `https://www.linkedin.com/jobs/search/?keywords=${q}&location=${l}`],
    ['Indeed', `https://www.indeed.com/jobs?q=${q}&l=${l}`],
    ['Google Jobs', `https://www.google.com/search?q=${encodeURIComponent(`${title} jobs ${loc || ''}`)}&ibp=htl;jobs`],
    ['Greenhouse · Lever · Ashby', `https://www.google.com/search?q=${ats}`],
  ];
}

function renderRecs(r) {
  if (!r) { $('recs').innerHTML = ''; return; }
  const loc = (r.locations || [])[0] || '';
  $('recs').innerHTML = `
    ${r.titles.map((t) => `<div class="title-rec"><div style="min-width:0"><b>${h(t.title)}</b><div class="muted small">${h(t.why)}</div></div>
      <div class="links">${searchLinks(t.title, loc).map(([n, u]) => `<a href="${h(u)}" target="_blank" rel="noopener">${h(n)} ↗</a>`).join('')}</div></div>`).join('')}
    ${r.keywords.length ? `<div style="margin-top:14px"><b class="small">Search keywords</b><div class="chips">${r.keywords.map((k) => `<span class="chip">${h(k)}</span>`).join('')}</div></div>` : ''}
    ${r.locations.length ? `<div style="margin-top:10px" class="small muted">Locations: ${h(r.locations.join(' · '))}</div>` : ''}
    ${r.companyTypes.length ? `<div style="margin-top:12px"><b class="small">Where you'd stand out</b><ul class="small" style="margin:4px 0 0;padding-left:18px">${r.companyTypes.map((c) => `<li>${h(c)}</li>`).join('')}</ul></div>` : ''}
    ${r.tips.length ? `<div style="margin-top:12px"><b class="small">Tips</b><ul class="small" style="margin:4px 0 0;padding-left:18px">${r.tips.map((c) => `<li>${h(c)}</li>`).join('')}</ul></div>` : ''}
    <div class="muted small" style="margin-top:12px">Suggested ${new Date(r.t).toLocaleDateString()}</div>`;
}

$('suggest').onclick = async () => {
  const btn = $('suggest');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Thinking…';
  try {
    const s = await chrome.storage.local.get(['profile', 'resumes', 'activeResumeId', 'resumeData', 'settings']);
    const resumes = s.resumes || [];
    const r = resumes.find((x) => x.id === s.activeResumeId) || resumes[0];
    const isPdf = r && /pdf/i.test(r.type || r.name || '');
    const base = ((s.settings || {}).backendUrl || 'http://localhost:8787').replace(/\/+$/, '');
    const payload = {
      profile: Object.fromEntries(Object.entries(s.profile || {}).filter(([, v]) => v)),
      resume: isPdf ? { media_type: 'application/pdf', data: r.data.split(',')[1] } : null,
      resumeText: isPdf ? '' : (r && r.text) || (s.settings || {}).resumeText || '',
      history: r ? null : s.resumeData || null, // the résumé already has these facts
      applications: apps.slice(0, 40).map(({ title, company, status, fit }) => ({ title, company, status, fit })),
    };
    let res;
    try {
      res = await fetch(base + '/recommend', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    } catch { throw new Error(`Can't reach the backend at ${base}. Is the server running?`); }
    const body = await res.json().catch(() => ({}));
    if (res.status === 404) throw new Error('Your server is an older version. Restart it after updating server.js.');
    if (!res.ok) throw new Error(body.error || `Backend returned ${res.status}`);
    body.t = Date.now();
    await chrome.storage.local.set({ recommendations: body });
    renderRecs(body);
  } catch (e) {
    $('recs').innerHTML = `<div class="err">${h(e.message)}</div>`;
  }
  btn.disabled = false;
  btn.textContent = 'Suggest searches';
};

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.applications && !document.activeElement.matches('textarea')) load();
});

load();
chrome.storage.local.get('recommendations').then(({ recommendations }) => renderRecs(recommendations));
