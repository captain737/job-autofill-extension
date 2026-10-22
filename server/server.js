// Fillup backend ("the brain"). Runs on your machine; the extension talks only to it.
// Endpoints (all POST JSON):
//   /parse      résumé -> profile + work history
//   /fill       form fields -> answers
//   /analyze    job posting vs résumé -> fit score, keywords, suggestions
//   /tailor     tailored résumé for one job -> JSON + PDF
//   /navigate   autopilot: which button to press next (never Submit)
//   /render     edited résumé JSON -> PDF
//   /recommend  job titles / searches that fit the candidate
//
// Put your key in server/.env (see .env.example) and run `npm start`, or pass it inline:
//   DEEPSEEK_API_KEY=sk-...      node server.js
//   GROQ_API_KEY=gsk_...         node server.js
//   ANTHROPIC_API_KEY=sk-ant-... node server.js
//   OPENAI_API_KEY=sk-...        node server.js
//   PROVIDER=custom LLM_BASE_URL=http://localhost:11434/v1 MODEL=llama3.1 node server.js   (e.g. Ollama)
// Optional: PROVIDER, MODEL, LLM_BASE_URL, LLM_API_KEY, JSON_MODE (schema|object), PORT, HOST.
// Works with Anthropic (Claude), OpenAI, Groq, DeepSeek, or any OpenAI-compatible API (Ollama, OpenRouter…).
// Needs Node 18+. Run `npm install` once (PDF text extraction + tailored résumé PDFs).

import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { analyze, tailor, recommend, navigate, render } from './features.js';

