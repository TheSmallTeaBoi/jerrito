#!/usr/bin/env node
/**
 * helper — a stupid-minimal terminal helper for small local models.
 *
 * Three tools, nothing else:
 *   web_search  DDG lite (+ HTML/Brave fallback), filtered to title / url / description
 *   web_fetch   fetch a page and turn it into readable markdown
 *   read        read a file (or list a dir) inside the current project
 *
 * Zero dependencies. Node 20+.
 */
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync,
  statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL, fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- config ---
// TTY gates cursor control (the panel); COLOR gates escape codes, so
// FORCE_COLOR=1 gives styled markdown into a pipe without panel erasing
const TTY = Boolean(process.stdout.isTTY);
const COLOR = Boolean((process.stdout.isTTY && !process.env.NO_COLOR)
  || (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0'));
const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint('2'), cyan = paint('36'), yellow = paint('33'), red = paint('31');

// the command you actually typed: `h` when installed (the wrapper exports
// HELPER_PROG), else the file name, so `node helper.mjs` still says "helper"
const PROG = (process.env.HELPER_PROG || path.basename(process.argv[1] || 'h')).replace(/\.m?js$/, '');

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const ENV_BASE = process.env.HELPER_BASE_URL || process.env.OPENAI_BASE_URL || '';

let CFG = {
  base: (ENV_BASE || 'http://127.0.0.1:9931/v1').replace(/\/+$/, ''),
  baseExplicit: Boolean(ENV_BASE),          // user pointed us at a server: never spawn
  model: process.env.HELPER_MODEL || '',
  modelFile: process.env.HELPER_MODEL_FILE || '',
  key: process.env.HELPER_API_KEY || process.env.OPENAI_API_KEY || 'none',
  temp: num(process.env.HELPER_TEMP, 0.2),
  maxTokens: num(process.env.HELPER_MAX_TOKENS, 2048),
  stats: process.env.HELPER_STATS === '1',
  steps: num(process.env.HELPER_STEPS, 8),
  chars: num(process.env.HELPER_MAX_CHARS, 24000),   // history budget (chars)
  maxResults: num(process.env.HELPER_SEARCH_RESULTS, 6),
  fetchChars: num(process.env.HELPER_FETCH_CHARS, 6000),
  readLines: num(process.env.HELPER_READ_LINES, 250),
};
if (!/\/v\d+$/.test(CFG.base)) CFG.base += '/v1';

// optional sampler overrides; only sent when set, so servers/APIs that reject
// extra fields are unaffected
const SAMPLING = {};
for (const [env, key] of [['HELPER_TOP_P', 'top_p'], ['HELPER_TOP_K', 'top_k'],
  ['HELPER_MIN_P', 'min_p'], ['HELPER_REPEAT_PENALTY', 'repeat_penalty']]) {
  const v = Number(process.env[env]);
  if (Number.isFinite(v) && process.env[env] !== '') SAMPLING[key] = v;
}
const ENV_SAMPLING = new Set(Object.keys(SAMPLING));

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// ------------------------------------------------------------------ html ---
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…',
  mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', middot: '·',
  bull: '•', deg: '°', times: '×', divide: '÷', euro: '€', pound: '£',
};

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g) => {
    if (g[0] === '#') {
      const cp = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    const v = ENTITIES[g.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const stripTags = (s) => decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function absolutize(href, base) {
  try { return new URL(decodeEntities(href), base || undefined).href; } catch { return ''; }
}

/** HTML -> readable markdown. Deliberately dumb: strip junk, keep structure. */
// class/id words that mark chrome rather than content (word-ish boundaries, so
// "header" does not match "ad")
const BOILER = /(^|[\s_-])(ads?|advert\w*|banner\w*|cookie\w*|consent|newsletter|subscribe|signup|social|share\w*|related|promo\w*|paywall|modal|popup|sidebar|comments?|breadcrumbs?|toolbar|skip-link|menu)([\s_-]|$)/i;

const textOf = (s) => stripTags(s);
const paraChars = (s) => [...s.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)].reduce((n, m) => n + textOf(m[1]).length, 0);
const linkChars = (s) => [...s.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)].reduce((n, m) => n + textOf(m[1]).length, 0);

/** drop obvious chrome blocks by class/id */
function stripBoilerplate(h) {
  return h.replace(/<(div|section|aside|ul|ol|nav|header|footer|form|table)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi,
    (m, tag, attrs, inner) => {
      const mark = (attrs.match(/(?:class|id|role)\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
      if (mark && BOILER.test(mark) && inner.length < 30000) return ' ';
      return m;
    });
}

/**
 * Pick the block that looks like prose: paragraph text counts, link text is
 * penalised. Homepages/indexes are link-heavy card grids; article bodies are
 * long paragraphs with almost no links, which is what we want to read.
 */
function pickRegion(h) {
  const cands = [];
  for (const tag of ['article', 'main', 'section', 'div']) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi');
    let m, n = 0;
    while ((m = re.exec(h)) && n++ < 40) {
      if (m[1].length < 300) continue;
      const text = textOf(m[1]).length;
      if (text < 250) continue;
      const p = paraChars(m[1]), l = linkChars(m[1]);
      cands.push({ html: m[1], text, p, score: p + 0.2 * text - 1.5 * l, linkRatio: l / Math.max(1, text) });
    }
  }
  if (!cands.length) return null;

  // prose-like = mostly paragraph text, few links; among those take the biggest
  // container so a long article is not cut down to one section
  const prose = cands.filter((c) => c.linkRatio < 0.5 && c.p > 250);
  if (prose.length) return prose.sort((a, b) => b.text - a.text)[0];
  return cands.sort((a, b) => b.score - a.score)[0];
}

/** HTML -> readable markdown. Deliberately dumb: strip junk, keep structure. */
function htmlToMarkdown(html, baseUrl = '') {
  let h = String(html);
  h = h.replace(/<!--[\s\S]*?-->/g, '');
  h = h.replace(/<(script|style|svg|noscript|iframe|template|canvas|select|button|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  h = stripBoilerplate(h);

  // file listings / nav tables are almost pure links: reading mode does not need them
  h = h.replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi, (tbl) => {
    const t = textOf(tbl).length;
    if (t < 400) return tbl;
    return linkChars(tbl) / Math.max(1, t) > 0.8 ? ' ' : tbl;
  });

  // an index/homepage is mostly links overall; an article's body is not
  const docRatio = linkChars(h) / Math.max(1, textOf(h).length);
  const indexPage = docRatio > 0.45;

  const picked = pickRegion(h);
  let region = picked ? picked.html : h;
  if (!picked) {
    const body = (h.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i) || [])[1];
    if (body) region = body;
  }
  h = region.replace(/<(nav|footer|aside|header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');

  // Protect code blocks, then inline code.
  const stash = [];
  const keep = (s) => `\u0000${stash.push(s) - 1}\u0000`;
  h = h.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, inner) => {
    const lang = (inner.match(/class=["'][^"']*(?:language-|lang-)([\w+#.-]+)/i) || [])[1] || '';
    const bare = inner.replace(/<(span|div|td)\b[^>]*class=["'][^"']*(?:linenos?|line-number|lineno)[^"']*["'][^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    const code = decodeEntities(bare.replace(/<[^>]*>/g, '')).replace(/^\n+|\s+$/g, '');
    return keep('\n\n```' + lang + '\n' + code + '\n```\n\n');
  });
  h = h.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_, inner) => {
    const code = decodeEntities(inner.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    return code ? keep('`' + code + '`') : ' ';
  });

  h = h.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi,
    (_, lv, t) => `\n\n${'#'.repeat(+lv)} ${stripTags(t)}\n\n`);
  h = h.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_, attrs, t) => {
    const text = stripTags(t);
    if (!text) return ' ';
    const href = absolutize((attrs.match(/href\s*=\s*["']([^"']*)["']/i) || [])[1] || '', baseUrl);
    const ok = href && /^https?:/i.test(href) && href !== baseUrl;
    // A link that wraps a block (card headline + summary, nav tile) must not become
    // "[## headline ...](url)" — that turns a page into a wall of brackets.
    const block = /<(h[1-6]|p|div|ul|ol|li|section|article|figure|br)\b/i.test(t) || text.length > 120;
    if (block) {
      const flat = text.replace(/^#+\s*/, '').replace(/\s*\n\s*/g, ' · ').trim();
      return ok ? `${flat} — ${href}` : flat;
    }
    return ok ? `[${text}](${href})` : text;
  });
  h = h.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, __, t) => (stripTags(t) ? `**${stripTags(t)}**` : ''));
  h = h.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, __, t) => (stripTags(t) ? `*${stripTags(t)}*` : ''));
  h = h.replace(/<img\b[^>]*alt\s*=\s*["']([^"']+)["'][^>]*>/gi, (_, alt) => ` [img: ${decodeEntities(alt)}] `);
  h = h.replace(/<li\b[^>]*>/gi, '\n- ');
  h = h.replace(/<br\s*\/?>/gi, '\n');
  h = h.replace(/<hr[^>]*>/gi, '\n\n---\n\n');
  h = h.replace(/<t[dh]\b[^>]*>/gi, ' | ');
  h = h.replace(/<\/(p|div|section|tr|table|ul|ol|dl|dt|dd|figure|figcaption|blockquote|pre)\s*>/gi, '\n');
  h = h.replace(/<[^>]*>/g, ' ');
  h = decodeEntities(h);
  h = h.replace(/[ \t\u00a0]+/g, ' ')
       .replace(/ *\n */g, '\n')
       .replace(/\n{3,}/g, '\n\n')
       .replace(/\*\*\s*\*\*/g, '')
       .replace(/^(?:[-*|>]+\s*)+$/gm, '')
       .trim();
  h = h.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
  h = h.replace(/\n{3,}/g, '\n\n').trim();
  // tables and card grids repeat the same line twice; keep one (blank lines ignored)
  const kept = [];
  for (const line of h.split('\n')) {
    if (line.trim() && kept.length) {
      let j = kept.length - 1;
      while (j >= 0 && !kept[j].trim()) j--;
      if (j >= 0 && line === kept[j]) continue;
    }
    kept.push(line);
  }
  const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // "thin" = we mostly found navigation/table rows, not prose: usually a
  // JavaScript-rendered page, so say so instead of returning chrome as content
  const lines = text.split('\n').filter((l) => l.trim());
  const linky = lines.filter((l) => /^\|/.test(l) || /^[-*]?\s*\[/.test(l)).length;
  const thin = !indexPage && (text.length < 800 || (lines.length > 6 && linky / lines.length > 0.55));
  return { title, text, indexPage: Boolean(indexPage), thin };
}

// ------------------------------------------------------------------ http ---
async function httpFetch(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    body: opts.body,
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeout || 20000),
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      ...(opts.headers || {}),
    },
  });
  const type = res.headers.get('content-type') || '';
  let text = '';
  if (/text|json|xml|javascript|markdown/i.test(type) || !type) {
    const cap = 2_000_000;
    const chunks = [];
    let n = 0;
    for await (const chunk of res.body) {
      chunks.push(chunk);
      n += chunk.length;
      if (n >= cap) break;
    }
    text = Buffer.concat(chunks).subarray(0, cap).toString('utf8');
  }
  return { status: res.status, url: res.url || url, type, text };
}

