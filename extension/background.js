// Service worker: relays AI requests to the local backend, stores the answer
// memory and the application tracker, and migrates older saved data.

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await migrate();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(migrate);

// Keyboard shortcut (default Alt+Shift+J / Option+Shift+J; change it at chrome://extensions/shortcuts).
const CONTENT_FILES = ['content/core.js', 'content/sidebar.js', 'content/main.js'];
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-sidebar') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^(https?|file):/.test(tab.url || '')) return;
  try {
    // Tabs opened before the extension loaded don't have the scripts yet; re-injecting is harmless.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.__JA && window.__JA.actions && window.__JA.actions.toggle(),
    });
  } catch (e) {
    console.warn('Fillup: cannot open the sidebar on this page', e);
  }
});

// v0.5 kept one résumé under `resume`; now there's a list.
async function migrate() {
  const { resume, resumes } = await chrome.storage.local.get(['resume', 'resumes']);
  if (!resumes && resume) {
    const r = { id: 'r' + Date.now(), createdAt: Date.now(), label: 'Original', ...resume };
    await chrome.storage.local.set({ resumes: [r], activeResumeId: r.id });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  const reply = (p) => p.then((data) => sendResponse({ ok: true, ...data }))
    .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
  switch (msg.type) {
    case 'api': reply(callBackend(msg.path, msg.payload).then((data) => ({ data }))); return true;
    case 'track': reply(trackQueue = trackQueue.then(() => upsertApp(msg.entry, msg.onlyIfExists))); return true;
    case 'pending-files': reply(trackQueue = trackQueue.then(() => addPendingFiles(msg.key, msg.field, msg.files))); return true;
    case 'remember':
      queue = queue.then(() => remember(msg.entries)).catch((e) => console.warn('remember failed', e));
      sendResponse({ ok: true });
      return;
    case 'vault-get': reply(vaultGet(msg.site)); return true;
    case 'vault-create': reply(vaultCreate(msg.site, msg.email, msg.url)); return true;
    case 'vault-save': reply(vaultSave(msg.site, msg.email, msg.password, msg.url)); return true;
    case 'vault-list': reply(vaultList()); return true;
    case 'vault-delete': reply(vaultDelete(msg.site)); return true;
    case 'flow': reply(flow(_sender.tab && _sender.tab.id, msg.op, msg.data)); return true;
    case 'open-options': chrome.runtime.openOptionsPage(); return;
    case 'open-tracker': chrome.tabs.create({ url: chrome.runtime.getURL('tracker.html') }); return;
  }
});

// Content scripts can't call localhost freely (site CSP/CORS), so the worker does it.
async function callBackend(path, payload) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const base = (settings.backendUrl || 'http://localhost:8787').replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error(`Can't reach the backend at ${base}. Is the server running?`);
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 404 && path !== '/fill') throw new Error('Your server is an older version. Restart it after updating server.js.');
  if (!res.ok) throw new Error(body.error || `Backend returned ${res.status}`);
  return body;
}

// ---------- application tracker ----------
// Each: { key, url, title, company, location, status, fit, verdict, resumeName, notes, createdAt, updatedAt, appliedAt }
let trackQueue = Promise.resolve();
async function upsertApp(entry, onlyIfExists) {
  const { applications = [] } = await chrome.storage.local.get('applications');
  const i = applications.findIndex((a) => a.key === entry.key);
  if (entry.remove) {
    if (i >= 0) applications.splice(i, 1);
    await chrome.storage.local.set({ applications });
    await chrome.storage.local.remove('submission:' + entry.key);
    return { app: null };
  }
  const snapshot = entry.snapshot;
  delete entry.snapshot;
  if (i < 0 && onlyIfExists) return { app: null };
  const clean = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined && v !== ''));
  const now = Date.now();
  let app;
  if (i < 0) {
    app = { status: 'saved', createdAt: now, ...clean, updatedAt: now };
    applications.unshift(app);
  } else {
    app = applications[i];
    // Don't let an automatic "applied" overwrite a later stage the user set.
    const order = ['saved', 'applied', 'interviewing', 'offer', 'rejected'];
    if (clean.status === 'applied' && order.indexOf(app.status) > 1) delete clean.status;
    if (clean.appliedAt && app.appliedAt) delete clean.appliedAt;
    Object.assign(app, clean, { updatedAt: now });
  }
  if (app.status === 'applied' && !app.appliedAt) app.appliedAt = now;
  if (snapshot) {
    const files = await takeSubmission(entry.key, entry.resumeId);
    if (files.length) {
      app.files = files.map(({ field, name, size }) => ({ field, name, size }));
      app.submittedAt = now;
    }
  }
  await chrome.storage.local.set({ applications: applications.slice(0, 1000) });
  return { app };
}