// Load server/.env (KEY=value lines) so `npm start` just works. Real env vars win.
try {
  const envFile = fs.readFileSync(new URL('./.env', import.meta.url), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1'; // local only by default
const MAX_BODY = 20 * 1024 * 1024;

const PRESETS = {
  anthropic: { kind: 'anthropic', base: 'https://api.anthropic.com', keyEnv: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5-5' },
  groq: { kind: 'openai', base: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', model: 'openai/gpt-oss-120b' },
  openai: { kind: 'openai', base: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', model: 'gpt-6.1-sol' },
  // DeepSeek only offers plain JSON mode (no schema enforcement), so the schema goes in the prompt.
  deepseek: { kind: 'openai', base: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-flash', json: 'object' },
  custom: { kind: 'openai', base: '', keyEnv: 'LLM_API_KEY', model: '' },
};

// Pick the provider: explicit PROVIDER, otherwise whichever key is set.
const PROVIDER = (process.env.PROVIDER
  || (process.env.DEEPSEEK_API_KEY && 'deepseek')
  || (process.env.GROQ_API_KEY && 'groq')
  || (process.env.ANTHROPIC_API_KEY && 'anthropic')
  || (process.env.OPENAI_API_KEY && 'openai')
  || '').toLowerCase();
const preset = PRESETS[PROVIDER];
if (!preset) {
  console.error(`No API key found. Copy .env.example to .env and add one key, or start with one of:
  DEEPSEEK_API_KEY=sk-...      node server.js
  GROQ_API_KEY=gsk_...         node server.js
  ANTHROPIC_API_KEY=sk-ant-... node server.js
  OPENAI_API_KEY=sk-...        node server.js
  PROVIDER=custom LLM_BASE_URL=<openai-compatible url> MODEL=<model> node server.js`);
  process.exit(1);
}
const KIND = preset.kind; // 'anthropic' or 'openai' (request format)
const API_KEY = process.env.LLM_API_KEY || process.env[preset.keyEnv] || '';
const MODEL = process.env.MODEL || preset.model;
const API_BASE = (process.env.LLM_BASE_URL || process.env.ANTHROPIC_BASE_URL || preset.base).replace(/\/+$/, '');
if (!API_BASE || !MODEL) { console.error('PROVIDER=custom needs LLM_BASE_URL and MODEL.'); process.exit(1); }
if (!API_KEY && PROVIDER !== 'custom') { console.error(`Set ${preset.keyEnv}.`); process.exit(1); }
// 'schema' = provider enforces our JSON schema; 'object' = plain JSON mode, schema described in the prompt.
const JSON_MODE = (process.env.JSON_MODE || preset.json || 'schema').toLowerCase();

const SYSTEM = `You fill out job application forms on behalf of a candidate. You receive the candidate's résumé, their saved profile, their past answers to application questions, the job posting, and a list of form fields. You are the only thing deciding what goes in each field. Return an answer for every field you can answer well, and leave out the rest.

Existing values
- A field may include "current": what is in it now. Sites often pre-fill fields from their own résumé parser and get them wrong (descriptions merged or truncated, titles and companies swapped, wrong dates, garbage text). Treat "current" as untrusted.
- Return the correct value for every field you can answer, even when it already has a value. If "current" is already exactly right, return it unchanged.
- Work-experience description / responsibilities fields: use the full "description" of that entry from <work_history>, as written (keep line breaks, use "- " bullets if the field is plain text).

Grounding
- Use only facts found in the résumé, profile, or past answers. Never invent employers, dates, degrees, numbers, skills, links, or credentials.
- Past answers are the candidate's own answers from earlier applications. "you" = typed or corrected by the candidate (most trustworthy, prefer these over everything else); "ai" = an earlier AI answer the candidate submitted unchanged. When a field asks the same thing in different words, reuse the past answer, adapting it to this field's options or format. For open-ended questions about a specific company, use past answers as material but write for this job.
- Well-grounded inference is good: compute years of experience from résumé dates, answer "Do you have experience with X?" from listed skills and projects, derive a city from an address.
- If an answer isn't supported, omit the field. A blank field is far better than a wrong one.

By field type
- dropdown / single_select: "value" must be one option copied exactly from that field's "options". Long dropdowns (countries, states, schools) come without the full list, only "optionCount" and a few "examples": answer with the plain value (e.g. "United States", "California"); the extension matches it to the closest option.
- multi_select: "value" is an array of exact option strings.
- file_upload: value "resume" if the field wants a résumé/CV. Omit any other upload (cover letter, transcript, portfolio files).
- password: value must be exactly "{{PASSWORD}}" (the extension inserts the real password). This includes "confirm / verify / re-enter password" fields. Never write a real password.
- Account sign-up / sign-in forms: email or username fields get the candidate's email. A "terms / I agree / privacy" checkbox on an account sign-up form gets "Yes" only if <settings> says acceptAccountTerms is true; otherwise omit it.
- checkbox (single box): "Yes" to check it, "No" to leave it. Do NOT check consent, terms, privacy, or "I certify / acknowledge" boxes; omit them so the candidate does those personally.
- text: a short exact value (URL, number, name, date). Match the format the question implies.
- textarea or open-ended questions: write in first person as the candidate, specific to this job and grounded in the résumé. Under 150 words unless the question asks for more. Plain text, no placeholders, no markdown.

Sensitive questions
- Demographic / EEO (gender, race, ethnicity, veteran, disability, sexual orientation): answer only from the profile or past answers. If the profile is silent, choose a "decline to answer" option if one exists, otherwise omit.
- Work authorization, sponsorship, salary, start date, relocation, criminal history: answer only from the profile or past answers. Never guess legal status.

Confidence
- "high": stated directly in the profile, résumé, or a past answer to the same question.
- "medium": a reasonable inference, or any free-text answer you wrote.
- "low": a plausible guess the candidate should check.
Add a short "reason" for anything below high (e.g. "Computed from 2021–2025 role at Acme").

Form structure
- A field may include "section" (the form heading it sits under) and "entry" (e.g. "2 of 3") when a block of fields repeats. For repeated work-experience blocks, entry 1 = the most recent job in <work_history>, entry 2 = the next, and so on; same for education. Dates go in the format the field implies (e.g. "MM/YYYY", separate month and year fields).
- "I currently work here"-style checkboxes: "Yes" only for the ongoing role.

Skip fields unrelated to the application (site search boxes, captchas, newsletter sign-ups).`;

// JSON schema for structured outputs (output_config.format).
const SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          value: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          reason: { type: 'string' },
        },
        required: ['id', 'value', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['answers'],
  additionalProperties: false,
};

// ---------- résumé handling ----------
// Claude reads PDFs natively. Other providers get text we extract here.
const pdfTextCache = new Map();
async function pdfToText(b64) {
  const key = crypto.createHash('sha1').update(b64).digest('hex');
  if (pdfTextCache.has(key)) return pdfTextCache.get(key);
  let unpdf;
  try { unpdf = await import('unpdf'); }
  catch { throw new Error('PDF résumés need one package for this provider. In the server folder run:  npm install'); }
  const pdf = await unpdf.getDocumentProxy(new Uint8Array(Buffer.from(b64, 'base64')));
  const { text } = await unpdf.extractText(pdf, { mergePages: true });
  const clean = String(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length < 30) throw new Error('Could not read text from this PDF (it may be a scanned image). Upload a DOCX/TXT version or paste your résumé text in settings.');
  pdfTextCache.set(key, clean);
  return clean;
}

async function resumeBlock(b64Pdf) {
  if (KIND === 'anthropic') {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: b64Pdf },
      title: 'Candidate résumé',
      cache_control: { type: 'ephemeral' }, // same résumé every request -> cheaper repeat calls
    };
  }
  return { type: 'text', text: `<resume>\n${await pdfToText(b64Pdf)}\n</resume>` };
}

const clip = (v, n) => String(v ?? '').slice(0, n);
const esc = (v) => String(v ?? '').replace(/"/g, "'");

// Résumé + candidate data + job, shared by every endpoint.
// Order matters for cost: everything that is the same on every request (résumé, work history,
// profile) comes first so providers can cache it; per-page data (memory, job, fields) comes last.
// JSON is sent without indentation to save tokens.
async function contextBlocks(p, { memory = false, fields = null } = {}) {
  const content = [];
  if (p.resume && p.resume.data) content.push(await resumeBlock(p.resume.data));
  const fixed = [];
  if (p.resumeText) fixed.push(`<resume_text>\n${clip(p.resumeText, 30000)}\n</resume_text>`);
  const h = p.history || {};
  if ((h.experience && h.experience.length) || (h.education && h.education.length)) {
    fixed.push(`<work_history>${JSON.stringify(h)}</work_history>`);
  }
  if (p.profile) fixed.push(`<profile>${JSON.stringify(p.profile)}</profile>`);
  if (fixed.length) {
    const block = { type: 'text', text: fixed.join('\n') };
    if (KIND === 'anthropic') block.cache_control = { type: 'ephemeral' };
    content.push(block);
  }
  const parts = [];
  if (memory && Array.isArray(p.memory) && p.memory.length) {
    parts.push(`<past_answers>${JSON.stringify(p.memory.slice(0, 60))}</past_answers>`);
  }
  if (p.job) {
    const j = p.job;
    const attrs = `title="${esc(j.title)}" company="${esc(j.company)}"${j.location ? ` location="${esc(j.location)}"` : ''}`;
    parts.push(j.description ? `<job_posting ${attrs}>\n${clip(j.description, 12000)}\n</job_posting>` : `<job ${attrs}/>`);
  }
  if (p.analysis) parts.push(`<fit_analysis>${JSON.stringify(p.analysis)}</fit_analysis>`);
  if (fields) parts.push(`<form_fields>${JSON.stringify(fields)}</form_fields>`);
  if (parts.length) content.push({ type: 'text', text: parts.join('\n') });
  return content;
}

async function buildContent(payload) {
  const content = await contextBlocks(payload, { memory: true, fields: payload.fields });
  content.push({ type: 'text', text: `<settings>${JSON.stringify({ acceptAccountTerms: !!payload.acceptTerms })}</settings>` });
  content.push({ type: 'text', text: 'Return answers for these form fields.' });
  return content;
}

// ---------- LLM calls ----------
// JSON-schema structured output:
function callLLM(system, content, schema) {
  return KIND === 'anthropic' ? callAnthropic(system, content, schema) : callOpenAICompatible(system, content, schema);
}
async function openaiRequest(body) {
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data?.error?.message || `API error ${res.status}`); e.status = res.status; throw e; }
  return data;
}

async function anthropicRequest(body) {
  const res = await fetch(`${API_BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, ...body }),
    signal: AbortSignal.timeout(180_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Claude API error ${res.status}`);
  if (data.stop_reason === 'refusal') throw new Error('Model declined this request');
  if (data.stop_reason === 'max_tokens') throw new Error('Response was cut off');
  return data;
}

// Groq, OpenAI, OpenRouter, Ollama, etc. — /chat/completions with response_format.
// A minimal example object for a JSON schema, shown to models without schema enforcement.
function exampleFor(schema) {
  if (schema.anyOf) return exampleFor(schema.anyOf[0]);
  if (schema.enum) return schema.enum[0];
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties || {}).map(([k, v]) => [k, exampleFor(v)]));
  if (schema.type === 'array') return [exampleFor(schema.items || { type: 'string' })];
  if (schema.type === 'number' || schema.type === 'integer') return 0;
  if (schema.type === 'boolean') return false;
  return '';
}

