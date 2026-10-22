// Guided setup after the résumé is read: 8 steps, every field answered before moving on.
// Fields that don't apply to everyone can be marked "Doesn't apply" (saved as empty) instead of left blank.
(() => {
  const YN = ['Yes', 'No'];
  const DECLINE = 'Decline to self-identify';
  // [key, label, type, { na, options, placeholder, check, full }]
  const STEPS = [
    { title: 'Personal', note: 'Check what we read from your résumé.', fields: [
      ['firstName', 'First name', 'text'],
      ['lastName', 'Last name', 'text'],
      ['preferredName', 'Preferred name', 'text', { na: true }],
      ['pronouns', 'Pronouns', 'list', { na: true, options: ['she/her', 'he/him', 'they/them'] }],
      ['email', 'Email', 'email', { check: 'email' }],
      ['phone', 'Phone', 'tel', { check: 'phone' }],
    ] },
    { title: 'Work eligibility', note: "Your résumé can't tell us these, and almost every application asks.", fields: [
      ['workAuthorized', 'Are you legally authorized to work in your country?', 'select', { options: YN }],
      ['needsSponsorship', 'Will you now or in the future need visa sponsorship?', 'select', { options: YN }],
      ['relocate', 'Are you willing to relocate?', 'select', { options: YN }],
      ['salary', 'Salary expectation', 'text', { na: true, placeholder: 'e.g. $150,000 or 140–160k' }],
      ['startDate', 'Earliest start date', 'text', { placeholder: "e.g. Immediately, 2 weeks' notice, June 2027" }],
    ] },
    { title: 'Links', note: 'Full URLs work best. Tick "Doesn\'t apply" for any you don\'t have.', fields: [
      ['linkedin', 'LinkedIn URL', 'url', { na: true, check: 'url' }],
      ['github', 'GitHub URL', 'url', { na: true, check: 'url' }],
      ['website', 'Portfolio / personal website', 'url', { na: true, check: 'url' }],
    ] },
    { title: 'Location', note: 'Where you live now.', fields: [
      ['address', 'Street address', 'text', { na: true }],
      ['city', 'City', 'text'],
      ['state', 'State / province', 'text'],
      ['zip', 'ZIP / postal code', 'text', { na: true }],
      ['country', 'Country', 'text'],
      ['location', 'Location as it should appear on applications', 'text', { placeholder: 'e.g. San Francisco, CA' }],
    ] },
    { title: 'Work', note: 'Your current or most recent role.', fields: [
      ['currentCompany', 'Current / most recent company', 'text', { na: true }],
      ['currentTitle', 'Current / most recent title', 'text', { na: true }],
      ['yearsExperience', 'Years of professional experience', 'number', { check: 'number' }],
      ['howHeard', 'Default answer to "How did you hear about us?"', 'text', { na: true, placeholder: 'e.g. LinkedIn, Company website' }],
    ] },
    { title: 'Education', note: 'Your highest or most recent degree. Tick "Doesn\'t apply" if you don\'t have one.', fields: [
      ['school', 'School', 'text', { na: true }],
      ['degree', "Degree (e.g. Bachelor's)", 'list', { na: true, options: ["High school", "Associate's", "Bachelor's", "Master's", 'MBA', 'PhD', 'Bootcamp / certificate'] }],
      ['major', 'Major / field of study', 'text', { na: true }],
      ['gpa', 'GPA', 'text', { na: true }],
      ['gradYear', 'Graduation year', 'text', { na: true, check: 'year' }],
    ] },
    { title: 'Voluntary self-identification', note: `Used only for the optional EEO questions on US applications. "${DECLINE}" is always a valid answer.`, fields: [
      ['gender', 'Gender', 'select', { options: ['Male', 'Female', 'Non-binary', DECLINE] }],
      ['hispanic', 'Are you Hispanic or Latino?', 'select', { options: ['Yes', 'No', DECLINE] }],
      ['race', 'Race / ethnicity', 'select', { options: ['American Indian or Alaska Native', 'Asian', 'Black or African American', 'Native Hawaiian or Other Pacific Islander', 'White', 'Two or more races', DECLINE] }],
      ['veteran', 'Veteran status', 'select', { options: ['I am not a protected veteran', 'I identify as one or more of the classifications of protected veteran', DECLINE] }],
      ['disability', 'Disability status', 'select', { options: ['No, I do not have a disability', 'Yes, I have a disability (or previously had a disability)', 'I do not want to answer'] }],
    ] },
    { title: 'Settings', note: 'How the extension behaves on job sites. You can change these any time.', settings: [
      ['autopilot', true, 'Autopilot: click Apply, sign in / create accounts, and click Next through each step. It never clicks Submit.'],
      ['autoAccount', true, 'Create accounts automatically on job sites (unique strong password per site, saved encrypted in this browser)'],
      ['acceptTerms', false, 'When creating an account, tick the site\'s "I agree to the terms" box for me'],
      ['autoOpen', true, 'Open the sidebar automatically on application forms'],
      ['autoFill', true, 'Fill job applications automatically as soon as they\'re detected'],
      ['autoAnalyze', false, 'Score my fit on every job posting I open (otherwise only when I open Match or autopilot applies)'],
      ['overwrite', true, "Correct fields a site already pre-filled (recommended; sites' résumé parsers are often wrong)"],
    ] },
  ];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let draft = {}, na = new Set(), fromResume = new Set(), settings = {}, step = 0, reached = 0, onFinish = null;

  function start({ profile = {}, parsed = {}, existingSettings = {} }, finish) {
    draft = { ...profile };
    fromResume = new Set();
    for (const [k, v] of Object.entries(parsed)) if (v) { draft[k] = v; fromResume.add(k); }
    if (!draft.location && draft.city) draft.location = [draft.city, draft.state].filter(Boolean).join(', ');
    na = new Set();
    settings = {};
    for (const [k, def] of STEPS[STEPS.length - 1].settings) settings[k] = existingSettings[k] ?? def;
    step = 0;
    reached = 0;
    onFinish = finish;
    render();
  }

  function check(kind, v) {
    if (kind === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || 'Enter a valid email address.';
    if (kind === 'phone') return (v.replace(/\D/g, '').length >= 7) || 'Enter a full phone number.';
    if (kind === 'url') return /^https?:\/\/\S+\.\S+/.test(v) || 'Enter a full URL starting with https://';
    if (kind === 'number') return (/^\d+(\.\d+)?$/.test(v)) || 'Enter a number (0 is fine).';
    if (kind === 'year') return /^(19|20)\d{2}$/.test(v) || 'Enter a 4-digit year.';
    return true;
  }

  function render() {
    const S = STEPS[step];
    $('wzSteps').innerHTML = STEPS.map((s, i) => `<li class="${i === step ? 'on' : i < reached || i < step ? 'done' : ''}" data-i="${i}">
      <span class="n">${i < step || (i < reached && i !== step) ? '✓' : i + 1}</span><span class="l">${esc(s.title)}</span></li>`).join('');
    $('wzSteps').querySelectorAll('li').forEach((li) => {
      const i = +li.dataset.i;
      if (i <= reached && i !== step) li.onclick = () => { collect(); if (i > step && !validate()) return; step = i; render(); };
    });
    $('wzTitle').textContent = `${step + 1}. ${S.title}`;
    const fromCount = (S.fields || []).filter(([k]) => fromResume.has(k)).length;
    $('wzNote').innerHTML = esc(S.note) + (fromCount ? ` <span class="tag brand">${fromCount} from your résumé</span>` : '');
    $('wzErr').hidden = true;
    const box = $('wzFields');
    if (S.settings) {
      box.className = '';
      box.innerHTML = S.settings.map(([k, , label]) => `<label class="check"><input type="checkbox" data-s="${k}" ${settings[k] ? 'checked' : ''}> <span>${esc(label)}</span></label>`).join('');
    } else {
      box.className = 'grid';
      box.innerHTML = S.fields.map(([k, label, type, o = {}]) => {
        const v = draft[k] ?? '';
        const isNa = na.has(k);
        let input;
        if (type === 'select') {
          input = `<select data-k="${k}" ${isNa ? 'disabled' : ''}><option value="">Choose…</option>${o.options.map((x) => `<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>`;
        } else {
          const list = type === 'list' ? `list="wzl-${k}"` : '';
          const dl = type === 'list' ? `<datalist id="wzl-${k}">${o.options.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>` : '';
          input = `<input data-k="${k}" type="${type === 'list' ? 'text' : type}" ${list} value="${esc(v)}" placeholder="${esc(o.placeholder || '')}" ${isNa ? 'disabled' : ''}>${dl}`;
        }
        return `<div class="wf ${o.full ? 'full' : ''}" data-f="${k}">
          <div class="wl"><span>${esc(label)}</span>${o.na ? `<label class="na"><input type="checkbox" data-na="${k}" ${isNa ? 'checked' : ''}> Doesn't apply</label>` : ''}</div>
          <div class="${fromResume.has(k) && !isNa ? 'from-resume-wrap' : ''}">${input}</div>
          <div class="ferr" hidden></div></div>`;
      }).join('');
      box.querySelectorAll('[data-na]').forEach((cb) => {
        cb.onchange = () => {
          const k = cb.dataset.na;
          collect();
          cb.checked ? na.add(k) : na.delete(k);
          if (cb.checked) draft[k] = '';
          render();
        };
      });
      box.querySelectorAll('[data-k]').forEach((el) => {
        if (fromResume.has(el.dataset.k) && !na.has(el.dataset.k)) el.classList.add('from-resume');
        el.addEventListener('input', () => {
          el.classList.remove('from-resume');
          const w = el.closest('.wf');
          w.classList.remove('bad');
          w.querySelector('.ferr').hidden = true;
        });
      });
    }
    $('wzBack').hidden = step === 0;
    $('wzNext').textContent = step === STEPS.length - 1 ? 'Finish setup' : `Next: ${STEPS[step + 1].title} →`;
    window.scrollTo(0, 0);
    const first = box.querySelector('input:not([disabled]):not([type=checkbox]), select:not([disabled])');
    if (first && !first.value) first.focus();
  }

  function collect() {
    const S = STEPS[step];
    if (S.settings) {
      $('wzFields').querySelectorAll('[data-s]').forEach((cb) => { settings[cb.dataset.s] = cb.checked; });
      return;
    }
    $('wzFields').querySelectorAll('[data-k]').forEach((el) => {
      let v = el.value.trim();
      if (el.type === 'url' && v && !/^https?:\/\//i.test(v)) v = 'https://' + v; // linkedin.com/in/x -> https://...
      draft[el.dataset.k] = v;
    });
  }

  function validate() {
    const S = STEPS[step];
    if (S.settings) return true;
    let ok = true;
    for (const [k, , , o = {}] of S.fields) {
      const w = $('wzFields').querySelector(`[data-f="${k}"]`);
      const err = w.querySelector('.ferr');
      let msg = '';
      if (na.has(k)) msg = '';
      else if (!draft[k]) msg = o.na ? 'Fill this in, or tick "Doesn\'t apply".' : 'This is required.';
      else if (o.check) { const r = check(o.check, draft[k]); if (r !== true) msg = r; }
      w.classList.toggle('bad', !!msg);
      err.hidden = !msg;
      err.textContent = msg;
      if (msg) ok = false;
    }
    if (!ok) {
      $('wzErr').hidden = false;
      $('wzErr').textContent = 'Every field needs an answer before you continue.';
      const bad = $('wzFields').querySelector('.bad input:not([type=checkbox]), .bad select');
      if (bad) bad.focus();
    }
    return ok;
  }

  $('wzNext').onclick = async () => {
    collect();
    if (!validate()) return;
    if (step < STEPS.length - 1) {
      step++;
      reached = Math.max(reached, step);
      render();
      return;
    }
    const profile = {};
    for (const s of STEPS) for (const [k] of s.fields || []) profile[k] = na.has(k) ? '' : (draft[k] || '');
    $('wzNext').disabled = true;
    try { await onFinish(profile, { ...settings }); } finally { $('wzNext').disabled = false; }
  };
  $('wzBack').onclick = () => { collect(); if (step > 0) { step--; render(); } };

  window.JAWizard = { start, steps: STEPS };
})();
