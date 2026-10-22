// Job intelligence: fit analysis, tailored résumés, job-search suggestions, autopilot navigation.
// Plugged into server.js with the shared LLM helpers.

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v == null ? '' : String(v)).trim();
const strs = (v, n = 40) => arr(v).map(str).filter(Boolean).slice(0, n);
const list = (items) => ({ type: 'array', items });
const S = { type: 'string' };
const obj = (props) => ({
  type: 'object',
  properties: props,
  required: Object.keys(props),
  additionalProperties: false,
});

const GROUNDING = `Ground everything in the candidate's résumé, profile and work history. Never invent employers, titles, dates, degrees, metrics, skills or credentials. If the résumé is silent on something, treat it as missing.`;

// ---------- /analyze ----------
const ANALYZE_SCHEMA = obj({
  fitScore: { type: 'integer' },
  verdict: { type: 'string', enum: ['strong', 'good', 'fair', 'low'] },
  summary: S,
  matchedSkills: list(S),
  missingKeywords: list(S),
  strengths: list(S),
  gaps: list(S),
  suggestions: list(S),
  seniority: S,
  team: S,
  hiringManagerTitles: list(S),
});

const ANALYZE_SYSTEM = `You are a recruiter and ATS expert scoring how well a candidate fits one job.
${GROUNDING}

Return:
- fitScore: 0-100. 85+ = clearly qualified on must-haves; 70-84 = qualified with small gaps; 50-69 = several real gaps; <50 = poor match. Weigh must-have requirements far above nice-to-haves. Be honest, not encouraging.
- verdict: strong (85+), good (70-84), fair (50-69), low (<50).
- summary: 1-2 plain sentences on why.
- matchedSkills: requirements/keywords from the posting the candidate clearly has (short phrases, as the posting words them), most important first, max 12.
- missingKeywords: important skills, tools or terms from the posting that do not appear in the résumé, most important first, max 12. These are what an ATS keyword scan would flag.
- strengths: up to 4 specific reasons the candidate fits, citing résumé facts.
- gaps: up to 4 specific shortfalls (years, domain, required tools, credentials).
- suggestions: up to 6 concrete, ATS-friendly résumé edits for this job, e.g. "Rename 'Data pipelines' bullet to mention Airflow, which you list under Skills". Only suggest adding a keyword when the résumé shows the candidate actually has that experience; otherwise say to address it honestly (cover letter, learning).
- seniority: the level the posting targets (e.g. "Senior, 5+ years").
- team: the team or org the role sits in, if stated, else "".
- hiringManagerTitles: 2-3 likely job titles of the hiring manager for this role (e.g. "Engineering Manager, Data Platform").`;

export async function analyze(p, { callLLM, contextBlocks }) {
  if (!p.job || !str(p.job.description)) throw new Error('No job description found on this page');
  const content = await contextBlocks(p);
  content.push({ type: 'text', text: 'Analyze the candidate\'s fit for this job.' });
  const { parsed } = await callLLM(ANALYZE_SYSTEM, content, ANALYZE_SCHEMA);
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed?.fitScore) || 0)));
  const verdict = ['strong', 'good', 'fair', 'low'].includes(parsed?.verdict) ? parsed.verdict
    : score >= 85 ? 'strong' : score >= 70 ? 'good' : score >= 50 ? 'fair' : 'low';
  return {
    fitScore: score,
    verdict,
    summary: str(parsed?.summary),
    matchedSkills: strs(parsed?.matchedSkills, 12),
    missingKeywords: strs(parsed?.missingKeywords, 12),
    strengths: strs(parsed?.strengths, 4),
    gaps: strs(parsed?.gaps, 4),
    suggestions: strs(parsed?.suggestions, 6),
    seniority: str(parsed?.seniority),
    team: str(parsed?.team),
    hiringManagerTitles: strs(parsed?.hiringManagerTitles, 3),
  };
}