// Groq, OpenAI, DeepSeek, OpenRouter, Ollama, etc. — /chat/completions.
async function callOpenAICompatible(system, content, schema, attempt = 1) {
  const userText = content.map((b) => b.text).join('\n\n');
  const plainJson = JSON_MODE === 'object';
  const sys = plainJson
    ? `${system}

Output format: respond with ONLY a single json object, no prose and no code fences. It must follow this JSON Schema exactly (every listed key present, no extra keys):
${JSON.stringify(schema)}
Example of the shape (values are placeholders):
${JSON.stringify(exampleFor(schema))}`
    : system;
  const body = {
    model: MODEL,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: userText }],
    response_format: plainJson
      ? { type: 'json_object' }
      : { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } },
  };
  // DeepSeek uses max_tokens; newer OpenAI-style APIs use max_completion_tokens.
  if (PROVIDER === 'deepseek') body.max_tokens = 32000; else body.max_completion_tokens = 16000;

  const retry = (why) => {
    if (attempt >= 2) throw new Error(why);
    console.warn(`[llm] ${why}; retrying once`);
    return callOpenAICompatible(system, content, schema, attempt + 1);
  };
  let data;
  try {
    data = await openaiRequest(body);
  } catch (e) {
    // JSON modes occasionally fail validation; one retry usually fixes it.
    if (e.status === 400 && /schema|json/i.test(e.message)) return retry(e.message);
    throw e;
  }
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('Response was cut off');
  const text = (choice?.message?.content || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  if (!text) return retry(choice?.message?.refusal || 'Empty response from model');
  let parsed;
  try { parsed = JSON.parse(text); } catch { return retry('Model returned invalid JSON'); }
  return { parsed, usage: data.usage };
}