// ---------- files submitted with each application ----------
// pending:<jobKey>    copies taken when files were attached, per upload field
// submission:<jobKey> the files that went out with the application
async function addPendingFiles(key, field, files) {
  if (!key || !Array.isArray(files) || !files.length) return {};
  const k = 'pending:' + key;
  const cur = (await chrome.storage.local.get(k))[k] || { fields: {} };
  cur.fields[field || 'file'] = files;
  cur.t = Date.now();
  await chrome.storage.local.set({ [k]: cur });
  return {};
}

async function takeSubmission(key, resumeId) {
  const pk = 'pending:' + key;
  const pending = (await chrome.storage.local.get(pk))[pk];
  let files = [];
  if (pending && Date.now() - pending.t < 3 * 24 * 3600 * 1000) {
    for (const [field, list] of Object.entries(pending.fields)) for (const f of list) files.push({ field, ...f });
  }
  if (!files.length && resumeId) {
    // Nothing was seen being attached (e.g. the site uploaded it its own way): keep the résumé that was selected.
    const { resumes = [] } = await chrome.storage.local.get('resumes');
    const r = resumes.find((x) => x.id === resumeId);
    if (r && r.data) files.push({ field: 'Résumé (selected for this job)', name: r.name, type: r.type, size: Math.round(r.data.length * 0.75), data: r.data });
  }
  if (files.length) await chrome.storage.local.set({ ['submission:' + key]: { files, at: Date.now() } });
  await chrome.storage.local.remove(pk);
  return files;
}

// Drop copies for applications that were never submitted (older than 3 days).
async function cleanupPending() {
  const all = await chrome.storage.local.get(null);
  const old = Object.keys(all).filter((k) => k.startsWith('pending:') && Date.now() - (all[k].t || 0) > 3 * 24 * 3600 * 1000);
  if (old.length) await chrome.storage.local.remove(old);
}
chrome.runtime.onStartup.addListener(cleanupPending);

// ---------- answer memory ----------
// Each entry: { q, key, type, a, src: 'you' | 'ai', n, t, host }
let queue = Promise.resolve();
const MAX_MEMORY = 500;

async function remember(entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  const { memory = [] } = await chrome.storage.local.get('memory');
  const index = new Map(memory.map((m, i) => [m.key + '|' + m.type, i]));
  const now = Date.now();
  for (const e of entries) {
    const k = e.key + '|' + e.type;
    const i = index.get(k);
    if (i === undefined) {
      memory.push({ ...e, n: 1, t: now });
      index.set(k, memory.length - 1);
      continue;
    }
    const m = memory[i];
    const same = JSON.stringify(m.a) === JSON.stringify(e.a);
    if (same) {
      if (e.src === 'you') m.src = 'you';
      if (now - m.t > 60_000) m.n = (m.n || 1) + 1;
    } else if (e.src === 'you' || m.src !== 'you') {
      Object.assign(m, { a: e.a, src: e.src, q: e.q, n: 1 });
    } else {
      continue; // keep the answer you gave over an unedited AI answer
    }
    m.t = now;
    m.host = e.host;
  }
  memory.sort((a, b) => b.t - a.t);
  if (memory.length > MAX_MEMORY) memory.length = MAX_MEMORY;
  await chrome.storage.local.set({ memory });
}