// ---------- /tailor ----------
const TAILOR_SCHEMA = obj({
  name: S,
  headline: S,
  email: S,
  phone: S,
  location: S,
  links: list(S),
  summary: S,
  skills: list(obj({ group: S, items: list(S) })),
  experience: list(obj({ company: S, title: S, location: S, start: S, end: S, bullets: list(S) })),
  education: list(obj({ school: S, degree: S, major: S, start: S, end: S, details: S })),
  projects: list(obj({ name: S, subtitle: S, bullets: list(S) })),
  extras: list(obj({ heading: S, items: list(S) })),
  changes: list(S),
});

const TAILOR_SYSTEM = `You tailor a candidate's résumé to one job posting so it reads well to both an ATS and a recruiter.
${GROUNDING}

Rules
- Keep every employer, title, date range, school and degree exactly as in the original. Keep all roles; you may drop weak bullets from old roles.
- Rewrite and reorder bullets to lead with what this job cares about. Use the posting's wording for skills the candidate genuinely has (e.g. "ETL" vs "data pipelines"). Keep real numbers; never add new metrics.
- Never add a skill, tool or keyword the original résumé doesn't support, even if the job asks for it.
- headline: a short target line, e.g. "Data Engineer · Python, Airflow, PostgreSQL".
- summary: 2-3 sentences, first person implied (no "I"), specific to this job.
- skills: 2-4 groups (e.g. Languages, Data, Cloud), most relevant first, only skills from the original.
- Bullets: start with a strong verb, one line or two at most, no trailing periods, 3-5 for recent roles, 1-3 for older ones.
- projects / extras (certifications, awards, publications, languages): only if in the original; [] otherwise.
- Contact fields and links come from the résumé/profile; "" or [] if absent.
- Aim for one page of content; two at most for 10+ years of experience.
- changes: 3-6 short notes for the candidate on what you changed and why.`;