async function callAnthropic(system, content, schema) {
  const data = await anthropicRequest({
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content }],
    output_config: { format: { type: 'json_schema', schema } },
  });
  const text = (data.content || []).find((b) => b.type === 'text')?.text;
  return { parsed: JSON.parse(text || '{}'), usage: data.usage };
}

async function askClaude(payload) {
  const { parsed, usage } = await callLLM(SYSTEM, await buildContent(payload), SCHEMA);

  // Keep only well-formed answers for ids we sent (models without schema enforcement can drift).
  const ids = new Set(payload.fields.map((f) => f.id));
  const answers = (Array.isArray(parsed?.answers) ? parsed.answers : [])
    .filter((a) => a && ids.has(String(a.id)))
    .map((a) => ({
      id: String(a.id),
      value: Array.isArray(a.value) ? a.value.map(String).filter(Boolean)
        : a.value == null ? '' : String(a.value),
      confidence: ['high', 'medium', 'low'].includes(a.confidence) ? a.confidence : 'medium',
      reason: typeof a.reason === 'string' ? a.reason : '',
    }))
    .filter((a) => (Array.isArray(a.value) ? a.value.length : a.value.trim()));
  return { answers, usage };
}

// ---------- /parse: résumé -> profile ----------
const PROFILE_KEYS = [
  'firstName', 'lastName', 'email', 'phone', 'linkedin', 'github', 'website',
  'address', 'city', 'state', 'zip', 'country',
  'currentCompany', 'currentTitle', 'yearsExperience',
  'school', 'degree', 'major', 'gpa', 'gradYear',
];
const strings = (keys) => ({
  type: 'object',
  properties: Object.fromEntries(keys.map((k) => [k, { type: 'string' }])),
  required: keys,
  additionalProperties: false,
});
const EXP_KEYS = ['company', 'title', 'location', 'start', 'end', 'summary', 'description'];
const EDU_KEYS = ['school', 'degree', 'major', 'start', 'end', 'gpa', 'details'];
const PROJ_KEYS = ['name', 'description', 'url'];
const PARSE_SCHEMA = {
  type: 'object',
  properties: {
    profile: strings(PROFILE_KEYS),
    experience: { type: 'array', items: strings(EXP_KEYS) },
    education: { type: 'array', items: strings(EDU_KEYS) },
    skills: { type: 'array', items: { type: 'string' } },
    projects: { type: 'array', items: strings(PROJ_KEYS) },
    certifications: { type: 'array', items: { type: 'string' } },
    languages: { type: 'array', items: { type: 'string' } },
  },
  required: ['profile', 'experience', 'education', 'skills', 'projects', 'certifications', 'languages'],
  additionalProperties: false,
};