// ---------- autopilot state per tab ----------
// Lets autopilot follow an application across sites (e.g. company page -> Workday) in the same tab.
async function flow(tabId, op, data) {
  if (tabId == null) return { flow: null };
  const area = chrome.storage.session || chrome.storage.local;
  const key = 'flow:' + tabId;
  const cur = (await area.get(key))[key] || null;
  if (op === 'get') return { flow: cur };
  if (op === 'set') {
    const next = { ...(cur || {}), ...data, t: Date.now() };
    await area.set({ [key]: next });
    return { flow: next };
  }
  if (op === 'clear') { await area.remove(key); return { flow: null }; }
  return { flow: cur };
}
chrome.tabs.onRemoved.addListener((tabId) => (chrome.storage.session || chrome.storage.local).remove('flow:' + tabId));

// ---------- account vault ----------
// Passwords are encrypted with an AES-GCM key that never leaves this browser
// (non-extractable, kept in the extension's IndexedDB).
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('job-autofill', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
let keyPromise = null;
function vaultKey() {
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    const db = await idb();
    const get = () => new Promise((res, rej) => { const q = db.transaction('keys').objectStore('keys').get('vault'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    let key = await get();
    if (!key) {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await new Promise((res, rej) => { const tx = db.transaction('keys', 'readwrite'); tx.objectStore('keys').put(key, 'vault'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    }
    return key;
  })();
  return keyPromise;
}
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function encrypt(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await vaultKey(), new TextEncoder().encode(text));
  return { iv: b64(iv), ct: b64(ct) };
}
async function decrypt({ iv, ct }) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await vaultKey(), unb64(ct));
  return new TextDecoder().decode(pt);
}

// Meets common rules: 16+ chars, upper, lower, digit, symbol; no look-alike characters.
function generatePassword(len = 18) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!@#$%&*?-_+='];
  const all = sets.join('');
  const pick = (chars) => chars[crypto.getRandomValues(new Uint32Array(1))[0] % chars.length];
  const out = sets.map(pick);
  while (out.length < len) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) { const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join('');
}

let vaultQueue = Promise.resolve();
const withVault = (fn) => (vaultQueue = vaultQueue.then(async () => {
  const { vault = {} } = await chrome.storage.local.get('vault');
  const out = await fn(vault);
  await chrome.storage.local.set({ vault });
  return out;
}));

async function vaultGet(site) {
  const { vault = {} } = await chrome.storage.local.get('vault');
  const v = vault[site];
  if (!v) return { creds: null };
  try { return { creds: { email: v.email, password: await decrypt(v.secret) } }; }
  catch { return { creds: null, error: 'Saved password could not be decrypted' }; }
}
function vaultCreate(site, email, url) {
  return withVault(async (vault) => {
    if (vault[site]) return { creds: { email: vault[site].email, password: await decrypt(vault[site].secret) }, created: false };
    const password = generatePassword();
    vault[site] = { email, secret: await encrypt(password), url: url || '', createdAt: Date.now(), updatedAt: Date.now(), source: 'generated' };
    return { creds: { email, password }, created: true };
  });
}
function vaultSave(site, email, password, url) {
  return withVault(async (vault) => {
    vault[site] = { ...(vault[site] || { createdAt: Date.now() }), email, secret: await encrypt(password), url: url || (vault[site] || {}).url || '', updatedAt: Date.now(), source: 'saved' };
    return { ok: true };
  });
}
async function vaultList() {
  const { vault = {} } = await chrome.storage.local.get('vault');
  return { accounts: Object.entries(vault).map(([site, v]) => ({ site, email: v.email, url: v.url, createdAt: v.createdAt, source: v.source })) };
}
function vaultDelete(site) {
  return withVault(async (vault) => { delete vault[site]; return { ok: true }; });
}