export async function tailor(p, { callLLM, contextBlocks }) {
  if (!p.job || !str(p.job.description)) throw new Error('No job description found for this job');
  const content = await contextBlocks(p);
  content.push({ type: 'text', text: 'Write the tailored résumé for this job.' });
  const { parsed: r } = await callLLM(TAILOR_SYSTEM, content, TAILOR_SCHEMA);
  const resume = normalizeResume(r, p.profile);
  const pdf = await renderResumePdf(resume);
  const slug = (s) => str(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const filename = [slug(resume.name) || 'Resume', 'Resume', slug(p.job.company)].filter(Boolean).join('_') + '.pdf';
  return { resume, filename, pdf: Buffer.from(pdf).toString('base64') };
}

// Cleans a structured résumé (from the AI or the editor) into the shape the PDF renderer expects.
export function normalizeResume(r, profile = {}) {
  return {
    name: str(r?.name) || [profile?.firstName, profile?.lastName].filter(Boolean).join(' '),
    headline: str(r?.headline),
    email: str(r?.email) || str(profile?.email),
    phone: str(r?.phone) || str(profile?.phone),
    location: str(r?.location),
    links: strs(r?.links, 8),
    summary: str(r?.summary),
    skills: arr(r?.skills).map((g) => ({ group: str(g?.group), items: strs(g?.items, 30) })).filter((g) => g.items.length),
    experience: arr(r?.experience).map((e) => ({
      company: str(e?.company), title: str(e?.title), location: str(e?.location),
      start: str(e?.start), end: str(e?.end), bullets: strs(e?.bullets, 15),
    })).filter((e) => e.company || e.title),
    education: arr(r?.education).map((e) => ({
      school: str(e?.school), degree: str(e?.degree), major: str(e?.major),
      start: str(e?.start), end: str(e?.end), details: str(e?.details),
    })).filter((e) => e.school),
    projects: arr(r?.projects).map((x) => ({ name: str(x?.name), subtitle: str(x?.subtitle), bullets: strs(x?.bullets, 5) })).filter((x) => x.name),
    extras: arr(r?.extras).map((x) => ({ heading: str(x?.heading), items: strs(x?.items, 12) })).filter((x) => x.heading && x.items.length),
    changes: strs(r?.changes, 6),
  };
}

// ---------- /render: editor -> PDF ----------
export async function render(p) {
  const resume = normalizeResume(p.resume || {}, p.profile);
  const pdf = await renderResumePdf(resume);
  return { pdf: Buffer.from(pdf).toString('base64') };
}

// ---------- résumé PDF ----------
async function renderResumePdf(r) {
  let lib;
  try { lib = await import('pdf-lib'); }
  catch { throw new Error('Tailored résumés need one package. In the server folder run:  npm install'); }
  const { PDFDocument, StandardFonts, rgb } = lib;
  const doc = await PDFDocument.create();
  doc.setTitle(`${r.name || 'Résumé'}`);
  doc.setAuthor(r.name || '');
  doc.setCreator('Fillup');
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ital = await doc.embedFont(StandardFonts.HelveticaOblique);

  const W = 612, H = 792, M = 50, CW = W - 2 * M;
  const ink = rgb(0.11, 0.12, 0.15), muted = rgb(0.38, 0.4, 0.45), accent = rgb(0.2, 0.24, 0.55), rule = rgb(0.82, 0.84, 0.88);
  let page, y;
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };
  const ensure = (h) => { if (y - h < M) newPage(); };

  // Standard PDF fonts only cover Windows-1252; swap or drop anything else.
  const MAP = { '→': '->', '←': '<-', '≤': '<=', '≥': '>=', ' ': ' ', ' ': ' ', '​': '', '−': '-', '‑': '-' };
  const okChar = new Map();
  const clean = (s) => Array.from(String(s || '').replace(/[\r\t]/g, ' ')).map((ch) => {
    if (MAP[ch] !== undefined) return MAP[ch];
    if (!okChar.has(ch)) { try { reg.widthOfTextAtSize(ch, 10); okChar.set(ch, true); } catch { okChar.set(ch, false); } }
    return okChar.get(ch) ? ch : '';
  }).join('');

  const width = (t, font, size) => font.widthOfTextAtSize(t, size);
  function wrap(text, font, size, maxW) {
    const words = clean(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (let w of words) {
      while (width(w, font, size) > maxW) { // hard-split very long tokens (URLs)
        let i = w.length;
        while (i > 1 && width(w.slice(0, i), font, size) > maxW) i--;
        if (line) { lines.push(line); line = ''; }
        lines.push(w.slice(0, i));
        w = w.slice(i);
      }
      const next = line ? line + ' ' + w : w;
      if (width(next, font, size) > maxW && line) { lines.push(line); line = w; } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }
  function para(text, { font = reg, size = 10, color = ink, x = M, w = CW, lead = 1.32 } = {}) {
    for (const ln of wrap(text, font, size, w)) {
      ensure(size * lead);
      page.drawText(ln, { x, y: y - size, size, font, color });
      y -= size * lead;
    }
  }
  function section(title) {
    y -= 9;
    ensure(30);
    page.drawText(clean(title).toUpperCase(), { x: M, y: y - 10, size: 10, font: bold, color: accent });
    y -= 15;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: rule });
    y -= 7;
  }
  function bullet(text) {
    const size = 9.6, lead = 1.3;
    const lines = wrap(text, reg, size, CW - 12);
    lines.forEach((ln, i) => {
      ensure(size * lead);
      if (i === 0) page.drawText('•', { x: M + 2, y: y - size, size, font: reg, color: muted });
      page.drawText(ln, { x: M + 12, y: y - size, size, font: reg, color: ink });
      y -= size * lead;
    });
  }
  function entry(left, right, sub) {
    const size = 10.4;
    const rt = clean(right);
    const rw = rt ? width(rt, reg, 9.2) : 0;
    const lines = wrap(left, bold, size, CW - rw - 12);
    ensure(size * 1.35 * lines.length + (sub ? 12 : 0) + 12);
    lines.forEach((ln, i) => {
      page.drawText(ln, { x: M, y: y - size, size, font: bold, color: ink });
      if (i === 0 && rt) page.drawText(rt, { x: W - M - rw, y: y - size + 0.5, size: 9.2, font: reg, color: muted });
      y -= size * 1.35;
    });
    if (sub) para(sub, { font: ital, size: 9.2, color: muted, lead: 1.35 });
    y -= 1.5;
  }
  const dates = (a, b) => [a, b].filter(Boolean).join(' – ');

  newPage();
  para(r.name || 'Résumé', { font: bold, size: 21, lead: 1.15 });
  if (r.headline) { y -= 1; para(r.headline, { size: 11, color: accent, lead: 1.3 }); }
  const contact = [r.location, r.email, r.phone, ...(r.links || []).map((l) => l.replace(/^https?:\/\/(www\.)?/, ''))].filter(Boolean).join('  ·  ');
  if (contact) { y -= 1; para(contact, { size: 9.2, color: muted }); }

  if (r.summary) { section('Summary'); para(r.summary, { size: 9.8, lead: 1.38 }); }
  if (r.skills.length) {
    section('Skills');
    for (const g of r.skills) {
      const label = g.group ? `${g.group}: ` : '';
      const lw = label ? width(clean(label), bold, 9.6) : 0;
      const lines = wrap(g.items.join(', '), reg, 9.6, CW - lw);
      lines.forEach((ln, i) => {
        ensure(13);
        if (i === 0 && label) page.drawText(clean(label), { x: M, y: y - 9.6, size: 9.6, font: bold, color: ink });
        page.drawText(ln, { x: M + lw, y: y - 9.6, size: 9.6, font: reg, color: ink });
        y -= 12.6;
      });
    }
  }
  if (r.experience.length) {
    section('Experience');
    r.experience.forEach((e, i) => {
      if (i) y -= 5;
      entry([e.title, e.company].filter(Boolean).join(', '), dates(e.start, e.end), e.location);
      e.bullets.forEach(bullet);
    });
  }
  if (r.projects.length) {
    section('Projects');
    r.projects.forEach((x, i) => {
      if (i) y -= 4;
      entry(x.name, '', x.subtitle);
      x.bullets.forEach(bullet);
    });
  }
  if (r.education.length) {
    section('Education');
    r.education.forEach((e, i) => {
      if (i) y -= 4;
      const deg = [e.degree, e.major].filter(Boolean).join(', ');
      entry([e.school, deg].filter(Boolean).join(' — '), dates(e.start, e.end), e.details);
    });
  }
  for (const x of r.extras) {
    section(x.heading);
    x.items.forEach(bullet);
  }
  return doc.save();
}