const PARSE_SYSTEM = `You extract structured data from a résumé for a job-application autofill tool.

- Copy facts exactly as written. Use "" for anything the résumé doesn't state. Never invent.
- firstName / lastName: split the candidate's name.
- linkedin / github / website: full URLs starting with https://. Add the scheme if the résumé omits it.
- city / state / country: from the candidate's own location line. Use the 2-letter code for US states. If no country is stated but the state is a US state, use "United States".
- address / zip: only if the résumé shows them.
- currentCompany / currentTitle: the most recent role (ongoing roles first).
- yearsExperience: total years of professional, full-time-equivalent work as a whole number string, computed up to today's date. Exclude education; count internships only if there is nothing else. "" if there's no work history.
- school / degree / major / gpa / gradYear: the highest or most recent degree. degree as a common name (e.g. "Bachelor's", "Master's", "PhD"). gradYear is the (expected) graduation year.
- experience / education: every entry, most recent first. Dates as "YYYY-MM", "YYYY", or "Present". Keep each role separate even if titles repeat; never merge two roles.
  - summary: one plain sentence.
  - description: that role's full bullet points / responsibilities exactly as written on the résumé, one per line, each starting with "- ". Don't shorten, merge or rewrite. "" if none.
  - education details: honors, coursework, activities as written, or "".
- skills: technical skills, tools and languages as listed.
- projects: each project with its full description as written and URL if shown.
- certifications: each certification as written (with issuer/year if shown).
- languages: spoken languages with proficiency if shown.`;

// Minimal .docx text extraction (a .docx is a zip; we need word/document.xml).
function docxText(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('Not a valid .docx file');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    if (name === 'word/document.xml') {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + csize);
      const xml = (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
      return xml
        .replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>|<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/\n{3,}/g, '\n\n').trim();
    }
    off += 46 + nlen + elen + clen;
  }
  throw new Error('No document text found in .docx');
}