const clip = (s, n) => (s.length > n ? s.slice(0, n).trimEnd() + ' …' : s);

const humanSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** one-line reason for a failed fetch, instead of "fetch failed" */
const fetchErr = (e) => (e.name === 'TimeoutError' ? 'timed out'
  : e.cause?.code || e.cause?.message || e.message || 'fetch failed');

// --------------------------------------------------------- tool: search ----
function cleanUrl(href) {
  let u = decodeEntities(href).trim();
  if (/\/l\/\?|\/l\/&/.test(u) || /duckduckgo\.com\/l/.test(u)) {
    const m = u.match(/[?&]uddg=([^&]+)/);
    if (m) { try { u = decodeURIComponent(m[1]); } catch {} }
  }
  if (u.startsWith('//')) u = 'https:' + u;
  return u;
}

function dedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    let key;
    try {
      const u = new URL(r.url);
      key = u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
    } catch { key = r.url; }
    if (seen.has(key) || !/^https?:/i.test(r.url)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function searchDDG(query) {
  const body = new URLSearchParams({ q: query, kl: 'wt-wt' });
  const res = await httpFetch('https://lite.duckduckgo.com/lite/', {
    method: 'POST', body,
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'https://lite.duckduckgo.com/' },
  });
  const rows = [];
  const anchors = [...res.text.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)]
    .filter((m) => /class=["'][^"']*result-link/i.test(m[1]));
  const snippets = [...res.text.matchAll(/<(?:td|div|a)\b[^>]*class=["'][^"']*result-snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:td|div|a)\s*>/gi)]
    .map((m) => stripTags(m[1]));
  anchors.forEach((m, i) => {
    rows.push({
      title: stripTags(m[2]),
      url: cleanUrl((m[1].match(/href\s*=\s*["']([^"']*)["']/i) || [])[1] || ''),
      desc: snippets[i] || '',
    });
  });
  if (!rows.length && (res.status === 202 || /anomaly|challenge/i.test(res.text))) {
    throw new Error('rate-limited (anti-bot page)');
  }
  return rows;
}

async function searchDDGHtml(query) {
  const res = await httpFetch('https://html.duckduckgo.com/html/', {
    method: 'POST', body: new URLSearchParams({ q: query }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const rows = [];
  const titleRe = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  const snippets = [...res.text.matchAll(/<(?:a|div|td)\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|td)\s*>/gi)]
    .map((m) => stripTags(m[1]));
  let m, i = 0;
  while ((m = titleRe.exec(res.text))) {
    if (!/class=["'][^"']*result__a/i.test(m[1])) continue;
    rows.push({
      title: stripTags(m[2]),
      url: cleanUrl((m[1].match(/href\s*=\s*["']([^"']*)["']/i) || [])[1] || ''),
      desc: snippets[i++] || '',
    });
  }
  if (!rows.length && (res.status === 202 || /anomaly|challenge/i.test(res.text))) {
    throw new Error('rate-limited (anti-bot page)');
  }
  return rows;
}

async function searchBrave(query) {
  const res = await httpFetch('https://search.brave.com/search?q=' + encodeURIComponent(query), {
    headers: { 'accept-language': 'en-US,en;q=0.9' },
  });
  const rows = [];
  for (const block of res.text.split(/<div class="snippet\s/).slice(1)) {
    if (/data-type="ad"/.test(block.slice(0, 200))) continue;
    const href = (block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/) || [])[1];
    const title = stripTags((block.match(/<div class="title[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
    const desc = stripTags((block.match(/<div class="content[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
    if (href && title) rows.push({ title, url: href, desc });
  }
  if (!rows.length && res.status === 429) throw new Error('rate-limited (HTTP 429)');
  return rows;
}

const searxBase = () => (process.env.HELPER_SEARX_URL || readConfig().searx || '').replace(/\/+$/, '');

// 4get (https://4get.ca) is a search proxy: it scrapes from *its* IP, so it keeps
// working when our own IP is rate-limited. Public instances come and go, so try
// the configured list and remember the one that answered.
const DEFAULT_4GET = ['https://4get.ca', 'https://search.m0e.space'];
const instancesFile = () => path.join(CACHE_DIR, '4get-instances.json'); // CACHE_DIR is declared later
const INSTANCES_TTL = 7 * 24 * 3600 * 1000;    // refresh weekly
const INSTANCES_MAX_TRY = 3;                    // per search, keeps a dead list bounded
const INSTANCES_PER_ENGINE = ['ddg', 'yandex'];
let fourgetGood = '';
let fourgetDead = false;
const fourgetBad = new Set();                   // dead this session

const trimBase = (u) => String(u).trim().replace(/\/+$/, '');
const offValue = (v) => /^(off|0|none|false|no)$/i.test(String(v ?? '').trim());

/** explicit instance list (env or config) wins over the auto-updated one */
function explicitFourgetBases() {
  const v = process.env.HELPER_4GET_URL ?? readConfig().fourget;
  if (v === undefined || v === null || String(v).trim() === '') return null;
  if (offValue(v)) return [];
  return String(v).split(',').map(trimBase).filter(Boolean);
}

/** where the community list comes from: the 4get repo's INSTANCES array,
 *  which is what every instance's /instances page renders */
function fourgetFinder() {
  const v = process.env.HELPER_4GET_FINDER ?? readConfig().fourgetFinder;
  if (v !== undefined && v !== null && String(v).trim() !== '') {
    return offValue(v) ? '' : String(v).trim();
  }
  return 'https://git.lolcat.ca/lolcat/4get/raw/branch/master/data/config.php';
}

async function fetchFourgetInstances() {
  const src = fourgetFinder();
  if (!src) return [];
  const res = await httpFetch(src, { timeout: 8000 });
  if (res.status !== 200) throw new Error(`finder HTTP ${res.status}`);

  let found = [];
  if (/^\s*\[/.test(res.text)) {                        // a JSON array of urls
    try { found = JSON.parse(res.text); } catch {}
  } else {
    const block = res.text.match(/INSTANCES\s*=\s*\[([\s\S]*?)\]/i);
    const body = block ? block[1] : res.text;
    found = [...body.matchAll(/["'](https?:\/\/[^"'\s]+)["']/g)].map((m) => m[1]);
  }
  return [...new Set(found.map(trimBase))].filter((u) => /^https?:\/\//i.test(u));
}

/** cached community list, refreshed when stale (or forced) */
async function autoFourgetBases({ force = false } = {}) {
  const cache = readJson(instancesFile());
  const cached = Array.isArray(cache?.instances) ? cache.instances : [];
  const fresh = cached.length && Date.now() - (cache.at || 0) < INSTANCES_TTL;
  if (fresh && !force) return cached;

  try {
    const got = await fetchFourgetInstances();
    if (got.length) {
      writeJson(instancesFile(), { at: Date.now(), source: fourgetFinder(), instances: got, cursor: cache?.cursor || 0 });
      return got;
    }
  } catch { /* offline or finder moved: fall back below */ }
  return cached.length ? cached : DEFAULT_4GET;
}

/** rotate through the list so one dead instance does not starve the rest */
function rotate(list) {
  const cache = readJson(instancesFile());
  const start = list.length ? (Number(cache?.cursor) || 0) % list.length : 0;
  const ordered = [...list.slice(start), ...list.slice(0, start)];
  // only move the cursor: the cached instance list itself must survive sessions
  writeJson(instancesFile(), { ...(cache || {}), cursor: (start + INSTANCES_MAX_TRY) % Math.max(1, list.length) });
  return ordered;
}

async function search4get(query) {
  if (fourgetDead) throw new Error('not configured');
  const explicit = explicitFourgetBases();
  if (explicit && !explicit.length) throw new Error('not configured');
  const notes = [];
  let sawJson = false;
  // remember the instance that worked, across runs too
  const preferred = fourgetGood || readJson(instancesFile())?.lastGood || '';

  const tryBases = async (list) => {
    const usable = list.filter((b) => !fourgetBad.has(b));
    const ordered = preferred && usable.includes(preferred)
      ? [preferred, ...rotate(usable.filter((b) => b !== preferred))]
      : rotate(usable);
    for (const base of ordered.slice(0, INSTANCES_MAX_TRY)) {
      for (const scraper of INSTANCES_PER_ENGINE) {
        let res;
        try {
          res = await httpFetch(`${base}/api/v1/web?s=${encodeURIComponent(query)}&scraper=${scraper}`, {
            timeout: 6000, headers: { accept: 'application/json' },
          });
        } catch (e) { notes.push(`${hostOf(base)}: ${fetchErr(e)}`); fourgetBad.add(base); break; }
        if (/not a bot|anubis|verifying your browser/i.test(res.text)) {
          notes.push(`${hostOf(base)}: bot check`); fourgetBad.add(base); break;
        }
        if (res.status === 429 || res.status >= 500) {
          notes.push(`${hostOf(base)}: HTTP ${res.status}`); fourgetBad.add(base); break;
        }
        if (res.status !== 200) { notes.push(`${hostOf(base)}: HTTP ${res.status}`); break; }

        let j;
        try { j = JSON.parse(res.text); } catch { notes.push(`${hostOf(base)}: not JSON`); fourgetBad.add(base); break; }
        sawJson = true;
        if (j.status && String(j.status).toLowerCase() !== 'ok') {
          notes.push(`${scraper}: ${clip(String(j.status), 50)}`);
          continue;                                 // that engine was blocked upstream
        }
        const rows = (j.web || []).map((r) => ({
          title: r.title || '',
          url: r.url || '',
          desc: String(r.description || '').replace(/\s+/g, ' ').trim(),
        }));
        if (rows.length) {
          fourgetGood = base;
          writeJson(instancesFile(), { ...(readJson(instancesFile()) || {}), lastGood: base });
          return rows;
        }
        notes.push(`${scraper}: empty`);
      }
    }
    return null;
  };

  let rows = await tryBases(explicit || await autoFourgetBases());
  if (!rows && !explicit) {
    // every known instance failed: re-read the finder in case the list moved
    const again = await autoFourgetBases({ force: true });
    if (again.length) rows = await tryBases(again);
  }
  if (rows) return rows;

  if (!sawJson) fourgetDead = true;                 // every instance unreachable
  throw new Error(notes.slice(0, 3).join('; ') || 'no results');
}

/** SearXNG: your own instance (public ones are usually behind bot checks) */
async function searchSearx(query) {
  const base = searxBase();
  const res = await httpFetch(`${base}/search?q=${encodeURIComponent(query)}&format=json&language=en`, {
    headers: { accept: 'application/json' },
  });
  if (/anubis|not a bot|verifying your browser|security check|substation/i.test(res.text)) {
    throw new Error('blocked by the instance\'s bot check');
  }
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);

  if (/json/i.test(res.type) || res.text.trimStart().startsWith('{')) {
    const j = JSON.parse(res.text);
    return (j.results || []).map((r) => ({ title: r.title || '', url: r.url || '', desc: (r.content || '').replace(/\s+/g, ' ').trim() }));
  }
  // instances with the JSON API disabled still serve parseable HTML
  const rows = [];
  for (const m of res.text.matchAll(/<article\b[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)<\/article\s*>/gi)) {
    const block = m[1];
    const href = (block.match(/<a[^>]+href="([^"]+)"/i) || [])[1];
    const title = stripTags((block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i) || [])[1] || '');
    const desc = stripTags((block.match(/<p\b[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
      || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || '');
    if (href && title) rows.push({ title, url: href, desc });
  }
  if (!rows.length) throw new Error('no results (JSON disabled and no HTML results)');
  return rows;
}

async function webSearch(query) {
  const attempts = [];
  if (!offValue(process.env.HELPER_4GET_URL ?? readConfig().fourget)) attempts.push(['4get', search4get]);
  if (searxBase()) attempts.push(['searxng', searchSearx]);
  attempts.push(['duckduckgo lite', searchDDG], ['duckduckgo html', searchDDGHtml], ['brave', searchBrave]);
  const notes = [];
  for (const [name, fn] of attempts) {
    try {
      const rows = dedupe(await fn(query)).slice(0, CFG.maxResults);
      if (rows.length) {
        return rows.map((r, i) =>
          `${i + 1}) ${clip(r.title, 120)}\n   ${r.url}\n   ${clip(r.desc, 240)}`).join('\n');
      }
      notes.push(name + ': no results');
    } catch (e) {
      notes.push(name + ': ' + String(fetchErr(e)).slice(0, 80));
    }
  }
  return `No results for "${query}". [${notes.join('; ')}]`;
}

// ---------------------------------------------------------- tool: fetch ----
async function webFetch(rawUrl) {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let res;
  try { res = await httpFetch(url); }
  catch (e) { return `Fetch failed: ${fetchErr(e)} for ${url}`; }
  if (res.status >= 400) return `Fetch failed: HTTP ${res.status} for ${res.url}`;
  if (!res.text) return `Fetch failed: unsupported content-type (${res.type || 'unknown'}) for ${res.url}`;

  if (/^application\/json/i.test(res.type)) return clip(res.text, CFG.fetchChars);
  const md = htmlToMarkdown(res.text, res.url);
  let out = md.text || stripTags(res.text);
  // only add the page title when the body does not already start with it
  const norm = (s) => s.replace(/[#\s]+/g, ' ').trim().toLowerCase();
  const head = (out.match(/^#\s+(.+)$/m) || [])[1];
  if (md.title && (!head || norm(head) !== norm(md.title)) && !norm(out).startsWith(norm(md.title))) {
    out = `# ${md.title}\n\n` + out;
  }
  if (md.indexPage) {
    out = '[this looks like an index/homepage: mostly links, little article text. '
      + 'web_fetch a specific article URL for actual content]\n\n' + out;
  } else if (md.thin) {
    out = '[little readable text: this page is probably rendered by JavaScript, or is mostly '
      + 'navigation. Try a raw/direct URL (e.g. raw.githubusercontent.com for a GitHub README) '
      + 'or another source]\n\n' + out;
  }
  if (out.trim().length < 120 && /pdf/i.test(res.type)) return 'PDF documents are not supported by web_fetch.';
  if (out.length > CFG.fetchChars) {
    out = out.slice(0, CFG.fetchChars) + `\n\n[truncated — ${out.length} chars total]`;
  }
  return out.trim() || 'Page had no readable text.';
}

// ----------------------------------------------------------- tool: read ----
function projectRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return process.cwd(); }
}
const ROOT = projectRoot();

function resolveIn(rel) {
  const abs = path.resolve(ROOT, rel || '.');
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new Error(`path escapes project root (${ROOT})`);
  return abs;
}

const SKIP = new Set(['.git', 'node_modules', 'target', '.direnv', 'result', '__pycache__', '.venv', 'dist', 'build']);

function readTool(rel, offset, limit) {
  const abs = resolveIn(rel);
  const st = statSync(abs);

  if (st.isDirectory()) {
    const entries = readdirSync(abs, { withFileTypes: true })
      .filter((e) => !SKIP.has(e.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const lines = entries.slice(0, 200).map((e) => {
      if (e.isDirectory()) return e.name + '/';
      let size = '';
      try { size = '  ' + humanSize(statSync(path.join(abs, e.name)).size); } catch {}
      return e.name + size;
    });
    return `dir ${path.relative(ROOT, abs) || '.'} (${entries.length} entries)\n` + lines.join('\n');
  }

  if (st.size > 2_000_000) return `File too large (${(st.size / 1e6).toFixed(1)} MB). Use offset/limit on a smaller file.`;
  const buf = readFileSync(abs);
  if (buf.subarray(0, 4096).includes(0)) return 'Binary file, not readable as text.';
  const all = buf.toString('utf8').split('\n');
  const start = Math.max(1, Number(offset) || 1);
  const max = Math.min(Number(limit) || CFG.readLines, 1500);
  const slice = all.slice(start - 1, start - 1 + max);
  if (!slice.length) return `No lines at offset ${start} (file has ${all.length}).`;

  const cap = Math.min(20000, Math.max(2000, Math.floor(CFG.chars / 2)));
  const out = [];
  let bytes = 0;
  for (let i = 0; i < slice.length; i++) {
    const line = `${start + i}| ${slice[i]}`;
    if (bytes + line.length + 1 > cap) break;
    out.push(line);
    bytes += line.length + 1;
  }
  const body = out.join('\n');
  const more = start - 1 + out.length < all.length
    ? `\n\n[${all.length} lines total — continue with offset=${start + out.length}]` : '';
  return `file ${path.relative(ROOT, abs)} (${all.length} lines)\n` + body + more;
}

// ----------------------------------------------------------- tool table ----
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file, or list a directory, inside the current project. Use this for every question about local files or code.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'path relative to project root' },
          offset: { type: 'integer', description: 'first line, 1-based' },
          limit: { type: 'integer', description: 'max lines (default 250)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web. Use for public facts, docs, software versions and news. Not for files in this project. Returns titles, URLs and short descriptions.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'search query' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Download a URL and return its main text as markdown (reading mode). Use it after web_search to read a promising result.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'http(s) URL' } },
        required: ['url'],
      },
    },
  },
];

async function runTool(name, args) {
  switch (name) {
    case 'web_search':
      if (!args.query) return { text: 'web_search needs a "query" argument.', hint: '(no query)' };
      return { text: await webSearch(String(args.query)), hint: args.query };
    case 'web_fetch':
      if (!args.url) return { text: 'web_fetch needs a "url" argument.', hint: '(no url)' };
      return { text: await webFetch(String(args.url)), hint: args.url };
    case 'read': return { text: readTool(String(args.path ?? '.'), args.offset, args.limit), hint: args.path };
    default: return { text: `Unknown tool "${name}". Available: web_search, web_fetch, read.`, hint: name };
  }
}

// ------------------------------------------------- model provisioning ----
// `helper "question"` should not require a hand-started llama-server: find the
// binary, pick or fetch a model, start it detached, and reuse it next time.
const HOME = os.homedir();
const CACHE_DIR = path.join(HOME, '.cache/helper');
const MODELS_DIR = path.join(CACHE_DIR, 'models');
const STATE_FILE = path.join(CACHE_DIR, 'server.json');
const LOG_FILE = path.join(CACHE_DIR, 'llama-server.log');
const CONFIG_FILE = path.join(HOME, '.config/helper/config.json');
const LOCK_FILE = path.join(CACHE_DIR, 'server.lock');

const RECOMMENDED = {
  name: 'Sharp-MiniCPM5-2B-Q4_K_S.gguf',
  url: 'https://huggingface.co/peculiar-ragdoll/Sharp-MiniCPM5-2B-GGUF/resolve/main/Sharp-MiniCPM5-2B-Q4_K_S.gguf',
  bytes: 1516390912,
  args: ['--jinja'],
  sampling: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0 },
};

const isExec = (p) => { try { const s = statSync(p); return s.isFile() && (s.mode & 0o100) !== 0; } catch { return false; } };
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => { try { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 1)); } catch {} };
const readConfig = () => readJson(CONFIG_FILE) || {};
const readState = () => readJson(STATE_FILE);
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function findServerBinary() {
  const cfg = readConfig();
  const dirs = [
    process.env.HELPER_BIN_DIR, cfg.binDir,
    path.join(HOME, '.nix-profile/bin'), path.join(HOME, '.local/bin'),
    '/run/current-system/sw/bin', '/usr/local/bin', '/usr/bin',
    ...(process.env.PATH || '').split(':'),
  ].filter(Boolean);
  for (const d of dirs) {
    for (const name of ['llama-server', 'llama-server.exe']) {
      const p = path.join(d, name);
      if (isExec(p)) return p;
    }
  }
  return null;
}

function findLocalModels() {
  const cfg = readConfig();
  const roots = [
    cfg.modelsDir, process.env.HELPER_MODEL_DIR,
    path.join(HOME, '.cache/huggingface/hub'), path.join(HOME, 'models'),
    path.join(HOME, '.local/share/models'), path.join(HOME, '.cache/llama.cpp'),
  ].filter((r) => r && existsSync(r));

  const found = [];
  const walk = (dir, depth) => {
    if (depth > 5 || found.length > 300) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!/^(\.|node_modules$|proc$|sys$)/.test(e.name)) walk(p, depth + 1);
      } else if (/\.gguf$/i.test(e.name) && !/mmproj/i.test(e.name)) {
        try {
          const st = statSync(p);
          // ignore placeholders, mmproj files and models no laptop can load
          if (st.size > 100e6 && st.size < 20e9) {
            found.push({ path: p, size: st.size, mtime: st.mtimeMs, score: modelScore(e.name, st.size) });
          }
        } catch {}
      }
    }
  };
  roots.forEach((r) => walk(r, 0));
  return found;
}

/** rough guess at "will this small model actually call tools?" */
function modelScore(name, size) {
  const n = name.toLowerCase();
  let s = 0;
  if (/sharp|minicpm/.test(n)) s += 5;
  if (/instruct|chat|it\.gguf/.test(n)) s += 3;
  if (/qwen2\.5|qwen3|llama-3\.[12]|smol|gemma|phi-/.test(n)) s += 2;
  if (/q4_k_m|q4_k_s|q5_k_m|q6_k|q8_0/.test(n)) s += 1;
  if (/3d|glb|vision|[-_]vl|embed|whisper|base\.gguf|draft/.test(n)) s -= 5;
  if (size < 400e6) s -= 2;          // 0.5B models rarely route tools
  if (size > 12e9) s -= 4;           // big for a laptop helper
  return s;
}

async function downloadModel(url, dest, expected) {
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || expected || 0);
  let got = 0, lastPct = -1;
  const fd = openSync(tmp, 'w');
  try {
    for await (const chunk of res.body) {
      writeSync(fd, chunk);
      got += chunk.length;
      if (TTY && total) {
        const pct = Math.floor((got / total) * 100);
        if (pct >= lastPct + 5) {
          lastPct = pct;
          process.stderr.write(`\r  ${String(pct).padStart(3)}%  ${humanSize(got)} / ${humanSize(total)}`);
        }
      }
    }
  } finally {
    closeSync(fd);
    if (TTY && total) process.stderr.write('\n');
  }
  renameSync(tmp, dest);
  return dest;
}

async function ensureModel() {
  if (CFG.modelFile) return path.resolve(CFG.modelFile);
  const cfg = readConfig();
  if (cfg.model && existsSync(cfg.model)) return cfg.model;

  const best = findLocalModels().sort((a, b) => b.score - a.score || b.mtime - a.mtime)[0];
  if (best && best.score >= 3) {
    if (!cfg.model) process.stderr.write(dim(`using ${path.basename(best.path)}\n`));
    return best.path;
  }

  const dest = path.join(MODELS_DIR, RECOMMENDED.name);
  if (existsSync(dest) && statSync(dest).size === RECOMMENDED.bytes) return dest;
  process.stderr.write(dim(`\nno tool-capable model on disk — fetching ${RECOMMENDED.name} (${humanSize(RECOMMENDED.bytes)}), once\n`));
  try {
    return await downloadModel(RECOMMENDED.url, dest, RECOMMENDED.bytes);
  } catch (e) {
    throw new Error(`could not fetch a model (${e.message}). Put a .gguf somewhere under ~/models, or set HELPER_MODEL_FILE=/path/to.gguf`);
  }
}

const presetFor = (model) => {
  const cfg = readConfig();
  if (cfg.preset) return cfg.preset;
  return path.basename(model) === RECOMMENDED.name ? RECOMMENDED : {};
};

function applyPreset(preset) {
  // model-recommended sampling; explicit env vars always win
  const p = preset?.sampling || preset || {};
  if (p.temperature != null && !process.env.HELPER_TEMP) CFG.temp = p.temperature;
  for (const k of ['top_p', 'top_k', 'min_p', 'repeat_penalty']) {
    if (p[k] != null && !ENV_SAMPLING.has(k)) SAMPLING[k] = p[k];
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const healthUrl = (base) => base.replace(/\/v\d+\/?$/, '') + '/health';

async function healthy(base, timeout = 1500) {
  try {
    const r = await fetch(healthUrl(base), { signal: AbortSignal.timeout(timeout) });
    return r.ok;
  } catch { return false; }
}

function serverArgs(model, port, withJinja) {
  const cfg = readConfig();
  // 16k default: MiniCPM's chat template renders the tool definitions inline,
  // which costs ~7k tokens before a single word of the question
  const ctx = num(process.env.HELPER_CTX, num(cfg.context, 16384));
  const threads = num(cfg.threads, Math.max(2, Math.min(12, os.cpus().length - 1)));
  // GPU layers: llama.cpp offloads what it can; -ngl 0 forces CPU, and a
  // CPU-only build ignores the flag. Env wins over config wins over default.
  const envNgl = process.env.HELPER_NGL;
  const ngl = envNgl !== undefined && envNgl !== '' ? Number(envNgl)
    : cfg.gpuLayers !== undefined ? Number(cfg.gpuLayers) : 99;
  const extra = cfg.serverArgs || [];
  return ['-m', model, '-c', String(ctx), '-t', String(threads), '-np', '1',
    '-ngl', String(Number.isFinite(ngl) ? ngl : 99),
    '--host', '127.0.0.1', '--port', String(port),
    ...(withJinja ? ['--jinja'] : []), ...extra];
}

function spawnDetached(bin, args) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const fd = openSync(LOG_FILE, 'a');
  try {
    const child = spawn(bin, args, { detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    return child.pid;
  } finally { closeSync(fd); }
}

const logTail = (n = 800) => {
  try { return readFileSync(LOG_FILE, 'utf8').slice(-n); } catch { return ''; }
};

// one spawn at a time: two terminals starting `helper` together must not race
// on the model download or start two servers
function acquireLock() {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const fd = openSync(LOCK_FILE, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
    // never leave a stale lock behind, even on ctrl-c
    process.once('exit', () => { try { unlinkSync(LOCK_FILE); } catch {} });
    return true;
  } catch { return false; }
}
const releaseLock = () => { try { unlinkSync(LOCK_FILE); } catch {} };
const lockAge = () => { try { return Date.now() - statSync(LOCK_FILE).mtimeMs; } catch { return Infinity; } };

function adopt(st) {
  CFG.base = st.base;
  if (st.model) CFG.model = st.model;
  applyPreset(st.preset);
}

/** a recorded server we can use: its process is alive, or something answers /health */
async function adoptIfUp(st) {
  if (!st?.base) return false;
  // an alive process is authoritative: with -np 1 a busy server will not answer
  // /health in time, and killing it mid-answer would be a bug
  if (st.pid && isAlive(st.pid)) { adopt(st); return true; }
  if (await healthy(st.base)) { adopt(st); return true; }
  return false;
}

/** wait for a server another helper is starting (or one that is already up) */
async function waitForServer(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await adoptIfUp(readState())) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function waitHealthy(base, pid, ms) {
  const until = Date.now() + ms;
  let dots = 0;
  while (Date.now() < until) {
    if (await healthy(base, 1200)) return true;
    if (pid && !isAlive(pid)) return false;
    if (TTY && dots++ % 8 === 0) process.stderr.write(dim('.'));
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function ensureServer() {
  // 1. the user pointed at a server: use it, never spawn
  if (CFG.baseExplicit || process.env.HELPER_NO_SPAWN === '1') {
    if (await healthy(CFG.base)) return;
    const why = CFG.baseExplicit ? 'HELPER_BASE_URL is set' : 'HELPER_NO_SPAWN=1';
    throw new Error(`no server answering at ${CFG.base} (${why}, so ${PROG} will not start one)`);
  }

  // 2. a server we started earlier is still warm: reuse it (alive pid wins)
  if (await adoptIfUp(readState())) return;

  // 3. take the start lock (the model may need a 1.5 GB download)
  if (!acquireLock()) {
    if (lockAge() > 900000) releaseLock();          // stale lock (crashed starter), take over
    if (!acquireLock()) {
      process.stderr.write(dim(`another ${PROG} is starting the model, waiting…\n`));
      if (await waitForServer(240000)) return;
      throw new Error(`timed out waiting for another ${PROG} to start the server (log: ${LOG_FILE})`);
    }
  }
  try {
    // 4. start one (re-check: the other helper may have just finished)
    if (await adoptIfUp(readState())) return;

    const bin = findServerBinary();
    if (!bin) {
      throw new Error('llama-server not found on PATH.\n' +
        '  nix:      nix develop    (or `direnv allow` once, this repo has a flake)\n' +
        '  anywhere: install llama.cpp, or set HELPER_BIN_DIR to its bin/, or\n' +
        '            HELPER_BASE_URL to an existing server (e.g. ollama on :11434)');
    }
    const model = await ensureModel();
    const preset = presetFor(model);
    const port = await freePort();
    const base = `http://127.0.0.1:${port}/v1`;
    process.stderr.write(dim(`starting llama-server · ${path.basename(model)} · :${port}`));

    const wantsJinja = Array.isArray(preset.args) ? preset.args.includes('--jinja')
      : /sharp|minicpm|qwen3|gemma|phi/i.test(path.basename(model));
    let pid = spawnDetached(bin, serverArgs(model, port, wantsJinja));
    let ok = await waitHealthy(base, pid, 180000);
    if (!ok && wantsJinja) {
      // some GGUFs ship no template at all; retry without --jinja
      process.stderr.write(dim(' retrying without --jinja'));
      pid = spawnDetached(bin, serverArgs(model, port, false));
      ok = await waitHealthy(base, pid, 180000);
    }
    process.stderr.write(TTY ? '\r\x1b[2K' : '\n');
    if (!ok) {
      const tail = logTail(1000).trim();
      throw new Error('llama-server did not start. log: ' + LOG_FILE + (tail ? '\n' + tail : ''));
    }

    writeJson(STATE_FILE, { pid, base, model, preset, started: Date.now() });
    CFG.base = base;
    CFG.model = model;
    applyPreset(preset);
  } finally {
    releaseLock();
  }
}

function stopServer() {
  const st = readState();
  if (!st?.pid) { console.log(`no ${PROG}-managed server running`); return; }
  try { process.kill(st.pid, 'SIGTERM'); } catch {}
  try { unlinkSync(STATE_FILE); } catch {}
  console.log(`stopped llama-server (pid ${st.pid}, ${path.basename(st.model || '')})`);
}

/** `helper --instances [refresh]` */
async function listInstances(refresh) {
  const explicit = explicitFourgetBases();
  if (explicit) {
    console.log(`explicit list (HELPER_4GET_URL / config "fourget"): ${explicit.length || 'none (disabled)'}`);
    explicit.forEach((u) => console.log('  ' + u));
    return;
  }

  const list = await autoFourgetBases({ force: refresh });
  const cache = readJson(instancesFile());
  const age = cache?.at ? `${Math.round((Date.now() - cache.at) / 3600000)}h old` : 'not cached';
  const src = fourgetFinder() || 'finder disabled';
  console.log(`${list.length} 4get instances (${age})  ← ${src}`);
  for (const u of list) console.log('  ' + u + (fourgetBad.has(u) ? '  [failed this session]' : ''));
  console.log(dim('cache: ' + instancesFile() + ' (refreshed weekly, or with `${PROG} --instances refresh`)'));
}

// where this copy actually lives: /nix/store/... means a frozen `nix build` /
// `nix profile install` copy, not the working tree
const SOURCE_FILE = (() => { try { return fileURLToPath(import.meta.url); } catch { return process.argv[1] || '?'; } })();
const FROZEN = SOURCE_FILE.startsWith('/nix/store/');

async function serverStatus() {
  console.log(`source  ${SOURCE_FILE}${FROZEN ? '  (frozen build — `nix profile install .` or `nix build` again to update)' : ''}`);
  const st = readState();
  if (!st?.pid) { console.log(`no ${PROG}-managed server (${PROG} starts one on first use)`); return; }
  const alive = isAlive(st.pid);
  const answering = alive && await healthy(st.base);
  const state = alive ? (answering ? 'running' : 'running (busy or still loading)') : 'stale';
  console.log(`${state} pid=${st.pid} ${st.base} ${path.basename(st.model || '')}`);
  if (!alive) console.log(dim(`  the next \`${PROG}\` call will start a fresh one`));
}

// ---------------------------------------------------------------- output ---
// Everything transient (thinking, tool calls) goes to stderr in a small panel
// that collapses into one line when the answer starts. The answer goes to
// stdout, with light markdown styling when stdout is a terminal.
const COLS = () => Math.max(40, (process.stderr.columns || process.stdout.columns || 80) - 1);


// markdown styles use per-attribute resets so they can nest (bold containing a
// link keeps its bold after the link's underline ends)
const mdBold = (s) => (COLOR ? `\x1b[1m${s}\x1b[22m` : s);
const mdItalic = (s) => (COLOR ? `\x1b[3m${s}\x1b[23m` : s);
const mdUnder = (s) => (COLOR ? `\x1b[4m${s}\x1b[24m` : s);
const mdCode = (s) => (COLOR ? `\x1b[36m${s}\x1b[39m` : s);
const mdDim = (s) => (COLOR ? `\x1b[2m${s}\x1b[22m` : s);

/** one line of model markdown -> styled line; no-op when not a TTY */
function styleMdLine(line, state) {
  if (!COLOR) return line;
  if (/^\s*```/.test(line)) {
    state.inFence = !state.inFence;
    return mdDim(line);
  }
  if (state.inFence) return line;

  // inline first, on the raw text: inserting escapes earlier would let the
  // link/bold regexes match their own ANSI sequences
  let out = line;
  const stash = [];
  const hold = (s) => `\u0001${stash.push(s) - 1}\u0001`;
  const italic = (t) => t.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\*)/g, (_, pre, s) => pre + mdItalic(s));

  out = out.replace(/`([^`]+)`/g, (_, c) => hold(mdCode(c)));
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => hold(mdUnder(t) + ' ' + mdDim(u)));
  // ***both***, then **bold** (which may contain *italic* and code), then *italic*
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, (_, t) => hold(mdBold(mdItalic(t))));
  out = out.replace(/\*\*(.+?)\*\*/g, (_, t) => hold(mdBold(italic(t))));
  out = italic(out);

  // placeholders can nest (code inside bold), so expand until none are left
  for (let i = 0; i < 5 && /\u0001\d+\u0001/.test(out); i++) {
    out = out.replace(/\u0001(\d+)\u0001/g, (_, k) => stash[+k]);
  }

  // then line-level markers
  out = out
    .replace(/^(#{1,6})\s+(.*)$/, (_, h, t) => mdDim(h) + ' ' + mdBold(t))
    .replace(/^(\s*)([-*+])\s+/, (_, sp, m) => sp + mdDim(m) + ' ')
    .replace(/^(\s*)(\d+\.)\s+/, (_, sp, m) => sp + mdDim(m) + ' ')
    .replace(/^(\s*)>\s?/, (_, sp) => sp + mdDim('│ '));
  return out;
}

/** line-buffered so styles never straddle a chunk boundary */
function mdStream() {
  let buf = '';
  const state = { inFence: false };
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        process.stdout.write(styleMdLine(buf.slice(0, i), state) + '\n');
        buf = buf.slice(i + 1);
      }
    },
    end() {
      if (buf.length) process.stdout.write(styleMdLine(buf, state) + '\n');
      buf = '';
    },
  };
}

/** rows drawn below the cursor, so they can be erased again */
const panel = {
  rows: [],
  drawn: 0,
  statusOn: false,

  erase() {
    if (!TTY || !this.drawn) return;
    const maxRows = (process.stderr.rows || 24) - 1;
    if (this.drawn > maxRows) { this.drawn = 0; this.rows = []; return; } // too tall: leave it
    process.stderr.write(`\x1b[${this.drawn}A\r\x1b[J`);
    this.drawn = 0;
  },

  render() {
    if (!TTY) return;
    this.erase();
    if (this.rows.length) process.stderr.write(this.rows.join('\n') + '\n');
    this.drawn = this.rows.length;
  },

  line(plain) {
    if (!TTY) { process.stderr.write(dim('  ' + plain) + '\n'); return; }
    this.statusOn = false;
    this.rows.push(dim('  ' + plain));
    this.render();
  },

  status(plain) {
    if (!TTY) return;
    const row = dim('  ' + plain);
    if (this.statusOn && this.rows.length) this.rows[this.rows.length - 1] = row;
    else { this.rows.push(row); this.statusOn = true; }
    this.render();
  },

  clear() {
    this.erase();
    this.rows = [];
    this.statusOn = false;
  },
};

const hostOf = (u) => {
  try { return new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u).hostname.replace(/^www\./, ''); }
  catch { return clip(String(u), 30); }
};

/** panel paths are relative to the project root (or ~), never absolute */
function shortPath(p, compact = false) {
  let s = String(p).trim();
  if (!s) return s;
  const home = process.env.HOME || '';
  if (ROOT !== '/' && s === ROOT) s = '.';
  else if (ROOT !== '/' && s.startsWith(ROOT + '/')) s = s.slice(ROOT.length + 1);
  else if (home && s === home) s = '~';
  else if (home && s.startsWith(home + '/')) s = '~/' + s.slice(home.length + 1);
  if (compact) {
    const seg = s.split('/');
    if (seg.length > 2) s = '…/' + seg.slice(-2).join('/');
  }
  return s;
}

/** one line, dropping items from the middle instead of cutting a name in half */
function joinFitted(items, width) {
  const list = items.slice();
  let dropped = 0;
  const fits = () => list.join(' · ').length + (dropped ? (" · +" + dropped + " more").length : 0) <= width;
  while (list.length > 1 && !fits()) {
    dropped++;
    list.splice(Math.ceil(list.length / 2) - 1, 1);
  }
  const s = list.join(' · ') + (dropped ? (" · +" + dropped + " more") : '');
  return s.length > width ? clip(s, width) : s;
}

/** "read flake.nix" / "read README.md:250-499" / "web_search \"nix 1.0\"" */
function describeCall(name, args = {}, compact = false) {
  if (typeof args === 'string') args = { path: args };
  const h = String(args.query ?? args.url ?? args.path ?? '').replace(/\s+/g, ' ').trim();
  if (name === 'read') {
    if (!h) return 'read .';
    const off = Number(args.offset) || 1;
    const lim = Number(args.limit) || 0;
    const ranged = off > 1 || lim > 0;
    const range = ranged ? `:${off}${lim ? '-' + (off + lim - 1) : '+'}` : '';
    return `read ${shortPath(h, compact)}${range}`;
  }
  if (!h) return name;
  if (name === 'web_search') return `web_search "${clip(h, 40)}"`;
  if (name === 'web_fetch') return `web_fetch ${hostOf(h)}`;
  return `${name} ${clip(h, 40)}`;
}

/** per-question renderer: live panel now, one summary line once the answer starts */
function makeTurnRenderer() {
  const t0 = Date.now();
  const md = mdStream();
  const calls = [];
  let thinkChars = 0, thinkTail = '', answered = false, drawn = false, lastStatus = 0;

  const summary = () => {
    const bits = [];
    const tail = [];
    if (thinkChars > 400) tail.push(`thought ${(thinkChars / 4 / 1000).toFixed(1)}k`);
    tail.push(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const tailStr = tail.join(' · ');
    if (calls.length) {
      const seen = new Map();
      for (const [n, h] of calls) {
        const d = describeCall(n, h);
        seen.set(d, (seen.get(d) || 0) + 1);
      }
      const parts = [...seen].map(([d, c]) => (c > 1 ? `${d} ×${c}` : d));
      // whatever the tail needs, the calls get the rest of the line
      bits.push(joinFitted(parts, Math.max(24, COLS() - tailStr.length - 6)));
    }
    bits.push(tailStr);
    return '▸ ' + bits.join(' · ');
  };

  return {
    think(chunk) {
      thinkChars += chunk.length;
      thinkTail = (thinkTail + chunk).replace(/\s+/g, ' ').slice(-200);
      const now = Date.now();
      if (now - lastStatus < 60) return;          // ~15 updates/s is plenty
      lastStatus = now;
      const room = Math.max(10, COLS() - 34);
      panel.status(`thinking · ${Math.round(thinkChars / 4)} tok${thinkTail ? ' · ' + thinkTail.slice(-room) : ''}`);
      drawn = true;
    },

    answer(chunk) {
      if (!answered) {
        answered = true;
        if (drawn) { panel.clear(); process.stderr.write(dim(summary()) + '\n'); drawn = false; }
      }
      md.push(chunk);
    },

    tool(name, args) {
      calls.push([name, args]);
      const w = Math.max(10, COLS() - 6);
      let d = describeCall(name, args);
      if (d.length > w) d = describeCall(name, args, true);
      panel.line(`⚙ ${d.length > w ? clip(d, w) : d}`);
      drawn = true;
    },

    toolResult(text) {
      panel.line(`→ ${clip(String(text).split('\n')[0], Math.max(10, COLS() - 10))}`);
      drawn = true;
    },

    finish() {
      if (!answered) {
        panel.clear();
        if (drawn) process.stderr.write(dim(summary()) + '\n');
        drawn = false;
      }
      md.end();
    },
  };
}

// ------------------------------------------------------------- the agent ---
function systemPrompt(interactive) {
  const top = (() => {
    try {
      return readdirSync(ROOT, { withFileTypes: true })
        .filter((e) => !SKIP.has(e.name) && !e.name.startsWith('.'))
        .slice(0, 40)
        .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
        .join('  ');
    } catch { return ''; }
  })();
  // local date, not UTC: "today" must match the user's calendar, and an
  // off-by-one date makes a small model reason about the wrong day
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const mode = interactive
    ? 'You are in an interactive shell: the user sees your answer and can reply, and earlier turns are above.'
    : 'This is a single command-line invocation: nobody will reply and there is no next turn. Answer the one question completely; never ask a question, never offer to do more, and if you need something from the user, say what in one line.';

  return [
    `You are "helper", a terse terminal assistant on Linux. Today is ${today}. You are a small local model: keep answers short.`,
    mode,
    'Rules:',
    '1. Never guess file contents or file names. Call read only when the question is about this project or its code.',
    '2. For news, versions, prices or anything that may have changed, call web_search (then web_fetch on the best URL). Your training data is older than today.',
    '3. You cannot run shell commands. When a command is needed, print the exact command in a code block and explain it in one line.',
    '4. Say where an answer came from (file path or URL). If a tool returns nothing, say so instead of making something up.',
    '5. Plain text, no emoji, no preamble, under 120 words unless asked for detail.',
    '6. Stop calling tools once you have enough to answer. Two searches that did not help means: say so.',
    '7. End with the answer, not with a question or an offer to do more.',
    '8. Do not call a tool twice with the same arguments; the result is already above. For a large file read the range you need (offset/limit).',
    'Example: "what does helper.mjs do?" -> call read({"path":"helper.mjs"}), then answer from its contents.',
    '',
    'Project root: ' + ROOT,
    top ? 'Top level: ' + top : '',
  ].filter(Boolean).join('\n');
}

async function pickModel() {
  if (CFG.model) return CFG.model;
  const res = await fetch(CFG.base + '/models', {
    headers: { authorization: 'Bearer ' + CFG.key },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`cannot list models at ${CFG.base} (HTTP ${res.status})`);
  const j = await res.json();
  const id = j?.data?.[0]?.id;
  if (!id) throw new Error(`no models served at ${CFG.base}`);
  CFG.model = id;
  return id;
}

/** One streamed completion. Returns {content, toolCalls}. */
async function complete(messages, signal, render, { allowTools = true } = {}) {
  const res = await fetch(CFG.base + '/chat/completions', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + CFG.key },
    body: JSON.stringify({
      model: CFG.model,
      messages,
      ...(allowTools ? { tools: TOOLS, tool_choice: 'auto' } : {}),
      temperature: CFG.temp,
      max_tokens: CFG.maxTokens,
      ...SAMPLING,
      stream: true,
    }),
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    throw new Error(`chat/completions HTTP ${res.status}: ${body}`);
  }

  const ct = res.headers.get('content-type') || '';
  if (!/event-stream/i.test(ct)) {
    const j = await res.json();
    const m = j.choices?.[0]?.message || {};
    if (m.reasoning_content) render.think(m.reasoning_content);
    if (m.content) render.answer(m.content);
    if (CFG.stats) showStats(j.usage);
    return { content: m.content || '', toolCalls: m.tool_calls || [] };
  }

  let buf = '', content = '';
  const calls = [];
  // small reasoning models put their chain of thought in reasoning_content;
  // it is shown in the panel and never stored in history
  const think = (t) => render.think(t);
  const answer = (t) => { content += t; render.answer(t); };
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (CFG.stats && j.usage) showStats(j.usage);
      const d = j.choices?.[0]?.delta;
      if (!d) continue;
      if (d.reasoning_content) think(d.reasoning_content);
      if (d.content) answer(d.content);
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = Number.isInteger(tc.index) ? tc.index : calls.length;
          calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function?.name) calls[i].function.name += tc.function.name;
          const a = tc.function?.arguments;
          if (a != null) calls[i].function.arguments += typeof a === 'string' ? a : JSON.stringify(a);
        }
      }
    }
  }
  const toolCalls = calls.filter(Boolean);
  return { content, toolCalls };
}

const showStats = (u) => u && process.stderr.write(dim(`[${u.prompt_tokens ?? '?'}→${u.completion_tokens ?? '?'} tok]\n`));

const msgSize = (m) => (m.content || '').length +
  (Array.isArray(m.tool_calls) ? m.tool_calls.reduce((n, t) => n + (t.function?.arguments || '').length, 0) : 0);

/** Keep the small model's context small: drop whole oldest turns, then shrink
 *  the largest tool result if a single turn is still over budget. */
function trimHistory(messages) {
  let size = messages.reduce((n, m) => n + msgSize(m), 0);

  // 1. drop whole oldest turns (never the system prompt or the current turn)
  while (size > CFG.chars) {
    const nextUser = messages.findIndex((m, i) => i > 0 && m.role === 'user');
    if (nextUser <= 1) break;
    for (let i = 1; i < nextUser; i++) size -= msgSize(messages[i]);
    messages.splice(1, nextUser - 1);
  }

  // 2. still too big (one huge turn): drop the oldest tool results whole before
  // halving the newest — half a page invites invention, a dropped one is honest
  const DROPPED = '[earlier tool result dropped to fit the context]';
  while (size > CFG.chars) {
    const toolIdx = [];
    for (let i = 1; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'tool' && m.content && m.content.length > 200) toolIdx.push(i);
    }
    if (!toolIdx.length) break;
    if (toolIdx.length > 1) {
      const msg = messages[toolIdx[0]];
      size += DROPPED.length - msg.content.length;
      msg.content = DROPPED;
      continue;
    }
    const msg = messages[toolIdx[0]];
    if (msg.content.length < 1200) break;
    const keep = Math.max(600, Math.floor(msg.content.length / 2));
    size -= msg.content.length - keep;
    msg.content = msg.content.slice(0, keep) + '\n[…truncated to fit context]';
  }
}


const NUDGE = '(tool budget used up — answer the question now, using only what you already have. '
  + 'If something is still missing, say in one line what and why.)';

async function ask(question, messages, signal) {
  messages.push({ role: 'user', content: question });
  const render = makeTurnRenderer();
  // CFG.steps tool rounds, then one final completion with tools switched off so
  // a looping model still ends with an answer instead of a shrug
  for (let step = 0; step <= CFG.steps; step++) {
    trimHistory(messages);
    const lastStep = step === CFG.steps;
    let content, toolCalls;
    try {
      ({ content, toolCalls } = await complete(lastStep ? [...messages, { role: 'user', content: NUDGE }] : messages,
        signal, render, { allowTools: !lastStep }));
    } catch (e) {
      // the server's context is smaller than system+tools+history: tighten and retry once
      if (/exceed_context_size|exceeds the available context/i.test(e.message) && CFG.chars > 4000) {
        CFG.chars = Math.floor(CFG.chars / 2);
        trimHistory(messages);
        process.stderr.write(dim('\n(context full — retrying with a smaller history)\n'));
        ({ content, toolCalls } = await complete(messages, signal, render, { allowTools: !lastStep }));
      } else throw e;
    }
    if (lastStep) toolCalls = [];        // no tools offered, ignore any that come anyway
    messages.push(toolCalls.length
      ? { role: 'assistant', content: content || null, tool_calls: toolCalls }
      : { role: 'assistant', content });

    if (!toolCalls.length) {
      render.finish();
      if (!content.trim()) {
        process.stdout.write(yellow(step === 0
          ? '(empty response — try a bigger HELPER_MAX_TOKENS)'
          : `(no answer after ${step} tool steps — try a larger HELPER_STEPS or a model that routes tools better)`) + '\n');
      }
      process.stdout.write('\n');
      return content;
    }
    for (const call of toolCalls) {
      const fn = call.function?.name || '';
      let args = {};
      const raw = call.function?.arguments;
      if (raw && typeof raw === 'object') args = raw;
      else { try { args = JSON.parse(raw || '{}') || {}; } catch {} }
      render.tool(fn, args);
      let text;
      try { text = (await runTool(fn, args)).text; }
      catch (e) { text = `Tool error: ${e.name === 'TimeoutError' ? 'request timed out' : e.message}`; }
      render.toolResult(text);
      messages.push({
        role: 'tool',
        tool_call_id: call.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        name: fn || 'unknown',
        content: text,
      });
    }
  }
  // unreachable in practice: the last iteration always answers with tools off
  render.finish();
  return '';
}

// ------------------------------------------------------------------- cli ---
function usage() {
  const rows = [
    [PROG, 'interactive shell'],
    [PROG + ' "question"', 'one-shot answer'],
    [PROG + ' --status', 'is the model server up?'],
    [PROG + ' --instances', 'list the 4get search instances it uses (add: refresh)'],
    [PROG + ' --stop', 'stop the model server it started'],
    [PROG + ' -t <tool> <arg>', 'run a single tool and print raw output (debug)'],
  ];
  const w = Math.max(...rows.map(([a]) => a.length));
  console.log(`${PROG} — stupid-minimal terminal helper for small local models

usage:
${rows.map(([a, b]) => '  ' + a.padEnd(w) + '  ' + b).join('\n')}

options:
  -m, --model <path|id>  use this .gguf file (saved as the default) or model id
  -u, --base-url <url>   use an existing OpenAI-compatible server, never spawn
  -h, --help             this text

First run: finds llama-server (PATH or nix store), picks a tool-capable .gguf on
this machine, or downloads Sharp-MiniCPM5-2B once to ~/.cache/helper/models,
then starts it detached on a free port and reuses it. Model + server settings
live in ~/.config/helper/config.json.

env: HELPER_MODEL_FILE HELPER_BASE_URL HELPER_API_KEY HELPER_TEMP HELPER_MAX_TOKENS
     HELPER_TOP_P HELPER_TOP_K HELPER_MIN_P HELPER_REPEAT_PENALTY HELPER_STATS
     HELPER_STEPS HELPER_MAX_CHARS HELPER_SEARCH_RESULTS HELPER_FETCH_CHARS
     HELPER_READ_LINES HELPER_NO_SPAWN HELPER_BIN_DIR
`);
}

async function main(argv) {
  const args = [...argv];
  let toolName = null, question = [], showStatus = false, showInstances = null;
  while (args.length) {
    const a = args.shift();
    if (a === '-h' || a === '--help') return usage();
    else if (a === '--stop') return stopServer();
    else if (a === '--status') showStatus = true;
    else if (a === '--instances') showInstances = args.shift() || '';
    else if (a === '-m' || a === '--model') {
      const v = args.shift() || '';
      if (v && existsSync(v)) { CFG.modelFile = v; CFG.model = ''; }
      else CFG.model = v;
    } else if (a === '-u' || a === '--base-url') {
      CFG.base = (args.shift() || CFG.base).replace(/\/+$/, '').replace(/(\/v\d+)?$/, '') + '/v1';
      CFG.baseExplicit = true;
    } else if (a === '-t' || a === '--tool') toolName = args.shift();
    else question.push(a);
  }

  if (showStatus) return serverStatus();
  if (showInstances !== null) return listInstances(showInstances === 'refresh');

  if (toolName) {
    const arg = question.join(' ');
    try {
      const r = await runTool(toolName, toolName === 'read' ? { path: arg } : toolName === 'web_fetch' ? { url: arg } : { query: arg });
      console.log(r.text);
    } catch (e) {
      console.error(red(`${PROG}: `) + (e.name === 'TimeoutError' ? 'timed out' : e.message));
      process.exit(1);
    }
    return;
  }

  // remember an explicitly chosen model file for next time
  if (CFG.modelFile) writeJson(CONFIG_FILE, { ...readConfig(), model: path.resolve(CFG.modelFile) });

  try {
    await ensureServer();
  } catch (e) {
    console.error(red(`${PROG}: `) + (e.message || e));
    process.exit(1);
  }

  const oneShot = question.length > 0;
  const messages = [{ role: 'system', content: systemPrompt(!oneShot) }];
  let model;
  try {
    model = await pickModel();
  } catch (e) {
    console.error(red(`${PROG}: `) + e.message);
    process.exit(1);
  }

  if (question.length) {
    const ac = new AbortController();
    process.on('SIGINT', () => ac.abort());
    try {
      const answer = await ask(question.join(' '), messages, ac.signal);
      // one-shot: if it still asks something back, point at the shell that can reply
      if (String(answer || '').trim().endsWith('?')) {
        process.stderr.write(dim(`(one-shot answer — run \`${PROG}\` with no arguments to reply in a session)\n`));
      }
    } catch (e) {
      console.error(red(`\n${PROG}: `) + (e.name === 'AbortError' ? 'aborted' : e.message));
      process.exit(1);
    }
    return;
  }

  // interactive
  console.log(dim(`${PROG} · ${model} · ${CFG.base}`) + dim(`\n/reset  /exit  ·  cwd ${process.cwd()}\n`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: cyan('> ') });
  let ac = null;

  rl.on('SIGINT', () => {
    if (ac) { ac.abort(); ac = null; return; }
    process.stdout.write('\n');
    rl.close();
  });

  const prompt = () => { if (!rl.closed) rl.prompt(); };
  prompt();
  for await (const line of rl) {
    const q = line.trim();
    if (!q) { prompt(); continue; }
    if (q === '/exit' || q === '/quit') break;
    if (q === '/reset') { messages.length = 1; console.log(dim('context cleared')); prompt(); continue; }
    if (q === '/help') { console.log(dim('/reset  clear context\n/exit   quit')); prompt(); continue; }

    ac = new AbortController();
    try {
      await ask(q, messages, ac.signal);
    } catch (e) {
      console.log(red('error: ') + (e.name === 'AbortError' ? 'aborted' : e.message));
    }
    ac = null;
    prompt();
  }
  rl.close();
}

// run only when executed directly — including through a symlink (ln -s into ~/.local/bin)
const invokedPath = (() => {
  try { return realpathSync(process.argv[1] || ''); } catch { return process.argv[1] || ''; }
})();

if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(red(`${PROG}: `) + (e?.stack || e));
    process.exit(1);
  });
}

export {
  htmlToMarkdown, webSearch, webFetch, readTool, TOOLS, ask, CFG, styleMdLine, makeTurnRenderer,
  downloadModel, findServerBinary, findLocalModels, ensureServer, serverArgs, stopServer,
};