// ---------- /recommend ----------
const RECOMMEND_SCHEMA = obj({
  titles: list(obj({ title: S, why: S })),
  keywords: list(S),
  locations: list(S),
  companyTypes: list(S),
  tips: list(S),
});

const RECOMMEND_SYSTEM = `You are a career strategist. From the candidate's résumé, profile, work history and the jobs they've saved or applied to (with fit scores), suggest where they should search next.
${GROUNDING}

- titles: 5-8 job titles they are realistically competitive for now, best first, each with a one-line "why" grounded in their background. Mix exact-fit and one-step-adjacent titles.
- keywords: 6-10 search keywords (skills/domains) that will surface strong-fit postings.
- locations: up to 4 locations or "Remote", from the profile and applied jobs; [] if unknown.
- companyTypes: 3-5 kinds of companies or industries where they'd stand out (e.g. "Series B-D data infrastructure startups").
- tips: up to 3 short, specific tips based on patterns in their applications (e.g. low fit scores on senior roles).`;

export async function recommend(p, { callLLM, contextBlocks }) {
  const content = await contextBlocks(p);
  const apps = arr(p.applications).slice(0, 40).map((a) => ({
    title: str(a.title), company: str(a.company), status: str(a.status), fit: a.fit ?? null,
  }));
  content.push({ type: 'text', text: `<applications>${JSON.stringify(apps)}</applications>\nSuggest what to search for next.` });
  const { parsed } = await callLLM(RECOMMEND_SYSTEM, content, RECOMMEND_SCHEMA);
  return {
    titles: arr(parsed?.titles).map((t) => ({ title: str(t?.title), why: str(t?.why) })).filter((t) => t.title).slice(0, 8),
    keywords: strs(parsed?.keywords, 10),
    locations: strs(parsed?.locations, 4),
    companyTypes: strs(parsed?.companyTypes, 5),
    tips: strs(parsed?.tips, 3),
  };
}