async function parseResume({ resume }) {
  if (!resume || !resume.data) throw new Error('No résumé provided');
  const type = (resume.media_type || '').toLowerCase();
  const name = (resume.name || '').toLowerCase();
  const buf = Buffer.from(resume.data, 'base64');
  const content = [];
  let resumeText = '';

  if (type.includes('pdf') || name.endsWith('.pdf')) {
    content.push(await resumeBlock(resume.data));
  } else if (type.includes('wordprocessingml') || name.endsWith('.docx')) {
    resumeText = docxText(buf);
  } else if (type.startsWith('text/') || name.endsWith('.txt') || name.endsWith('.md')) {
    resumeText = buf.toString('utf8');
  } else {
    throw new Error('Unsupported résumé format. Use PDF, DOCX or TXT.');
  }
  if (resumeText && !content.length) content.push({ type: 'text', text: `<resume>\n${resumeText}\n</resume>` });
  content.push({ type: 'text', text: `Today's date is ${new Date().toISOString().slice(0, 10)}. Extract the résumé data.` });

  const { parsed, usage } = await callLLM(PARSE_SYSTEM, content, PARSE_SCHEMA);
  const str = (v) => (v == null ? '' : String(v));
  const rows = (list, keys) => (Array.isArray(list) ? list : [])
    .filter((r) => r && typeof r === 'object')
    .map((r) => Object.fromEntries(keys.map((k) => [k, str(r[k])])));
  return {
    profile: Object.fromEntries(PROFILE_KEYS.map((k) => [k, str(parsed?.profile?.[k])])),
    experience: rows(parsed?.experience, EXP_KEYS),
    education: rows(parsed?.education, EDU_KEYS),
    skills: (Array.isArray(parsed?.skills) ? parsed.skills : []).map(str).filter(Boolean),
    projects: rows(parsed?.projects, PROJ_KEYS),
    certifications: (Array.isArray(parsed?.certifications) ? parsed.certifications : []).map(str).filter(Boolean),
    languages: (Array.isArray(parsed?.languages) ? parsed.languages : []).map(str).filter(Boolean),
    resumeText,
    usage,
  };
}

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Request too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const deps = { callLLM, contextBlocks };
const ROUTES = {
  '/parse': async (p) => {
    const out = await parseResume(p);
    return [out, `${p.resume?.name || 'résumé'}: ${out.experience.length} jobs, ${out.education.length} schools`];
  },
  '/fill': async (p) => {
    if (!Array.isArray(p.fields) || !p.fields.length) throw Object.assign(new Error('No fields'), { status: 400 });
    const out = await askClaude(p);
    return [out, `${p.job?.url || '?'}: ${out.answers.length}/${p.fields.length} answered`];
  },
  '/analyze': async (p) => {
    const out = await analyze(p, deps);
    return [out, `${p.job?.company || ''} ${p.job?.title || ''}: fit ${out.fitScore}`];
  },
  '/tailor': async (p) => {
    const out = await tailor(p, deps);
    return [out, `${out.filename}`];
  },
  '/navigate': async (p) => {
    const out = await navigate(p, deps);
    return [out, `${p.url || ''}: ${out.page} -> ${out.action}${out.buttonId ? ' ' + out.buttonId : ''}`];
  },
  '/render': async (p) => {
    const out = await render(p);
    return [out, `${Math.round(out.pdf.length * 0.75 / 1024)} KB`];
  },
  '/recommend': async (p) => {
    const out = await recommend(p, deps);
    return [out, `${out.titles.length} titles`];
  },
};

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, provider: PROVIDER, model: MODEL, features: Object.keys(ROUTES).map((r) => r.slice(1)) });
  }
  const route = req.method === 'POST' && ROUTES[req.url];
  if (!route) return send(res, 404, { error: 'Not found' });

  const started = Date.now();
  try {
    const payload = await readJson(req);
    const [out, note] = await route(payload);
    if (req.url !== '/render') console.log(`[${req.url.slice(1)}] ${note} in ${Date.now() - started}ms`);
    send(res, 200, out);
  } catch (err) {
    console.error(`[${req.url.slice(1)}] error:`, err.message);
    send(res, err.status || 502, { error: err.message });
  }
}).listen(PORT, HOST, () => {
  console.log(`Fillup backend on http://${HOST}:${PORT} using ${PROVIDER} / ${MODEL}`);
});
