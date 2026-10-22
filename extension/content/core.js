// Core page logic: reading forms ("eyes"), filling them ("hands"), and
// recognizing job postings / applications. No UI and no network here.
(() => {
  const JA = (window.__JA = window.__JA || {});
  if (JA.core) return;
  const C = (JA.core = {});

  // ---------- helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const textOf = (el) => (el ? el.innerText || el.textContent || '' : '');
  const isVisible = (el) => !!(el && (el.offsetParent || el.getClientRects().length));
  const ours = (el) => !!(el && el.closest && el.closest('#__ja-root'));
  const PLACEHOLDER = /^(select|choose|--|please select|start typing|search|select one)/i;
  // Never sent to the AI or stored in memory.
  const SENSITIVE = /password|card number|credit card|\bcvv\b|\bcvc\b|security code|social security|\bssn\b|bank account|routing number/;
  Object.assign(C, { sleep, norm, textOf, isVisible });

  // ---------- reading labels ----------
  function labelFor(el) {
    const parts = [];
    if (el.labels) for (const l of el.labels) parts.push(textOf(l));
    const lb = el.getAttribute('aria-labelledby');
    if (lb) lb.split(/\s+/).forEach((id) => parts.push(textOf(document.getElementById(id))));
    parts.push(el.getAttribute('aria-label') || '');
    if (!parts.some((p) => p.trim())) {
      // No explicit label: look for a nearby label-ish element (Lever, custom forms).
      let n = el.parentElement;
      for (let i = 0; i < 5 && n && n !== document.body; i++, n = n.parentElement) {
        const lab = n.querySelector('label, legend, [class*="label" i], [class*="question" i]');
        if (lab && !lab.contains(el) && textOf(lab).trim()) { parts.push(textOf(lab)); break; }
      }
    }
    let s = parts.join(' ');
    if (el.tagName === 'SELECT') for (const o of el.options) s = s.replace(o.text, ' ');
    return norm(s);
  }

  function attrsOf(el) {
    const raw = ['name', 'id', 'placeholder', 'autocomplete', 'data-automation-id', 'data-qa']
      .map((a) => el.getAttribute(a) || '').join(' ');
    return norm(raw.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-\[\].]/g, ' '));
  }

  // Nearest heading above a field ("Work Experience", "Education", "Voluntary Disclosures").
  function sectionOf(el) {
    let n = el;
    for (let i = 0; i < 8 && n && n !== document.body; i++) {
      n = n.parentElement;
      if (!n) break;
      let best = null;
      for (const h of n.querySelectorAll('h1,h2,h3,h4,h5,legend,[role="heading"]')) {
        if (h.contains(el) || ours(h)) continue;
        if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = h;
      }
      if (best) {
        const t = textOf(best).replace(/\s+/g, ' ').trim();
        if (t && t.length < 80) return t;
      }
    }
    return '';
  }

  // ---------- option matching ----------
  const DECLINE = /decline|prefer not|don.?t wish|do not wish|choose not|not to (say|answer|disclose)/;
  function bestOption(options, value) {
    const v = norm(value);
    if (!v) return null;
    const yes = /^(yes|y|true)$/.test(v);
    const no = /^(no|n|false)$/.test(v);
    const decline = DECLINE.test(v);
    let best = null, bestScore = 0;
    for (const o of options) {
      const t = norm(o.text);
      if (!t || PLACEHOLDER.test(t)) continue;
      let s = 0;
      if (t === v) s = 100;
      else if (yes && /^yes\b/.test(t)) s = 90;
      else if (no && /^no\b/.test(t)) s = 90;
      else if (decline && DECLINE.test(t)) s = 85;
      else if (t.startsWith(v)) s = 70;
      else if (v.length > 2 && new RegExp('\\b' + esc(v) + '\\b').test(t)) s = 60;
      else if (t.length > 2 && v.includes(t)) s = 50;
      if (s > bestScore) { best = o; bestScore = s; }
    }
    return best;
  }

  // ---------- "hands" ----------
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function realClick(el) {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  const visibleOptions = () => [...document.querySelectorAll('[role="option"]')].filter((o) => isVisible(o) && !ours(o));

  async function openPopup(el) {
    if (el.focus) el.focus();
    realClick(el);
    let opts = [];
    for (let i = 0; i < 8 && !opts.length; i++) {
      await sleep(150);
      opts = visibleOptions();
      if (!opts.length && i === 2) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    }
    return opts;
  }

  function closePopup(el) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    if (el.blur) el.blur();
  }

  // Custom dropdowns only render options when opened: click, wait, read, close.
  async function readPopupOptions(el) {
    const opts = await openPopup(el);
    const texts = [...new Set(opts.map((o) => textOf(o).trim()).filter(Boolean))].slice(0, 200);
    closePopup(el);
    await sleep(100);
    return texts;
  }

  async function fillCombobox(el, value) {
    await openPopup(el);
    setNativeValue(el, value); // typing filters the list / triggers async search
    let opts = [];
    for (let i = 0; i < 8; i++) {
      await sleep(200);
      opts = visibleOptions();
      if (opts.length) break;
    }
    const o = bestOption(opts.map((e) => ({ text: textOf(e), el: e })), value);
    if (o) { realClick(o.el); return true; }
    closePopup(el);
    return false;
  }

  // Button-style dropdowns (Workday): click the button, pick an option.
  async function fillListbox(el, value) {
    const opts = await openPopup(el);
    const o = bestOption(opts.map((e) => ({ text: textOf(e), el: e })), value);
    if (o) { realClick(o.el); await sleep(150); return true; }
    closePopup(el);
    return false;
  }

  async function attachFile(input, file) {
    const blob = await (await fetch(file.data)).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], file.name, { type: file.type || blob.type }));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function clickChoice(input) {
    ((input.labels && input.labels[0]) || input).click();
  }

  // ---------- radio / checkbox groups ----------
  function optionText(el) {
    if (el.labels && el.labels.length) return textOf(el.labels[0]).trim();
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const p = el.parentElement;
    if (p && textOf(p).trim().length < 80) return textOf(p).trim();
    return el.value;
  }

  function groupQuestion(inputs) {
    const fs = inputs[0].closest('fieldset');
    const lg = fs && fs.querySelector('legend');
    if (lg && textOf(lg).trim()) return norm(textOf(lg));
    const rg = inputs[0].closest('[role="radiogroup"], [role="group"]');
    if (rg) {
      const l = labelFor(rg);
      if (l) return l;
    }
    let n = inputs[0].parentElement;
    while (n && !inputs.every((i) => n.contains(i))) n = n.parentElement;
    for (let i = 0; i < 3 && n && n !== document.body; i++, n = n.parentElement) {
      let t = textOf(n);
      for (const o of inputs) t = t.replace(optionText(o), ' ');
      t = norm(t);
      if (t.length > 3) return t.slice(0, 300);
    }
    return '';
  }

  // ---------- "eyes": scan the page into field descriptors ----------
  function comboShown(el) {
    const c = el.closest('[class*="select__control" i], [class*="select" i], [class*="combobox" i]') || el.parentElement;
    const shown = norm(textOf(c));
    return shown && !PLACEHOLDER.test(shown) ? textOf(c).trim() : '';
  }

  function scan(opts = {}) {
    const fields = [];
    let n = 0;
    const groups = new Map();
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (el.disabled || ours(el)) continue;
      const t = (el.type || '').toLowerCase();
      if (t === 'password') {
        // Only on sign-in / sign-up pages; the value never leaves the browser.
        if (opts.auth && isVisible(el) && !el.readOnly) {
          fields.push({ id: 'f' + n++, kind: 'password', el, label: labelFor(el) || 'password', hint: attrsOf(el), filled: !!el.value, required: true });
        }
        continue;
      }
      if (/^(hidden|submit|button|image|reset|search)$/.test(t)) continue;
      if (t === 'radio' || t === 'checkbox') {
        const k = el.name || el.closest('fieldset, [role="radiogroup"], [role="group"]') || el;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(el);
        continue;
      }
      const label = labelFor(el);
      const hint = attrsOf(el);
      if (SENSITIVE.test(label) || (SENSITIVE.test(hint) && !/password/.test(hint))) continue;
      if (t === 'file') {
        fields.push({ id: 'f' + n++, kind: 'file', el, label: label || hint, hint, filled: el.files.length > 0 });
        continue;
      }
      if (!isVisible(el) || el.readOnly) continue;
      const kind = el.tagName === 'SELECT' ? 'select'
        : el.tagName === 'TEXTAREA' ? 'textarea'
        : (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list') ? 'combobox'
        : 'text';
      const f = { id: 'f' + n++, kind, el, label, hint, inputType: t,
        required: el.required || el.getAttribute('aria-required') === 'true' || label.includes('*') };
      if (kind === 'select') {
        f.options = [...el.options].map((o) => o.text.trim()).filter((x) => x && !PLACEHOLDER.test(x));
        const cur = el.options[el.selectedIndex];
        f.filled = !!cur && el.selectedIndex > 0 && !PLACEHOLDER.test(cur.text.trim());
      } else if (kind === 'combobox') {
        f.filled = !!(el.value || comboShown(el));
      } else {
        f.filled = !!el.value;
      }
      fields.push(f);
    }
    // Button dropdowns (Workday and other custom UIs)
    for (const b of document.querySelectorAll('button[aria-haspopup="listbox"], [role="button"][aria-haspopup="listbox"]')) {
      if (b.disabled || ours(b) || !isVisible(b)) continue;
      const shown = textOf(b).replace(/\s+/g, ' ').trim();
      let label = labelFor(b);
      if (shown) label = label.replace(norm(shown), ' ');
      label = norm(label.replace(/\bselect one\b|\brequired\b/gi, ' '));
      if (!label) label = norm(sectionOf(b));
      fields.push({ id: 'f' + n++, kind: 'listbox', el: b, label, hint: attrsOf(b),
        required: b.getAttribute('aria-required') === 'true' || /required/i.test(b.getAttribute('aria-label') || '') || label.includes('*'),
        filled: !!shown && !PLACEHOLDER.test(shown) });
    }
    for (const inputs of groups.values()) {
      const shown = inputs.filter((i) => isVisible(i) || (i.labels && isVisible(i.labels[0])));
      if (!shown.length) continue;
      const single = inputs.length === 1;
      const label = single ? norm(optionText(inputs[0])) : groupQuestion(inputs);
      if (SENSITIVE.test(label)) continue;
      fields.push({
        id: 'f' + n++, kind: inputs[0].type === 'radio' ? 'radio' : 'checkbox', els: inputs, single, label,
        options: single ? undefined : inputs.map(optionText),
        required: inputs.some((i) => i.required) || label.includes('*'),
        filled: inputs.some((i) => i.checked),
      });
    }
    // Page order, then section + entry numbers for repeated blocks.
    fields.sort((a, b) => (anchor(a).compareDocumentPosition(anchor(b)) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const byLabel = new Map();
    for (const f of fields) {
      f.section = sectionOf(anchor(f));
      const k = f.kind + '|' + f.label;
      if (!byLabel.has(k)) byLabel.set(k, []);
      byLabel.get(k).push(f);
    }
    for (const same of byLabel.values()) {
      if (same.length > 1 && same[0].label) same.forEach((f, i) => { f.entry = `${i + 1} of ${same.length}`; });
    }
    for (const f of fields) {
      if (f.filled && f.kind !== 'password' && f.kind !== 'file') {
        const v = readValue(f);
        f.current = Array.isArray(v) ? v : String(v).slice(0, 1500);
      }
    }
    return fields;
  }

  const anchor = (f) => f.el || f.els[0];
  const signature = (f) => `${f.kind}|${f.label}|${f.hint || ''}|${f.entry || ''}`;

  function aiType(f) {
    if (f.kind === 'file') return 'file_upload';
    if (f.kind === 'select' || f.kind === 'listbox') return 'dropdown';
    if (f.kind === 'combobox') return f.options && f.options.length ? 'dropdown' : 'text';
    if (f.kind === 'password') return 'password';
    if (f.kind === 'radio') return 'single_select';
    if (f.kind === 'checkbox') return f.single ? 'checkbox' : 'multi_select';
    return f.kind; // text | textarea
  }

  // What's currently in a field, as the user would describe it.
  function readValue(f) {
    switch (f.kind) {
      case 'select': {
        const o = f.el.options[f.el.selectedIndex];
        return o && f.el.selectedIndex > 0 && !PLACEHOLDER.test(o.text.trim()) ? o.text.trim() : '';
      }
      case 'combobox': return comboShown(f.el) || f.el.value.trim();
      case 'listbox': { const t = textOf(f.el).trim(); return t && !PLACEHOLDER.test(t) ? t : ''; }
      case 'radio': { const c = f.els.find((i) => i.checked); return c ? optionText(c) : ''; }
      case 'checkbox':
        if (f.single) return f.els[0].checked ? 'Yes' : '';
        return f.els.filter((i) => i.checked).map(optionText);
      case 'file': return f.el.files && f.el.files[0] ? f.el.files[0].name : '';
      default: return f.el.value.trim();
    }
  }

  async function fillField(f, value, resume) {
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) return false;
    const str = Array.isArray(value) ? value.join(', ') : String(value);
    switch (f.kind) {
      case 'file':
        if (!/resume|cv/i.test(str) || !resume || !resume.data) return false;
        await attachFile(f.el, resume);
        return true;
      case 'select': {
        const o = bestOption([...f.el.options].map((op) => ({ text: op.text, el: op })), str);
        if (!o) return false;
        setNativeValue(f.el, o.el.value);
        return true;
      }
      case 'combobox':
        return fillCombobox(f.el, str);
      case 'listbox':
        return fillListbox(f.el, str);
      case 'radio':
      case 'checkbox': {
        if (f.single) {
          const want = /^(yes|true|checked|y)$/i.test(str);
          if (f.els[0].checked !== want) clickChoice(f.els[0]);
          return want;
        }
        const wanted = Array.isArray(value) ? value : [value];
        const opts = f.els.map((i) => ({ text: optionText(i), el: i }));
        const chosen = new Set();
        for (const v of wanted) {
          const o = bestOption(opts, String(v));
          if (!o) continue;
          chosen.add(o.el);
          if (!o.el.checked) clickChoice(o.el);
          if (f.kind === 'radio') break;
        }
        if (f.kind === 'checkbox' && chosen.size) {
          for (const i of f.els) if (i.checked && !chosen.has(i)) clickChoice(i); // override wrong pre-checks
        }
        return chosen.size > 0;
      }
      default: {
        if (f.kind !== 'password' && f.el.value === str) return true;
        if (f.inputType === 'number' && isNaN(Number(str))) return false;
        if (f.inputType === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
        f.el.focus();
        setNativeValue(f.el, str);
        f.el.dispatchEvent(new Event('blur', { bubbles: true }));
        return true;
      }
    }
  }

  function outlineTarget(f) {
    if (f.kind === 'combobox') return f.el.closest('[class*="select__control" i]') || f.el;
    if (f.el) return f.el;
    if (f.single) return (f.els[0].labels && f.els[0].labels[0]) || f.els[0];
    return f.els[0].closest('fieldset') || f.els[0].parentElement.parentElement || f.els[0];
  }

  function highlight(f, color, title, persist) {
    const t = outlineTarget(f);
    const prev = t.style.outline;
    t.style.outline = `2px solid ${color}`;
    t.style.outlineOffset = '2px';
    if (title) t.title = title;
    if (!persist) setTimeout(() => { t.style.outline = prev; }, 4000);
  }

  function scrollToField(f) {
    const t = outlineTarget(f);
    t.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const prev = t.style.boxShadow;
    t.style.boxShadow = '0 0 0 4px rgba(79,70,229,.35)';
    setTimeout(() => { t.style.boxShadow = prev; }, 1600);
    const focusable = f.el || f.els[0];
    setTimeout(() => focusable.focus && focusable.focus({ preventScroll: true }), 400);
  }

  // ---------- repeating sections ("Add another job") ----------
  const KIND_RE = {
    exp: /experience|employment|work history|positions?\b|jobs?\b/i,
    edu: /education|school|degree|academic/i,
  };
  const ENTRY_RE = {
    exp: /company|employer|organi[sz]ation/,
    edu: /school|university|institution|college/,
  };
  const ADD_RE = /^\s*\+?\s*add(\s+(another|more|new))?(\s+(work\s+)?(experience|employment|job|position|education|school|degree))?\s*\+?\s*$/i;

  function addButtons(kind) {
    const out = [];
    for (const b of document.querySelectorAll('button, [role="button"], a')) {
      if (ours(b) || !isVisible(b)) continue;
      const t = (textOf(b).trim() || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ');
      if (!t || t.length > 40 || !ADD_RE.test(t)) continue;
      const own = KIND_RE.exp.test(t) ? 'exp' : KIND_RE.edu.test(t) ? 'edu' : null;
      const sec = own || (KIND_RE.exp.test(sectionOf(b)) ? 'exp' : KIND_RE.edu.test(sectionOf(b)) ? 'edu' : null);
      if (sec === kind) out.push(b);
    }
    return out;
  }

  function sectionRoot(btn, kind) {
    let n = btn;
    for (let i = 0; i < 8 && n && n.parentElement && n.parentElement !== document.body; i++) {
      n = n.parentElement;
      const h = n.querySelector('h1,h2,h3,h4,h5,legend,[role="heading"]');
      if (h && KIND_RE[kind].test(textOf(h))) return n;
    }
    return btn.parentElement && btn.parentElement.parentElement ? btn.parentElement.parentElement : document.body;
  }

  function countEntries(kind, root) {
    let c = 0;
    for (const el of root.querySelectorAll('input, select, button[aria-haspopup="listbox"]')) {
      if (!ours(el) && isVisible(el) && ENTRY_RE[kind].test(labelFor(el))) c++;
    }
    return c;
  }

  // Click "Add another" until there's a block for each résumé entry (capped).
  async function expandRepeaters(history) {
    if (!history) return 0;
    const need = { exp: Math.min((history.experience || []).length, 5), edu: Math.min((history.education || []).length, 3) };
    let clicks = 0;
    for (const kind of ['exp', 'edu']) {
      if (!need[kind]) continue;
      for (let round = 0; round < 6; round++) {
        const btn = addButtons(kind)[0];
        if (!btn) break;
        const root = sectionRoot(btn, kind);
        const have = countEntries(kind, root);
        if (have >= need[kind]) break;
        btn.click();
        clicks++;
        await sleep(700);
        if (countEntries(kind, sectionRoot(btn, kind)) <= have) break; // nothing appeared
      }
    }
    return clicks;
  }

  // ---------- job posting ----------
  function jobKey(url) {
    try {
      const u = new URL(url);
      const path = u.pathname.replace(/\/(apply|application|applications|applyManually)(\/.*)?$/i, '').replace(/\/+$/, '');
      const keep = ['gh_jid', 'token', 'for', 'jobId', 'job', 'jk', 'currentJobId']
        .filter((k) => u.searchParams.has(k)).map((k) => `${k}=${u.searchParams.get(k)}`).join('&');
      return u.host + path + (keep ? '?' + keep : '');
    } catch { return url; }
  }

  function htmlToText(html) {
    const d = new DOMParser().parseFromString(String(html || ''), 'text/html');
    d.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
    d.querySelectorAll('p,li,div,h1,h2,h3,h4').forEach((b) => b.append('\n'));
    return (d.body.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  }

  function jobFromJsonLd() {
    const found = [];
    const walk = (x) => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) return x.forEach(walk);
      const t = x['@type'];
      if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) found.push(x);
      if (x['@graph']) walk(x['@graph']);
    };
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { walk(JSON.parse(s.textContent)); } catch {}
    }
    const j = found[0];
    if (!j) return null;
    const org = j.hiringOrganization;
    const locs = [].concat(j.jobLocation || []).map((l) => {
      const a = (l && l.address) || {};
      return [a.addressLocality, a.addressRegion, a.addressCountry && a.addressCountry.name ? a.addressCountry.name : a.addressCountry]
        .filter((x) => typeof x === 'string' && x).join(', ');
    }).filter(Boolean);
    if (/telecommute/i.test(j.jobLocationType || '')) locs.push('Remote');
    return {
      title: htmlToText(j.title || ''),
      company: typeof org === 'string' ? org : (org && org.name) || '',
      location: [...new Set(locs)].slice(0, 3).join(' · '),
      description: htmlToText(j.description || ''),
    };
  }

  const DESC_SELECTORS = [
    '[data-automation-id="jobPostingDescription"]', '#job-description', '.job__description', '.job-description',
    '[class*="job-description" i]', '[id*="job-description" i]', '.posting-page .section-wrapper', '.posting', '#content',
    '[class*="jobDescription" i]', '[class*="description" i]', 'main', 'article',
  ];
  function descriptionGuess() {
    for (const sel of DESC_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && !ours(el)) {
        const t = textOf(el).replace(/\n{3,}/g, '\n\n').trim();
        if (t.length > 300) return t;
      }
    }
    return '';
  }

  function titleGuess() {
    for (const h of document.querySelectorAll('h1, [data-automation-id="jobPostingHeader"]')) {
      const t = textOf(h).trim();
      if (t && t.length < 140 && isVisible(h) && !ours(h)) return t;
    }
    const og = document.querySelector('meta[property="og:title"]');
    return ((og && og.content) || document.title).split(/\s[|–—-]\s/)[0].trim();
  }

  function companyGuess() {
    const host = location.host, seg = location.pathname.split('/').filter(Boolean);
    const cap = (s) => decodeURIComponent(s || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    if (/greenhouse\.io$/.test(host) && seg[0] && seg[0] !== 'embed') return cap(seg[0]);
    if (/(lever\.co|ashbyhq\.com|smartrecruiters\.com|workable\.com|breezy\.hr|recruitee\.com)$/.test(host) && seg[0]) return cap(seg[0]);
    if (/myworkdayjobs\.com$/.test(host)) return cap(host.split('.')[0]);
    const site = document.querySelector('meta[property="og:site_name"]');
    if (site && site.content) return site.content.trim();
    const at = document.title.match(/\bat\s+([^|–—-]+)/i);
    if (at) return at[1].trim();
    const parts = host.replace(/^(www|jobs|careers|apply)\./, '').split('.');
    return cap(parts[0]);
  }

  function getJob() {
    const ld = jobFromJsonLd();
    const description = (ld && ld.description) || descriptionGuess();
    return {
      key: jobKey(location.href),
      url: location.href,
      title: (ld && ld.title) || titleGuess(),
      company: (ld && ld.company) || companyGuess(),
      location: (ld && ld.location) || '',
      description: description.slice(0, 12000),
      fromLd: !!ld,
    };
  }

  // ---------- detection ----------
  const ATS = /greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workday\.com|smartrecruiters\.com|icims\.com|jobvite\.com|bamboohr\.com|workable\.com|recruitee\.com|rippling\.com|breezy\.hr|jazzhr\.com|applytojob\.com|teamtailor\.com|personio\.|pinpointhq\.com|dover\.com|wellfound\.com|taleo\.net|successfactors\.|oraclecloud\.com/;
  const JOB_WORDS = /\b(apply|application|résumé|resume|\bcv\b|cover letter|work authori[sz]ation|sponsorship|linkedin profile|desired salary|years of experience|equal employment|voluntary self.identification)\b/i;
  const POSTING_WORDS = /responsibilit|requirements|qualifications|what you('ll| will) do|about the role|who you are|what we('re| are) looking for/i;

  function formFieldCount() {
    return [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select, button[aria-haspopup="listbox"]')]
      .filter((e) => !ours(e) && (isVisible(e) || e.type === 'file')).length;
  }

  // inFlow: autopilot is already mid-application in this tab, so any real form counts.
  function looksLikeApplication(inFlow = false) {
    if (isAuthPage()) return false; // sign-in / sign-up
    const count = formFieldCount();
    if (count < 3) return false;
    if (inFlow) return true;
    const fields = { length: count };
    if (ATS.test(location.host)) return true;
    const hasResume = [...document.querySelectorAll('input[type=file]')]
      .some((f) => /resume|résumé|\bcv\b/i.test(f.name + ' ' + f.id + ' ' + labelFor(f)));
    if (hasResume) return true;
    const formText = [...document.querySelectorAll('form, main, [role="main"]')].map(textOf).join(' ').slice(0, 20000) || textOf(document.body).slice(0, 20000);
    return JOB_WORDS.test(formText) && fields.length >= 4;
  }

  function looksLikeJobPosting() {
    if (jobFromJsonLd()) return true;
    const d = descriptionGuess();
    return d.length > 800 && POSTING_WORDS.test(d) && (ATS.test(location.host) || /\b(job|career|position|opening)s?\b/i.test(location.href + ' ' + document.title));
  }

  // ---------- autopilot helpers ----------
  const AGGREGATORS = /(^|\.)(linkedin\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com|monster\.com|simplyhired\.com|dice\.com|wellfound\.com|handshake\.com)$/;
  // Buttons the extension will never press, whatever the AI says.
  const NEVER_RE = /\b(submit|send|finish|finalize|complete|confirm and submit|withdraw|delete|remove application|cancel application|sign ?out|log ?out)\b/i;
  const isAggregator = () => AGGREGATORS.test(location.host);
  const isATS = () => ATS.test(location.host);

  function isAuthPage() {
    return [...document.querySelectorAll('input[type=password]')].some((el) => isVisible(el) && !ours(el));
  }

  function captchaPresent() {
    for (const f of document.querySelectorAll('iframe')) {
      const src = f.src || '';
      if (!/recaptcha|hcaptcha|challenges\.cloudflare|turnstile|arkoselabs|funcaptcha/i.test(src)) continue;
      if (f.closest('.grecaptcha-badge') || /size=invisible/.test(src)) continue;
      const r = f.getBoundingClientRect();
      if (r.width > 60 && r.height > 60 && isVisible(f)) return true;
    }
    return !!document.querySelector('#challenge-form, #cf-challenge-running');
  }

  let buttonMap = new Map();
  function buttonText(el) {
    return (textOf(el) || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
  }
  const LINK_RE = /apply|sign|log ?in|create|register|account|continue|next|manual|start|resume|proceed|review|accept|reject|cookies|necessary/i;
  function listButtons() {
    buttonMap = new Map();
    const out = [];
    let n = 0;
    const seen = new Set();
    for (const el of document.querySelectorAll('button, [role="button"], input[type=submit], input[type=button], a[href], [data-automation-id$="Button" i]')) {
      if (ours(el) || !isVisible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (el.tagName === 'A' && !el.matches('[role="button"]')) {
        const t = buttonText(el);
        if (!LINK_RE.test(t)) continue;
      }
      const text = buttonText(el);
      if (!text || text.length > 80 || seen.has(el)) continue;
      seen.add(el);
      const id = 'b' + n++;
      buttonMap.set(id, el);
      out.push({ id, text, kind: el.tagName === 'A' ? 'link' : 'button', el });
      if (out.length >= 60) break;
    }
    return out;
  }
  const buttonById = (id) => buttonMap.get(id);

  function pageInfo() {
    const heads = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')].filter((h) => isVisible(h) && !ours(h))
      .map((h) => textOf(h).replace(/\s+/g, ' ').trim()).filter((t) => t && t.length < 120).slice(0, 12);
    const errs = [...document.querySelectorAll('[role="alert"], [aria-live="assertive"], [class*="error" i], [data-automation-id*="error" i], [id*="error" i]')]
      .filter((e) => isVisible(e) && !ours(e)).map((e) => textOf(e).replace(/\s+/g, ' ').trim()).filter((t) => t && t.length < 300);
    const main = document.querySelector('main, [role="main"], form') || document.body;
    return {
      url: location.href,
      title: document.title,
      headings: heads,
      excerpt: textOf(main).replace(/\s+/g, ' ').trim().slice(0, 1500),
      errors: [...new Set(errs)].slice(0, 8),
      hasPasswordField: isAuthPage(),
    };
  }

  // A rough fingerprint used to notice when clicking "Next" didn't move the page.
  const pageSignature = () => location.href + '|' + pageInfo().headings.join('|') + '|' + document.querySelectorAll('input, select, textarea').length;

  Object.assign(C, {
    realClick, NEVER_RE, isAggregator, isATS, isAuthPage, captchaPresent, listButtons, buttonById, pageInfo, pageSignature,
  });

  Object.assign(C, {
    labelFor, sectionOf, scan, anchor, signature, aiType, readValue, fillField, highlight, scrollToField,
    readPopupOptions, expandRepeaters, getJob, jobKey, looksLikeApplication, looksLikeJobPosting, ours,
  });
})();