// ---------- /navigate ----------
// Decides which button moves the application forward. The extension enforces
// "never submit" in code as well; this prompt is the first line of defense.
const NAVIGATE_SCHEMA = obj({
  page: { type: 'string', enum: ['job_posting', 'apply_options', 'sign_in', 'create_account', 'verify_email', 'application_form', 'final_review', 'confirmation', 'error', 'other'] },
  action: { type: 'string', enum: ['click', 'stop'] },
  buttonId: S,
  reason: S,
});

const NAVIGATE_SYSTEM = `You drive a job application in a browser, one click at a time, up to but never including the final submission. From the page info (URL, headings, excerpt, errors, buttons with ids, emptyRequired, hasCredentials), classify the page and pick ONE button to click, or stop.

Pages and what to do
- job_posting: click the main Apply / Apply now / I'm interested / Start application. Never Easy Apply or Apply with LinkedIn/Indeed/Google.
- apply_options (e.g. Workday "Autofill with Resume / Apply Manually / Use My Last Application"): click Apply Manually or the closest manual option.
- sign_in: hasCredentials true → click the sign-in button; false → click Create Account / Sign up / Register. Never Forgot password or social/SSO sign-in.
- create_account: click the create-account button; stop if it says the account already exists.
- verify_email: stop.
- application_form: stop if emptyRequired > 0 or errors are shown; otherwise click Next / Continue / Save and Continue / Review. Click Add / Add another only if a section clearly needs another entry.
- final_review: stop. confirmation (submitted): stop.
- error / other: stop, unless one button clearly continues the application (for cookie banners prefer Reject / Necessary only).

Hard rules
- NEVER click anything that submits, sends, finalizes or completes the application (Submit, Send, Finish, Complete, Confirm and submit), even if it is the only button: stop with page final_review.
- Never click Withdraw, Delete, Cancel application, Sign out, or anything that leaves the application.
- buttonId: one of the given ids when clicking, "" when stopping.
- reason: one short sentence for the candidate, e.g. "Clicked Save and Continue" or "Stopped: 2 required fields need your input".`;

export async function navigate(p, { callLLM }) {
  const buttons = arr(p.buttons).slice(0, 60).map((b) => ({ id: str(b.id), text: str(b.text).slice(0, 80), ...(b.kind === 'link' ? { link: true } : {}) }));
  const info = {
    url: str(p.url), title: str(p.title), headings: strs(p.headings, 12),
    excerpt: str(p.excerpt).slice(0, 1500), errors: strs(p.errors, 8),
    emptyRequired: Number(p.emptyRequired) || 0, emptyLabels: strs(p.emptyLabels, 10),
    hasPasswordField: !!p.hasPasswordField, hasCredentials: !!p.hasCredentials, buttons,
  };
  const content = [{ type: 'text', text: `<page>${JSON.stringify(info)}</page>\nWhat should happen next?` }];
  const { parsed } = await callLLM(NAVIGATE_SYSTEM, content, NAVIGATE_SCHEMA);
  const ids = new Set(buttons.map((b) => b.id));
  let action = parsed?.action === 'click' && ids.has(str(parsed?.buttonId)) ? 'click' : 'stop';
  return {
    page: str(parsed?.page) || 'other',
    action,
    buttonId: action === 'click' ? str(parsed.buttonId) : '',
    reason: str(parsed?.reason),
  };
}
