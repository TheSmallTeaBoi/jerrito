#!/usr/bin/env node
/**
 * jerrito — a stupid-minimal little helper for small local models.
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

// the command you actually typed: `j` when installed (the wrapper exports
// JERRITO_PROG), else the file name, so `node jerrito.mjs` still says "jerrito"
const PROG = (process.env.JERRITO_PROG || path.basename(process.argv[1] || 'j')).replace(/\.m?js$/, '');

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
// like num, but 0 is a real answer (`JERRITO_IDLE=0` means "never sleep")
const num0 = (v, d) => (String(v ?? '').trim() !== '' && Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : d);
const ENV_BASE = process.env.JERRITO_BASE_URL || process.env.OPENAI_BASE_URL || '';

let CFG = {
    base: (ENV_BASE || 'http://127.0.0.1:9931/v1').replace(/\/+$/, ''),
    baseExplicit: Boolean(ENV_BASE),          // user pointed us at a server: never spawn
    model: process.env.JERRITO_MODEL || '',
    modelFile: process.env.JERRITO_MODEL_FILE || '',
    key: process.env.JERRITO_API_KEY || process.env.OPENAI_API_KEY || 'none',
    temp: num(process.env.JERRITO_TEMP, 0.2),
    maxTokens: num(process.env.JERRITO_MAX_TOKENS, 4096),
    stats: process.env.JERRITO_STATS === '1',
    steps: num(process.env.JERRITO_STEPS, 20),
    chars: num(process.env.JERRITO_MAX_CHARS, 24000),   // history budget (chars)
    maxResults: num(process.env.JERRITO_SEARCH_RESULTS, 6),
    fetchChars: num(process.env.JERRITO_FETCH_CHARS, 6000),
    readLines: num(process.env.JERRITO_READ_LINES, 250),
    parallel: num(process.env.JERRITO_PARALLEL, 5),   // tool calls run at once, per batch
};
if (!/\/v\d+$/.test(CFG.base)) CFG.base += '/v1';

// optional sampler overrides; only sent when set, so servers/APIs that reject
// extra fields are unaffected
const SAMPLING = {};
for (const [env, key] of [['JERRITO_TOP_P', 'top_p'], ['JERRITO_TOP_K', 'top_k'],
['JERRITO_MIN_P', 'min_p'], ['JERRITO_REPEAT_PENALTY', 'repeat_penalty']]) {
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
    // a racing search aborts the losers, so keep both the per-request timeout
    // and the caller's signal (AbortSignal.any is missing on very old node)
    const limit = AbortSignal.timeout(opts.timeout || 20000);
    const signal = opts.signal
        ? (AbortSignal.any ? AbortSignal.any([limit, opts.signal]) : opts.signal)
        : limit;
    const res = await fetch(url, {
        method: opts.method || 'GET',
        body: opts.body,
        redirect: 'follow',
        signal,
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
// A search must cost one provider's latency, not the sum of every fallback. So
// providers race in waves and the first non-empty answer wins; the losers are
// aborted. A slow or dead instance is a loser instead of a 6 s delay.
const SEARCH_TIMEOUT = num(process.env.JERRITO_SEARCH_TIMEOUT, 3500);   // direct scrapers: DDG, Brave, SearXNG
const FOURGET_TIMEOUT = num(process.env.JERRITO_4GET_TIMEOUT, 4000);    // 4get instances scrape on their own side
// how long the proxied sources get on their own before the direct scrapers
// join the race: keeps the fast path cheap (no DDG/Brave traffic when 4get
// answers in half a second) without paying for a slow instance
const SEARCH_HEDGE = num0(process.env.JERRITO_SEARCH_HEDGE, 600);

const sleep = (ms, signal) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** a task that only starts once the faster sources have been quiet for `ms` */
const hedged = (ms, fn) => async (signal) => {
    await sleep(ms, signal);
    return signal?.aborted ? null : fn(signal);
};

/** resolve with the first non-null answer; null once every promise settles empty */
const firstNonNull = (promises) => new Promise((resolve) => {
    let left = promises.length;
    if (!left) return resolve(null);
    for (const p of promises) {
        p.then((v) => { if (v != null) resolve(v); })
            .catch(() => { })
            .finally(() => { if (--left === 0) resolve(null); });
    }
});

function cleanUrl(href) {
    let u = decodeEntities(href).trim();
    if (/\/l\/\?|\/l\/&/.test(u) || /duckduckgo\.com\/l/.test(u)) {
        const m = u.match(/[?&]uddg=([^&]+)/);
        if (m) { try { u = decodeURIComponent(m[1]); } catch { } }
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

async function searchDDG(query, signal) {
    const body = new URLSearchParams({ q: query, kl: 'wt-wt' });
    const res = await httpFetch('https://lite.duckduckgo.com/lite/', {
        method: 'POST', body, signal, timeout: SEARCH_TIMEOUT,
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

async function searchDDGHtml(query, signal) {
    const res = await httpFetch('https://html.duckduckgo.com/html/', {
        method: 'POST', body: new URLSearchParams({ q: query }), signal, timeout: SEARCH_TIMEOUT,
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

async function searchBrave(query, signal) {
    const res = await httpFetch('https://search.brave.com/search?q=' + encodeURIComponent(query), {
        signal, timeout: SEARCH_TIMEOUT,
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

const searxBase = () => (process.env.JERRITO_SEARX_URL || readConfig().searx || '').replace(/\/+$/, '');

/**
 * Bing has a second front end: `&format=rss` returns the same web results as
 * XML. No JavaScript, no bot wall, ~340 ms measured — by far the fastest direct
 * provider. It does throttle (an empty feed, not an error), and the RSS is
 * documented for personal/non-commercial aggregator use, which is what this is.
 */
async function searchBing(query, signal) {
    const res = await httpFetch('https://www.bing.com/search?q=' + encodeURIComponent(query)
        + '&format=rss&mkt=en-US&setlang=en', {
        signal, timeout: SEARCH_TIMEOUT,
        headers: { accept: 'application/rss+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.5' },
    });
    if (res.status === 429) throw new Error('rate-limited (HTTP 429)');
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);

    // items are XML; fields may carry entities (a description can even hold &lt;b&gt;)
    const field = (block, tag) => {
        const raw = (block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [])[1] || '';
        return stripTags(decodeEntities(raw)).replace(/\s+/g, ' ').trim();
    };
    const rows = [];
    for (const m of res.text.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const title = field(m[1], 'title');
        const url = field(m[1], 'link') || (m[1].match(/<link>\s*([^<\s]+)/) || [])[1] || '';
        if (title && /^https?:\/\//i.test(url)) rows.push({ title, url, desc: field(m[1], 'description') });
    }
    // an empty feed is Bing declining to answer (throttling), not "no results"
    if (!rows.length) throw new Error('empty feed (throttled)');
    return rows;
}

// 4get (https://4get.ca) is a search proxy: it scrapes from *its* IP, so it keeps
// working when our own IP is rate-limited. Public instances come and go, so try
// the configured list and remember the one that answered.
const DEFAULT_4GET = ['https://4get.ca', 'https://search.m0e.space'];
const instancesFile = () => path.join(CACHE_DIR, '4get-instances.json'); // CACHE_DIR is declared later
const INSTANCES_TTL = 7 * 24 * 3600 * 1000;    // refresh weekly
const INSTANCES_MAX_TRY = 4;                    // per search, raced in parallel; keeps a dead list bounded
const INSTANCES_PER_ENGINE = ['ddg', 'yandex'];
let fourgetGood = '';
let fourgetDead = false;
const fourgetBad = new Set();                   // dead this session

const trimBase = (u) => String(u).trim().replace(/\/+$/, '');
const offValue = (v) => /^(off|0|none|false|no)$/i.test(String(v ?? '').trim());

/** explicit instance list (env or config) wins over the auto-updated one */
function explicitFourgetBases() {
    const v = process.env.JERRITO_4GET_URL ?? readConfig().fourget;
    if (v === undefined || v === null || String(v).trim() === '') return null;
    if (offValue(v)) return [];
    return String(v).split(',').map(trimBase).filter(Boolean);
}

/** where the community list comes from: the 4get repo's INSTANCES array,
 *  which is what every instance's /instances page renders */
function fourgetFinder() {
    const v = process.env.JERRITO_4GET_FINDER ?? readConfig().fourgetFinder;
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
        try { found = JSON.parse(res.text); } catch { }
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
    // advance by the number of instances we ask, but always by at least one: with
    // a short list (2-4 instances) a plain INSTANCES_MAX_TRY would land back on
    // the same start every time and the rotation would be a no-op
    const step = Math.max(1, Math.min(INSTANCES_MAX_TRY, list.length - 1));
    // only move the cursor: the cached instance list itself must survive sessions
    writeJson(instancesFile(), { ...(cache || {}), cursor: (start + step) % Math.max(1, list.length) });
    return ordered;
}

async function search4get(query, signal) {
    if (fourgetDead) throw new Error('not configured');
    const explicit = explicitFourgetBases();
    if (explicit && !explicit.length) throw new Error('not configured');
    const notes = [];
    let sawJson = false;
    // remember the instance that worked, across runs too
    const preferred = fourgetGood || readJson(instancesFile())?.lastGood || '';

    /** one instance: ddg, then yandex if that engine is blocked upstream */
    const askInstance = async (base) => {
        for (const scraper of INSTANCES_PER_ENGINE) {
            let res;
            try {
                res = await httpFetch(`${base}/api/v1/web?s=${encodeURIComponent(query)}&scraper=${scraper}`, {
                    timeout: FOURGET_TIMEOUT, headers: { accept: 'application/json' }, signal,
                });
            } catch (e) {
                if (signal?.aborted) return null;      // another provider won: not this instance's fault
                notes.push(`${hostOf(base)}: ${fetchErr(e)}`); fourgetBad.add(base); return null;
            }
            if (signal?.aborted) return null;
            if (/not a bot|anubis|verifying your browser/i.test(res.text)) {
                notes.push(`${hostOf(base)}: bot check`); fourgetBad.add(base); return null;
            }
            if (res.status === 429 || res.status >= 500) {
                notes.push(`${hostOf(base)}: HTTP ${res.status}`); fourgetBad.add(base); return null;
            }
            if (res.status !== 200) { notes.push(`${hostOf(base)}: HTTP ${res.status}`); return null; }

            let j;
            try { j = JSON.parse(res.text); } catch { notes.push(`${hostOf(base)}: not JSON`); fourgetBad.add(base); return null; }
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
        return null;
    };

    // the instances are independent hosts: ask them at the same time and take
    // whichever answers first, instead of queueing three timeouts
    const tryBases = async (list) => {
        const usable = list.filter((b) => !fourgetBad.has(b));
        const ordered = preferred && usable.includes(preferred)
            ? [preferred, ...rotate(usable.filter((b) => b !== preferred))]
            : rotate(usable);
        return firstNonNull(ordered.slice(0, INSTANCES_MAX_TRY).map(askInstance));
    };

    let rows = await tryBases(explicit || await autoFourgetBases());
    if (!rows && !explicit && !signal?.aborted) {
        // every known instance failed: re-read the finder in case the list moved
        const again = await autoFourgetBases({ force: true });
        if (again.length) rows = await tryBases(again);
    }
    if (rows) return rows;
    if (signal?.aborted) return null;

    if (!sawJson) fourgetDead = true;                 // every instance unreachable
    throw new Error(notes.slice(0, 3).join('; ') || 'no results');
}

/** SearXNG: your own instance (public ones are usually behind bot checks) */
async function searchSearx(query, signal) {
    const base = searxBase();
    const res = await httpFetch(`${base}/search?q=${encodeURIComponent(query)}&format=json&language=en`, {
        signal, timeout: SEARCH_TIMEOUT, headers: { accept: 'application/json' },
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

const fmtRows = (rows) => rows.map((r, i) =>
    `${i + 1}) ${clip(r.title, 120)}\n   ${r.url}\n   ${clip(r.desc, 240)}`).join('\n');

/**
 * A provider can answer with a feed that has nothing to do with the query —
 * Bing's RSS does it now and then (localized "popular" hits), and a stale 4get
 * instance can return leftover junk. If not one row mentions a query word, the
 * whole answer is junk: drop it and let the race continue. Rows are kept whole,
 * never filtered one by one, so a result that merely phrases things differently
 * survives.
 */
const STOPWORDS = new Set(('the and for with what when where which who why how are was were ' +
    'this that these those from into about than then there their have has had not but all any ' +
    'can could should would does did doing you your yours our its use using used get got new ' +
    'latest newest old best more most less least how whats does').split(' '));
const queryTokens = (q) => [...new Set(String(q).toLowerCase().match(/[a-z0-9]{3,}/g) || [])]
    .filter((t) => !STOPWORDS.has(t));
function relevantRows(tokens, rows) {
    if (!tokens.length || !rows.length) return rows;
    const related = rows.some((r) => {
        const text = (r.title + ' ' + r.desc).toLowerCase();
        return tokens.some((t) => text.includes(t));
    });
    return related ? rows : [];
}

/**
 * Providers race in a wave; the first non-empty answer wins and the losers are
 * aborted. Waves rather than one big scrape: the proxied sources go first, the
 * direct scrapers hedge in behind them (see `hedged` in webSearch), so a working
 * search costs ~1 s and a broken one is bounded instead of 17 s.
 */
async function raceWave(tasks, notes, query = '') {
    const ac = new AbortController();
    const t0 = Date.now();
    const tokens = queryTokens(query);
    const won = await firstNonNull(tasks.map(([name, fn]) => fn(ac.signal)
        .then((r) => {
            const rows = relevantRows(tokens, dedupe(r || [])).slice(0, CFG.maxResults);
            if (!rows.length) { notes.push(name + ': no results'); return null; }
            ac.abort();                                   // everyone else: stop
            // JERRITO_STATS=1 says who answered, which matters when judging results
            if (CFG.stats) process.stderr.write(dim(`[search via ${name} · ${Date.now() - t0}ms · ${rows.length} rows]\n`));
            return { name, rows };
        })
        .catch((e) => {
            if (ac.signal.aborted) return null;           // aborted because another provider won
            notes.push(name + ': ' + String(fetchErr(e)).slice(0, 80));
            return null;
        })));
    return won?.rows || null;
}

async function webSearch(query) {
    const fourgetOff = offValue(process.env.JERRITO_4GET_URL ?? readConfig().fourget);
    const bingOff = offValue(process.env.JERRITO_BING ?? readConfig().bing);
    const notes = [];

    // wave 1: 4get (scrapes from its own IP) and SearXNG (yours) race each
    // other. Bing's RSS front end and duckduckgo lite hedge in behind them: both
    // are direct scrapes of our own IP, so they only start when the proxied
    // sources are slow — that keeps 4get's better results when it is healthy and
    // still bounds the search when it is not.
    const wave1 = [];
    if (searxBase()) wave1.push(['searxng', (sig) => searchSearx(query, sig)]);
    if (!fourgetOff) wave1.push(['4get', (sig) => search4get(query, sig)]);
    if (!bingOff) wave1.push(['bing', hedged(SEARCH_HEDGE, (sig) => searchBing(query, sig))]);
    // nothing to hedge against (4get and bing both off): start duckduckgo now
    wave1.push(['duckduckgo lite', hedged(wave1.length ? SEARCH_HEDGE : 0, (sig) => searchDDG(query, sig))]);
    let rows = await raceWave(wave1, notes, query);

    // wave 2: the remaining scrapers, only when wave 1 came back empty
    if (!rows) {
        rows = await raceWave([
            ['duckduckgo html', (sig) => searchDDGHtml(query, sig)],
            ['brave', (sig) => searchBrave(query, sig)],
        ], notes, query);
    }

    if (rows) return fmtRows(rows);
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

const SKIP = new Set(['.git', 'node_modules', 'target', '.direnv', 'result', '__pycache__', '.venv', 'dist', 'build', '.pi', '.cache', 'vendor', 'coverage', '.next']);

/** files under `abs`, depth-first, skipping the usual junk dirs */
function* walkFiles(abs, max = 5000) {
    const st = statSync(abs);
    if (st.isFile()) { yield abs; return; }
    const stack = [abs];
    let n = 0;
    while (stack.length && n < max) {
        const dir = stack.pop();
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (SKIP.has(e.name)) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) stack.push(p);
            else if (e.isFile()) { n++; yield p; if (n >= max) return; }
        }
    }
}

/** a filename glob ("*.nix", "docs/**\u002F*.md") -> RegExp, matched against the rel path */
function globToRe(glob) {
    if (!glob) return null;
    const raw = String(glob).trim().replace(/^\.\//, '');
    if (!raw) return null;
    let src = '';
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '*' && raw[i + 1] === '*') { src += '.*'; i++; if (raw[i + 1] === '/') i++; }
        else if (c === '*') src += '[^/]*';
        else if (c === '?') src += '[^/]';
        else src += /[.+^${}()|[\]\\]/.test(c) ? '\\' + c : c;
    }
    return new RegExp('^' + src + '$', 'i');
}

/** `path:line: text`, ripgrep-shaped, capped short so a small model can act on it */
function grepTool(pattern, relPath, glob) {
    const pat = String(pattern ?? '').trim();
    if (!pat) return 'grep needs a "pattern" argument.';
    let re = null;
    try { re = new RegExp(pat, 'i'); } catch { re = null; }   // bad regex: fall back to text
    const hit = re ? (s) => re.test(s) : (s) => s.toLowerCase().includes(pat.toLowerCase());

    const start = resolveIn(relPath || '.');
    const g = globToRe(glob);
    const globOnBasename = Boolean(glob) && !String(glob).includes('/');
    const MAX = 60;
    const out = [];
    let searched = 0, filesHit = 0, cut = false;

    for (const file of walkFiles(start)) {
        const rel = path.relative(ROOT, file) || file;
        if (g && !g.test(rel) && !(globOnBasename && g.test(path.basename(file)))) continue;
        let buf;
        try {
            if (statSync(file).size > 1_500_000) continue;
            buf = readFileSync(file);
        } catch { continue; }
        if (buf.subarray(0, 4096).includes(0)) continue;        // binary
        searched++;
        let any = false;
        const all = buf.toString('utf8').split('\n');
        for (let i = 0; i < all.length; i++) {
            const line = all[i];
            if (line.length > 300 || !hit(line)) continue;
            any = true;
            if (out.length < MAX) out.push(`${rel}:${i + 1}: ${clip(line.trim(), 160)}`);
            else { cut = true; break; }
        }
        if (any) filesHit++;
        if (cut) break;
    }

    const where = `${glob ? glob + ' ' : ''}under ${path.relative(ROOT, start) || '.'}`;
    if (!out.length) return `no match for ${JSON.stringify(pat)} ${where} (${searched} files searched)`;
    return `${out.length}${cut ? '+' : ''} match${out.length === 1 ? '' : 'es'} for ${JSON.stringify(pat)} in ${filesHit} file${filesHit === 1 ? '' : 's'} ${where}\n` + out.join('\n');
}

/** man page -> plain text, capped. No shell: page/section are separate exec
 *  args, rejected if they look like options. Best-effort suggestions via
 *  `man -k` when there is no entry; honest no-entry message otherwise. */
function manTool(page, section) {
    const p = String(page ?? '').trim();
    const sec = String(section ?? '').trim();
    if (!p || p.startsWith('-') || !/^[\w.:+-]+$/.test(p)) return 'man needs a page name (e.g. "chmod", "systemd.unit").';
    if (sec && !/^[0-9a-z+]+$/i.test(sec)) return `invalid section "${clip(sec, 20)}" — use a number like 1 or 5.`;
    const argv = sec ? ['-s', sec, p] : [p];
    const env = { ...process.env, MANWIDTH: '100', MANPAGER: 'cat', PAGER: 'cat' };
    let text = '';
    try {
        text = execFileSync('man', argv, { encoding: 'utf8', timeout: 8000, env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
        text = e.stdout || '';
        if (!text.trim()) {
            // exit 16 = no manual entry; ask `man -k` for near names (best effort)
            let near = '';
            try {
                near = execFileSync('man', ['-k', p], { encoding: 'utf8', timeout: 5000, env, stdio: ['ignore', 'pipe', 'ignore'] });
            } catch { }
            const lines = near.split('\n').filter(Boolean).slice(0, 6);
            return `no manual entry for ${JSON.stringify(p)}${lines.length ? '. Closest matches:\n' + lines.join('\n') : ''}`;
        }
    }
    // strip groff backspace-overstrikes and SGR escapes; collapse blank runs
    const clean = text.replace(/\x1b\[[0-9;]*m/g, '').replace(/.\x08/g, '').replace(/\n{3,}/g, '\n\n');
    const cap = Math.min(8000, Math.max(2000, Math.floor(CFG.chars / 2)));
    if (clean.length > cap) {
        const cut = clean.lastIndexOf('\n', cap);
        return clean.slice(0, cut > 0 ? cut : cap) + `\n[…page truncated — ${clean.length - cap} more chars; ask for a section]`;
    }
    return clean;
}

/** true if `cmd` is runnable (like `command -v`), cached per name */
const _cmdCache = new Map();
function commandExists(cmd) {
    if (_cmdCache.has(cmd)) return _cmdCache.get(cmd);
    let ok = false;
    try { execFileSync(cmd, ['--version'], { timeout: 4000, stdio: 'ignore' }); ok = true; } catch { ok = false; }
    _cmdCache.set(cmd, ok);
    return ok;
}

/** format outline rows (tab-separated line\tkind\tname) within a char cap */
function fmtOutlineRows(rows, width, cap) {
    const lines = [];
    let bytes = 0;
    for (const r of rows) {
        const [num, kind, rest] = r.split('\t');
        const line = `${String(num).padStart(width)}  ${kind.padEnd(10)}${rest.length > 90 ? rest.slice(0, 89) + '…' : rest}`;
        if (bytes + line.length + 1 > cap) break;
        lines.push(line); bytes += line.length + 1;
    }
    return lines.join('\n') + (lines.length < rows.length ? `\n[…${rows.length - lines.length} more symbols]` : '');
}

/** conservative no-dependency outline: declarations we can see with plain
 *  regexes. Coarser than ctags (no signatures), but it cannot stall mid-file,
 *  which the ctags JavaScript parser demonstrably can on regex-heavy code. */
function heuristicOutline(all) {
    const rows = [];
    for (let i = 0; i < all.length && rows.length < 400; i++) {
        const line = all[i];
        let m, kind = null, name = null;
        if ((m = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line))) { kind = 'function'; name = m[1]; }
        else if ((m = /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line))) { kind = 'class'; name = m[1]; }
        else if ((m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function|\([^;=]*\)\s*=>)/.exec(line))) { kind = 'function'; name = m[1]; }
        else if ((m = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line))) { kind = 'constant'; name = m[1]; }
        else if ((m = /^\s*(?:def|fn|func|sub|async\s+def)\s+([A-Za-z_$][\w$]*)/.exec(line))) { kind = 'def'; name = m[1]; }
        else if ((m = /^\s+([A-Za-z_$][\w$]*)\s*\([^;()]*\)\s*\{\s*$/.exec(line)) && !/^(if|for|while|switch|catch|function|return)$/.test(m[1])) { kind = 'method'; name = m[1]; }
        if (name) rows.push(`${i + 1}\t${kind}\t${name}`);
    }
    return rows;
}

/** symbol index for one file: universal-ctags for code (line, kind, name,
 *  signature), our own heading walker for Markdown (fence-safe). Falls back
 *  to heuristicOutline when ctags is missing, has no parser for the language
 *  or visibly stalled (last symbol far above EOF) — and must never look like
 *  a failed read of the file itself. */
function outlineTool(abs, rel, all) {
    const total = all.length;
    const cap = Math.min(8000, Math.max(2000, Math.floor(CFG.chars / 2)));
    let rows = [];
    let approx = false;

    if (/\.m(ark)?d(own)?$/i.test(rel)) {
        // markdown: headings outside fenced code blocks
        let fence = null;
        for (let i = 0; i < total && rows.length < 400; i++) {
            const line = all[i];
            const fm = /^(\s*)(`{3,}|~{3,})/.exec(line);
            if (fm) { if (!fence) fence = fm[2]; else if (fm[2].startsWith(fence)) fence = null; continue; }
            if (fence) continue;
            const h = /^(#{1,6})\s+(.*\S)\s*#*\s*$/.exec(line);
            if (h) rows.push(`${i + 1}\t${'h' + h[1].length}\t${h[2].trim()}`);
        }
    } else {
        if (commandExists('ctags')) {
            let out = '';
            try {
                // no shell, path as one arg; -x is the plain listing, tab-separated
                // via --_xformat; -u keeps source order instead of name sort
                out = execFileSync('ctags', ['-x', '-u', '--_xformat=%N\t%K\t%n\t%S', abs],
                    { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
            } catch { out = ''; }
            const NOISE = new Set(['property', 'field', 'member', 'label', 'enumerator', 'section']);
            for (const ln of out.split('\n')) {
                const [name, kindRaw, num, sig] = ln.split('\t');
                const kind = String(kindRaw || '').toLowerCase();
                if (!name || !kind || !/^\d+$/.test(num || '')) continue;
                if (NOISE.has(kind) || /^(ANONYMOUS|_)/.test(name)) continue;
                if (rows.length >= 400) break;
                const s = (sig || '').trim();
                rows.push(`${num}\t${kind}\t${name}${s && s !== '()' && s !== '-' ? ' ' + s : ''}`);
            }
            // a parser that stopped far above EOF (the JS one stalls on some
            // regex-heavy files) is worse than our heuristic: replace it
            const last = rows.length ? +rows[rows.length - 1].split('\t')[0] : 0;
            approx = rows.length === 0 || last < all.length - 5;
            if (approx) rows.length = 0;
        } else approx = true;
        if (approx) rows.push(...heuristicOutline(all));
    }

    if (!rows.length) return `outline ${rel}: no symbols found (${total} lines) — read it directly instead.`;
    const width = String(Math.max(...rows.map((r) => +r.split('\t')[0]))).length;
    if (approx) return `outline ${rel} (${total} lines, approximate — ctags could not parse it)\n` + fmtOutlineRows(rows, width, cap);
    return `outline ${rel} (${total} lines, ${rows.length} symbol${rows.length === 1 ? '' : 's'})\n` + fmtOutlineRows(rows, width, cap);
}

function readTool(rel, offset, limit, outline) {
    const abs = resolveIn(rel);
    const st = statSync(abs);

    if (st.isDirectory()) {
        const entries = readdirSync(abs, { withFileTypes: true })
            .filter((e) => !SKIP.has(e.name))
            .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        const lines = entries.slice(0, 200).map((e) => {
            if (e.isDirectory()) return e.name + '/';
            let size = '';
            try { size = '  ' + humanSize(statSync(path.join(abs, e.name)).size); } catch { }
            return e.name + size;
        });
        return `dir ${path.relative(ROOT, abs) || '.'} (${entries.length} entries)\n` + lines.join('\n');
    }

    if (st.size > 2_000_000) return `File too large (${(st.size / 1e6).toFixed(1)} MB). Use offset/limit on a smaller file.`;
    const buf = readFileSync(abs);
    if (buf.subarray(0, 4096).includes(0)) return 'Binary file, not readable as text.';
    const all = buf.toString('utf8').split('\n');

    if (outline) return outlineTool(abs, path.relative(ROOT, abs) || rel, all);

    // a 2 B model will page a 2700-line file in 250-line chunks even when told
    // not to, so a whole-file read of a big file gets the symbol index instead
    // of the body — it cannot pay for what it is not given
    const BIG = Math.max(CFG.readLines, 250) + 20;
    if (!Number(offset) && all.length > BIG) {
        return outlineTool(abs, path.relative(ROOT, abs) || rel, all)
            + `\n[body withheld: this file has ${all.length} lines — read the range you need with offset/limit]`;
    }
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
            description: 'Read a file, or list a directory, inside the current project. Use this for every question about local files or code. For a file you have not seen, call with outline:true FIRST: you get a symbol/section index with line numbers instead of the body, then read only the range you need with offset/limit.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'path relative to project root' },
                    offset: { type: 'integer', description: 'first line, 1-based' },
                    limit: { type: 'integer', description: 'max lines (default 250)' },
                    outline: { type: 'boolean', description: 'return a symbol index (functions, classes, Markdown headings — each with its line number) instead of the file body. Cheap way to see a file\'s structure before reading a range.' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'grep',
            description: 'Search inside project files and return matching lines as path:line: text. Use this FIRST to find where something lives, then read only that range. The pattern is a regex; use | for alternatives.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'text or regex, e.g. "screens|widths"' },
                    path: { type: 'string', description: 'file or directory to search (default: project root)' },
                    glob: { type: 'string', description: 'only files matching this, e.g. "*.nix"' },
                },
                required: ['pattern'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'man',
            description: 'Read a manual page installed on this system (flags, behavior, exit codes). Use it for command specifics instead of guessing; if there is no entry, fall back to your knowledge or web_search.',
            parameters: {
                type: 'object',
                properties: {
                    page: { type: 'string', description: 'manual page name, e.g. "chmod"' },
                    section: { type: 'string', description: 'optional section number, e.g. "1" or "5"' },
                },
                required: ['page'],
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
            description: 'Download a URL and return its main text. Use it after web_search to read a promising result.',
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
        case 'read': return { text: readTool(String(args.path ?? '.'), args.offset, args.limit, Boolean(args.outline)), hint: args.path };
        case 'grep': return { text: grepTool(args.pattern, args.path, args.glob), hint: args.pattern };
        case 'man': return { text: manTool(args.page, args.section), hint: args.page };
        default: return { text: `Unknown tool "${name}". Available: read, grep, man, web_search, web_fetch.`, hint: name };
    }
}

/** the first JSON value at the start of `s` (balanced braces, strings respected) */
function jsonPrefix(s) {
    let depth = 0, inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') { depth--; if (depth === 0) return s.slice(0, i + 1); }
    }
    return null;
}

/** a call a model wrote as text, at the very start of `s`: { call, rest } or null */
function takeCall(s, known) {
    const obj = (raw) => {
        const v = String(raw || '').trim().replace(/^```[a-z]*\n?|\n?```$/gi, '');
        try { const j = JSON.parse(v); return j && typeof j === 'object' ? j : null; } catch { return null; }
    };
    const asArgs = (v) => {
        const args = typeof v === 'string' ? obj(v) : v;
        return args && typeof args === 'object' ? args : null;
    };

    // 1. <function name="read"> <param name="path">x</param> </function>
    let m = /^<function\s+name=["']?([\w.:-]+)["']?\s*>([\s\S]*?)<\/function>/i.exec(s);
    if (m && known.has(m[1])) {
        const args = {};
        const re = /<param\s+name=["']?([\w.:-]+)["']?\s*>([\s\S]*?)<\/param>/gi;
        let p;
        while ((p = re.exec(m[2]))) args[p[1]] = /^\s*-?\d+\s*$/.test(p[2]) ? Number(p[2]) : p[2].trim();
        const inline = obj(m[2]);
        if (inline) Object.assign(args, inline);
        if (Object.keys(args).length) return { call: { name: m[1], args }, rest: s.slice(m[0].length) };
    }

    // 2. <function=read>{"path":"x"}</function>  (closing tag optional)
    m = /^<function=([\w.:-]+)\s*>?\s*(\{[\s\S]*?\})\s*(?:<\/function>)?/i.exec(s);
    if (m && known.has(m[1])) {
        const args = asArgs(m[2]);
        if (args) return { call: { name: m[1], args }, rest: s.slice(m[0].length) };
    }

    // 3. a bare {"name": "read", "arguments": {...}}
    if (s.startsWith('{')) {
        const prefix = jsonPrefix(s);
        const j = prefix && obj(prefix);
        if (j && known.has(j.name)) {
            const args = asArgs(j.arguments);
            if (args) return { call: { name: j.name, args }, rest: s.slice(prefix.length) };
        }
    }
    return null;
}

/** A call a model wrote as text instead of in tool_calls:
 *    <function name="read"><param name="path">a.md</param></function>
 *    <function=read>{"path":"a.md"}</function>
 *    {"name":"read","arguments":{"path":"a.md"}}
 *  Returns ALL of them, in order, so a model that writes two searches in one
 *  breath still gets them executed together. Prose that merely mentions a call
 *  parses as nothing: a call must start at the beginning of the text. */
function parseTextCalls(text) {
    let s = String(text || '').trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
    if (!s) return [];
    const known = new Set(TOOLS.map((t) => t.function.name));
    const obj = (raw) => {
        try { const j = JSON.parse(String(raw || '').trim()); return j && typeof j === 'object' ? j : null; } catch { return null; }
    };
    const asArgs = (v) => {
        const args = typeof v === 'string' ? obj(v) : v;
        return args && typeof args === 'object' ? args : null;
    };
    const normalize = (j) => {
        if (!j || !known.has(j.name)) return null;
        const args = asArgs(j.arguments ?? j.args ?? j.parameters);
        return args ? { name: j.name, args } : null;
    };

    // a JSON array of calls
    if (s.startsWith('[')) {
        const prefix = jsonPrefix(s);
        const arr = prefix && obj(prefix);
        const calls = Array.isArray(arr) ? arr.map(normalize) : [];
        if (calls.length && calls.every(Boolean) && !s.slice(prefix.length).trim()) return calls;
    }

    const calls = [];
    for (let guard = 0; guard < 10; guard++) {
        s = s.replace(/^[\s,;]*(?:and|then)\b[\s,;]*/i, '').replace(/^[\s,;]+/, '');
        if (!s) break;
        const took = takeCall(s, known);
        if (!took) break;                     // not a call any more: stop here
        calls.push(took.call);
        s = took.rest;
    }
    return calls;
}

const asCall = ({ name, args }) => ({
    id: `textcall_${Math.random().toString(36).slice(2, 10)}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args || {}) },
});

// ------------------------------------------------- model provisioning ----
// `jerrito "question"` should not require a hand-started llama-server: find the
// binary, pick or fetch a model, start it detached, and reuse it next time.
const HOME = os.homedir();
const CACHE_DIR = path.join(HOME, '.cache/jerrito');
const MODELS_DIR = path.join(CACHE_DIR, 'models');
const STATE_FILE = path.join(CACHE_DIR, 'server.json');
const LOG_FILE = path.join(CACHE_DIR, 'llama-server.log');
const WATCH_LOG = path.join(CACHE_DIR, 'watchdog.log');
const CONFIG_FILE = path.join(HOME, '.config/jerrito/config.json');
const LOCK_FILE = path.join(CACHE_DIR, 'server.lock');

// one-time migration from the pre-rename name (~/.cache/helper): move the
// 1.5 GB model and server state instead of re-downloading. best-effort — an
// old server keeps running either way; `jerrito --stop` then restarts it
function migrateFromHelper() {
    for (const [from, to] of [
        [path.join(HOME, '.cache/helper'), CACHE_DIR],
        [path.join(HOME, '.config/helper'), path.dirname(CONFIG_FILE)],
    ]) {
        try {
            if (!existsSync(from) || existsSync(to)) continue;
            mkdirSync(path.dirname(to), { recursive: true });
            renameSync(from, to);
        } catch { }
    }
}
migrateFromHelper();

const RECOMMENDED = {
    name: 'Sharp-MiniCPM5-2B-Q4_K_S.gguf',
    url: 'https://huggingface.co/peculiar-ragdoll/Sharp-MiniCPM5-2B-GGUF/resolve/main/Sharp-MiniCPM5-2B-Q4_K_S.gguf',
    bytes: 1516390912,
    args: ['--jinja'],
    sampling: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0 },
};

const isExec = (p) => { try { const s = statSync(p); return s.isFile() && (s.mode & 0o100) !== 0; } catch { return false; } };
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => { try { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 1)); } catch { } };
const readConfig = () => readJson(CONFIG_FILE) || {};
const readState = () => readJson(STATE_FILE);
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function findServerBinary() {
    const cfg = readConfig();
    const dirs = [
        process.env.JERRITO_BIN_DIR, cfg.binDir,
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
        cfg.modelsDir, process.env.JERRITO_MODEL_DIR,
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
                } catch { }
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
    if (size > 12e9) s -= 4;           // big for a laptop model
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
        throw new Error(`could not fetch a model (${e.message}). Put a .gguf somewhere under ~/models, or set JERRITO_MODEL_FILE=/path/to.gguf`);
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
    if (p.temperature != null && !process.env.JERRITO_TEMP) CFG.temp = p.temperature;
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

function serverArgs(model, port, withJinja, caps = {}) {
    const cfg = readConfig();
    // 16k default: MiniCPM's chat template renders the tool definitions inline,
    // which costs ~7k tokens before a single word of the question
    const ctx = num(process.env.JERRITO_CTX, num(cfg.context, 16384));
    const threads = num(cfg.threads, Math.max(2, Math.min(12, os.cpus().length - 1)));
    // GPU layers: llama.cpp offloads what it can; -ngl 0 forces CPU, and a
    // CPU-only build ignores the flag. Env wins over config wins over default.
    const envNgl = process.env.JERRITO_NGL;
    const ngl = envNgl !== undefined && envNgl !== '' ? Number(envNgl)
        : cfg.gpuLayers !== undefined ? Number(cfg.gpuLayers) : 99;
    const extra = cfg.serverArgs || [];
    // idle -> sleep: the weights leave VRAM and the next request wakes the
    // server (measured ~0.7 s). only llama.cpp builds new enough to know the
    // flag get it — an unknown argument makes the server refuse to start
    const idle = caps.sleepIdle ? idleSeconds() : 0;
    return ['-m', model, '-c', String(ctx), '-t', String(threads), '-np', '1',
        '-ngl', String(Number.isFinite(ngl) ? ngl : 99),
        '--host', '127.0.0.1', '--port', String(port),
        ...(withJinja ? ['--jinja'] : []),
        ...(idle > 0 ? ['--sleep-idle-seconds', String(idle)] : []),
        ...extra];
}

/** what this llama-server build understands (flags come and go between builds) */
function serverCaps(bin) {
    let help = '';
    try {
        help = execFileSync(bin, ['--help'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { }
    return { sleepIdle: /--sleep-idle-seconds/.test(help) };
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

// --------------------------------------------- idle + vram watchdog --------
// A detached model server nobody asks anything is a leak: ~2 GB of VRAM on a
// laptop, held forever. Two guards, both cheap:
//   1. llama.cpp's own --sleep-idle-seconds (see serverArgs): after N idle
//      seconds the weights leave VRAM, the next request wakes it in under a
//      second. No process of ours involved, so it also holds if jerrito never
//      runs again.
//   2. a detached watchdog (below) that SIGTERMs the server when the GPU comes
//      under pressure from something else — a game cannot wait for a 5 minute
//      idle timer, and sleeping still keeps the process.
// Both are opt-out, and both are invisible unless something happens.
const cfgNum = (envName, cfgKey, def) => {
    const v = process.env[envName] !== undefined ? process.env[envName] : readConfig()[cfgKey];
    return num0(v, def);
};

/** seconds of idleness before the server sleeps (0 = keep it hot) */
const idleSeconds = () => cfgNum('JERRITO_IDLE', 'idleSeconds', 300);
/** free VRAM under this means somebody else needs the card (MB) */
const vramFloorMb = () => cfgNum('JERRITO_VRAM_FLOOR', 'vramFloor', 700);
/** how long the server must be quiet before the watchdog acts (seconds) */
const pressureGraceSec = () => cfgNum('JERRITO_VRAM_GRACE', 'vramGrace', 60);

const mib = (v) => Math.round(Number(v) * 2 ** 20);
const readInt = (f) => { try { const n = Number(readFileSync(f, 'utf8').trim()); return Number.isFinite(n) ? n : null; } catch { return null; } };

/**
 * `nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits` prints one
 * number per GPU, newline-terminated. Parsing that with `Number('')` gives 0 for
 * the trailing empty line, and `Math.min` then says "no free VRAM" forever — so
 * blank entries are dropped, never coerced.
 */
function parseSmFreeMiB(out) {
    const vals = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        .map(Number).filter((n) => Number.isFinite(n));
    return vals.length ? Math.min(...vals) : null;
}

/**
 * Free VRAM in bytes, or null when this machine gives us no way to know.
 * nvidia-smi covers NVIDIA, /sys covers amdgpu, and JERRITO_VRAM_FREE_MB is a
 * static reading (tests, or a driver we cannot query).
 */
function vramFreeBytes() {
    const forced = process.env.JERRITO_VRAM_FREE_MB;
    if (forced !== undefined && forced !== '' && Number.isFinite(Number(forced))) return mib(forced);
    try {
        const out = execFileSync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
            { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
        const free = parseSmFreeMiB(out);
        if (free !== null) return mib(free);           // the tightest GPU is the interesting one
    } catch { }
    let free = null;
    try {
        for (const card of readdirSync('/sys/class/drm')) {
            if (!/^card\d+$/.test(card)) continue;
            const dir = path.join('/sys/class/drm', card, 'device');
            const total = readInt(path.join(dir, 'mem_info_vram_total'));
            const used = readInt(path.join(dir, 'mem_info_vram_used'));
            // total 0 = an integrated GPU with no dedicated VRAM: it cannot be
            // "out of memory", and counting it would pin free VRAM at 0 forever
            if (!total || used === null) continue;
            free = free === null ? total - used : Math.min(free, total - used);
        }
    } catch { }
    return free;
}

/**
 * The whole decision, isolated so it can be tested without a GPU: never touch
 * a server that is working, never guess when VRAM is unreadable, and only act
 * once the server has been quiet long enough that no tool round is in flight.
 */
function underPressure({ freeBytes, floorBytes, idleMs, graceMs, processing = false }) {
    if (processing) return false;
    if (freeBytes === null || freeBytes === undefined) return false;
    if (!(freeBytes < floorBytes)) return false;
    return idleMs >= graceMs;
}

/** the server log is written on every request: its mtime is the last activity */
const lastActivityMs = () => { try { return statSync(LOG_FILE).mtimeMs; } catch { return 0; } };

/** is a generation running right now? (llama.cpp /slots; unknown = no) */
async function slotsProcessing(base) {
    if (!base) return false;
    try {
        const r = await fetch(base.replace(/\/v\d+\/?$/, '') + '/slots', { signal: AbortSignal.timeout(2000) });
        if (!r.ok) return false;
        const slots = await r.json();
        return Array.isArray(slots) && slots.some((s) => s && s.is_processing);
    } catch { return false; }
}

const procCmdline = (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { return ''; } };

/** pid reuse guard: /proc says what it is; no /proc (macOS) means trust the state file */
const isOurProcess = (pid, re) => {
    const cmd = procCmdline(pid);
    return cmd ? re.test(cmd) : true;
};

/** detached `jerrito --watch <pid> <base>`: kill the server when the GPU is needed */
async function watchdog(pid, base) {
    const note = (m) => process.stderr.write(`${new Date().toISOString()} ${m}\n`);
    if (!pid || !isAlive(pid)) return note(`pid ${pid} is not running — nothing to watch`);
    const floor = mib(vramFloorMb());
    const graceMs = pressureGraceSec() * 1000;
    note(`watching pid ${pid} ${base} · floor ${vramFloorMb()} MB free · quiet ${pressureGraceSec()}s`);
    while (isAlive(pid)) {
        await new Promise((r) => setTimeout(r, 5000));
        const st = readState();
        if (!st || Number(st.pid) !== Number(pid)) return note(`state now names another server — done`);
        const freeBytes = vramFreeBytes();
        const idleMs = Date.now() - lastActivityMs();
        // /slots is itself a request and would keep the server from ever going
        // to sleep, so the cheap checks come first and we only ask when a kill
        // is otherwise justified
        if (!underPressure({ freeBytes, floorBytes: floor, idleMs, graceMs })) continue;
        if (await slotsProcessing(base)) continue;
        if (!isOurProcess(pid, /llama-server/)) return note(`pid ${pid} is not llama-server any more — leaving it alone`);
        try { process.kill(pid, 'SIGTERM'); } catch { }
        const now = readState();
        if (now && Number(now.pid) === Number(pid)) { try { unlinkSync(STATE_FILE); } catch { } }
        return note(`killed llama-server (pid ${pid}): ${Math.round(freeBytes / 2 ** 20)} MB VRAM free, idle ${Math.round(idleMs / 1000)}s`);
    }
    note(`pid ${pid} is gone — done`);
}

/** start the watchdog; returns its pid, or null when there is nothing to watch */
function startWatchdog(pid, base) {
    if (process.env.JERRITO_NO_WATCHDOG === '1') return null;
    if (vramFreeBytes() === null) return null;          // no readable GPU: idle sleep is all we do
    try {
        mkdirSync(CACHE_DIR, { recursive: true });
        const fd = openSync(WATCH_LOG, 'a');
        try {
            const child = spawn(process.execPath, [SOURCE_FILE, '--watch', String(pid), base || ''],
                { detached: true, stdio: ['ignore', fd, fd] });
            child.unref();
            return child.pid;
        } finally { closeSync(fd); }
    } catch { return null; }
}

/** never kill a pid we did not start: only a `--watch` child of jerrito */
function stopWatchdog(pid) {
    if (!pid || !isAlive(pid)) return;
    if (!isOurProcess(pid, /--watch/)) return;
    try { process.kill(pid, 'SIGTERM'); } catch { }
}

/** a server started by an older jerrito (or with the watchdog off) gets one now */
function ensureWatchdog(pid, base) {
    const st = readState();
    if (!st || Number(st.pid) !== Number(pid) || !isAlive(pid)) return;
    if (st.watchPid && isAlive(st.watchPid)) return;
    const watchPid = startWatchdog(pid, base);
    if (watchPid) writeJson(STATE_FILE, { ...st, watchPid });
}

// one spawn at a time: two terminals starting `jerrito` together must not race
// on the model download or start two servers
function acquireLock() {
    try {
        mkdirSync(CACHE_DIR, { recursive: true });
        const fd = openSync(LOCK_FILE, 'wx');
        writeSync(fd, String(process.pid));
        closeSync(fd);
        // never leave a stale lock behind, even on ctrl-c
        process.once('exit', () => { try { unlinkSync(LOCK_FILE); } catch { } });
        return true;
    } catch { return false; }
}
const releaseLock = () => { try { unlinkSync(LOCK_FILE); } catch { } };
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

/** adopt the recorded server if it is up, and make sure something is watching it */
async function adoptExisting() {
    if (!(await adoptIfUp(readState()))) return false;
    const st = readState();
    if (st?.pid) ensureWatchdog(st.pid, st.base);
    return true;
}

/** wait for a server another jerrito is starting (or one that is already up) */
async function waitForServer(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (await adoptExisting()) return true;
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
    if (CFG.baseExplicit || process.env.JERRITO_NO_SPAWN === '1') {
        if (await healthy(CFG.base)) return;
        const why = CFG.baseExplicit ? 'JERRITO_BASE_URL is set' : 'JERRITO_NO_SPAWN=1';
        throw new Error(`no server answering at ${CFG.base} (${why}, so ${PROG} will not start one)`);
    }

    // 2. a server we started earlier is still warm: reuse it (alive pid wins)
    if (await adoptExisting()) return;

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
        // 4. start one (re-check: the other jerrito may have just finished)
        if (await adoptExisting()) return;

        const bin = findServerBinary();
        if (!bin) {
            throw new Error('llama-server not found on PATH.\n' +
                '  nix:      nix develop    (or `direnv allow` once, this repo has a flake)\n' +
                '  anywhere: install llama.cpp, or set JERRITO_BIN_DIR to its bin/, or\n' +
                '            JERRITO_BASE_URL to an existing server (e.g. ollama on :11434)');
        }
        const model = await ensureModel();
        const preset = presetFor(model);
        const port = await freePort();
        const base = `http://127.0.0.1:${port}/v1`;
        process.stderr.write(dim(`starting llama-server · ${path.basename(model)} · :${port}`));

        const wantsJinja = Array.isArray(preset.args) ? preset.args.includes('--jinja')
            : /sharp|minicpm|qwen3|gemma|phi/i.test(path.basename(model));
        const caps = serverCaps(bin);
        let pid = spawnDetached(bin, serverArgs(model, port, wantsJinja, caps));
        let ok = await waitHealthy(base, pid, 180000);
        if (!ok && wantsJinja) {
            // some GGUFs ship no template at all; retry without --jinja
            process.stderr.write(dim(' retrying without --jinja'));
            pid = spawnDetached(bin, serverArgs(model, port, false, caps));
            ok = await waitHealthy(base, pid, 180000);
        }
        process.stderr.write(TTY ? '\r\x1b[2K' : '\n');
        if (!ok) {
            const tail = logTail(1000).trim();
            throw new Error('llama-server did not start. log: ' + LOG_FILE + (tail ? '\n' + tail : ''));
        }

        const st = { pid, base, model, preset, started: Date.now(), idleSeconds: idleSeconds() };
        writeJson(STATE_FILE, st);
        // the watchdog needs the state file to confirm the pid is still ours
        const watchPid = startWatchdog(pid, base);
        if (watchPid) writeJson(STATE_FILE, { ...st, watchPid });
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
    stopWatchdog(st.watchPid);
    try { process.kill(st.pid, 'SIGTERM'); } catch { }
    try { unlinkSync(STATE_FILE); } catch { }
    console.log(`stopped llama-server (pid ${st.pid}, ${path.basename(st.model || '')})`);
}

/** `jerrito --instances [refresh]` */
async function listInstances(refresh) {
    const explicit = explicitFourgetBases();
    if (explicit) {
        console.log(`explicit list (JERRITO_4GET_URL / config "fourget"): ${explicit.length || 'none (disabled)'}`);
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
    // what it will do on its own:
    const idle = st.idleSeconds ?? idleSeconds();
    const bits = [idle ? `sleeps after ${idle}s idle` : 'never sleeps (JERRITO_IDLE=0)'];
    if (vramFreeBytes() !== null) {
        bits.push(`exits if free VRAM drops below ${vramFloorMb()} MB`);
        bits.push(st.watchPid && isAlive(st.watchPid) ? `watchdog ${st.watchPid}` : 'watchdog not running');
    }
    console.log(dim('  ' + bits.join(' · ')));
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
const mdLang = (s) => (COLOR ? `\x1b[2;36m${s}\x1b[22;39m` : s);

// double-width (CJK, most emoji) and zero-width (combining marks, joiners)
// ranges: only used for table padding, where a miscount breaks the grid
const WIDE_CH = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}]/u;
const ZERO_CH = /[\u0300-\u036F\u200B-\u200F\uFE00-\uFE0F\u{1F3FB}-\u{1F3FF}]/u;

/** visible width of a styled string: escapes print nothing, emoji twice */
const visLen = (s) => {
    let n = 0;
    for (const ch of s.replace(/\x1b\[[0-9;]*m/g, '')) {
        if (ZERO_CH.test(ch)) continue;
        n += WIDE_CH.test(ch) ? 2 : 1;
    }
    return n;
};
const indentOf = (line) => ((line.match(/^[ \t]*/) || [''])[0]).length;

/**
 * fenced code block -> a dim rail with the language as a title, so the ```
 * markers vanish and the code reads as one block instead of loose prose.
 * The rail is pinned to the *fence's* indent and each code line keeps only
 * what it had beyond that, so a block nested under a list item stays one
 * straight shape instead of a staircase.
 * Returns null when the line is not part of a fence.
 */
function styleFence(line, state) {
    const at = state.fenceIndent || 0;
    const m = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (state.inFence) {
        // only the same marker with nothing after it closes (a longer fence or
        // an info string inside a block is content, as in CommonMark)
        if (m && m[2][0] === (state.fenceChar || '`') && !m[3].trim()) {
            state.inFence = false;
            state.fenceChar = '';
            state.lang = '';
            return ' '.repeat(at) + mdDim('└─');
        }
        const rest = line.slice(Math.min(indentOf(line), at));
        // blank lines keep the rail, so the block stays one shape
        return ' '.repeat(at) + mdDim(rest ? '│ ' : '│') + rest;
    }
    if (!m) return null;
    const lang = (m[3].trim().split(/\s+/)[0] || '').toLowerCase();
    state.inFence = true;
    state.fenceChar = m[2][0];
    state.fenceIndent = m[1].length;
    state.lang = lang;
    return m[1] + mdDim('┌─') + (lang ? ' ' + mdLang(lang) : '');
}

/**
 * inline markdown -> styled text. `bare` drops link URLs (a table cell has no
 * room for them). Escapes are inserted after the match, never before, or the
 * bold/link regexes would match their own ANSI sequences.
 */
function styleInline(text, opts = {}) {
    const stash = [];
    const hold = (s) => `\u0001${stash.push(s) - 1}\u0001`;
    const italic = (t) => t.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\*)/g, (_, pre, s) => pre + mdItalic(s));

    let out = text.replace(/`([^`]+)`/g, (_, c) => hold(mdCode(c)));
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
        (_, t, u) => hold(opts.bare ? mdUnder(t) : mdUnder(t) + ' ' + mdDim(u)));
    // ***both***, then **bold** (which may contain *italic* and code), then *italic*
    out = out.replace(/\*\*\*([^*]+)\*\*\*/g, (_, t) => hold(mdBold(mdItalic(t))));
    out = out.replace(/\*\*(.+?)\*\*/g, (_, t) => hold(mdBold(italic(t))));
    out = italic(out);

    // placeholders can nest (code inside bold), so expand until none are left
    for (let i = 0; i < 5 && /\u0001\d+\u0001/.test(out); i++) {
        out = out.replace(/\u0001(\d+)\u0001/g, (_, k) => stash[+k]);
    }
    return out;
}

// ------------------------------------------------------------- tables ---
// A table can only be aligned once every row is known, so rows are buffered
// and emitted as one block when the table ends (styleMdLine returns null while
// a row is held). Surrounding pipes are required: `ls | grep` in prose is not
// a table.
const isTableRow = (line) => {
    const t = line.trim();
    return t.length > 1 && t.startsWith('|') && t.endsWith('|');
};
const isRuleCell = (c) => /^:?-+:?$/.test(c.trim());

/** `| a | b \| c |` -> ['a', 'b | c'] */
function splitCells(line) {
    const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** `:--` left, `:-:` centre, `--:` right */
function cellAlign(spec) {
    const s = spec.trim();
    const left = s.startsWith(':');
    const right = s.endsWith(':');
    return left && right ? 'center' : right ? 'right' : 'left';
}

/** one cell, padded out to its column width */
function padCell(cell, w, align) {
    const gap = Math.max(0, w - (cell.w || 0));
    if (align === 'right') return ' '.repeat(gap) + cell.text;
    if (align === 'center') {
        const l = Math.floor(gap / 2);
        return ' '.repeat(l) + cell.text + ' '.repeat(gap - l);
    }
    return cell.text + ' '.repeat(gap);
}

/**
 * column widths for a table: narrow columns get what they need, the wide ones
 * share what is left (water filling). Nothing shrinks while everything fits.
 */
function fitWidths(needs, avail) {
    const widths = needs.slice();
    if (widths.reduce((a, b) => a + b, 0) <= avail) return widths;
    const order = needs.map((_, i) => i).sort((a, b) => needs[a] - needs[b]);
    let left = avail, n = needs.length;
    for (const i of order) {
        widths[i] = Math.max(3, Math.min(needs[i], Math.floor(left / n)));
        left -= widths[i];
        n -= 1;
    }
    // floor() leaves a little over: hand it back to whichever column is short
    let spare = avail - widths.reduce((a, b) => a + b, 0);
    while (spare > 0) {
        const i = widths.reduce((bi, w, j) => (w < needs[j] && (bi < 0 || needs[j] - w > needs[bi] - widths[bi]) ? j : bi), -1);
        if (i < 0) break;
        widths[i] += 1;
        spare -= 1;
    }
    return widths;
}

/**
 * wrap one cell's raw markdown to `w` visible columns. Markup spans are kept
 * whole (`**bold phrase**` is never cut in half), so each chunk styles on its
 * own; only a single unbreakable word gets cut, and that one has no markup.
 */
function wrapCell(raw, w) {
    const width = Math.max(1, w);
    const styledW = (s) => visLen(styleInline(s, { bare: true }));
    const tokens = raw.match(/`[^`]*`|\*\*\*[^*]*\*\*\*|\*\*[^*]*\*\*|__[^_]*__|\*[^*\s][^*]*\*|\[[^\]]*\]\([^)]*\)|\S+/g) || [];
    // a span wider than the column is split *inside*: each piece keeps its
    // markers, so nothing renders as a stray `**` or a swallowed half-string
    const splitToken = (tok, room) => {
        const span = /^(\*\*\*|\*\*|\*|__|`)([\s\S]*)\1$/.exec(tok);
        if (span && room > span[1].length * 2 + 1) {
            const inner = Math.max(1, room - span[1].length * 2);
            return wrapCell(span[2], inner).map((c) => span[1] + c + span[1]);
        }
        // a single word (a URL, an identifier): cut it, there is no markup here
        const pieces = [];
        for (let i = 0; i < tok.length; i += room) pieces.push(tok.slice(i, i + room));
        return pieces;
    };
    const out = [];
    let cur = '';
    for (const tok of tokens) {
        if (cur) {
            const cand = cur + ' ' + tok;
            if (styledW(cand) <= width) { cur = cand; continue; }
            out.push(cur);
            cur = '';
        }
        if (styledW(tok) <= width) { cur = tok; continue; }
        const pieces = splitToken(tok, width);
        out.push(...pieces.slice(0, -1));
        cur = pieces[pieces.length - 1] || '';
    }
    if (cur) out.push(cur);
    return out.length ? out : [''];
}

/** buffered rows -> aligned block: header bold, the delimiter row becomes a rule */
function styleTable(rows) {
    const cells = rows.map(splitCells);
    const ruleAt = cells.findIndex((cs) => cs.length && cs.every(isRuleCell));
    const aligns = ruleAt > 0 ? cells[ruleAt].map(cellAlign) : [];
    const body = cells
        .map((cs, i) => (i === ruleAt ? null : cs.map((c) => {
            const text = styleInline(c, { bare: true });
            return { raw: c, text, w: visLen(text) };
        })))
        .filter(Boolean);
    if (!body.length) return '';

    const cols = Math.max(...body.map((r) => r.length));
    const needs = [];
    for (let i = 0; i < cols; i++) needs.push(Math.max(1, ...body.map((r) => (r[i] ? r[i].w : 0))));
    // the block keeps whatever indent the rows came in with (a table under a
    // list item stays under it), measured once so every line shares it
    const indent = ' '.repeat(Math.min(...rows.map(indentOf)));
    // a table wider than the terminal is not dumped raw: the columns shrink and
    // the cells wrap, so the grid survives instead of becoming a wall of prose
    const widths = fitWidths(needs, Math.max(20, COLS()) - indent.length - 3 * (cols - 1));
    // a pipe block whose first row is not data is the norm in model output, with
    // or without a delimiter row: bold that row and rule it off either way
    const hasHeader = body.length > 1;
    const rule = widths.map((w) => mdDim('─'.repeat(w))).join(mdDim('─┼─'));
    const out = [];

    body.forEach((row, r) => {
        // wrap each cell once, then stack the physical lines of the row
        const wrapped = Array.from({ length: cols }, (_, i) => {
            const cell = row[i];
            if (!cell) return [''];
            if (cell.w <= widths[i]) return [cell.text];
            return wrapCell(cell.raw, widths[i]).map((c) => styleInline(c, { bare: true }));
        });
        const height = Math.max(...wrapped.map((l) => l.length));
        for (let k = 0; k < height; k++) {
            const line = Array.from({ length: cols }, (_, i) => {
                const text = wrapped[i][k] || '';
                const padded = padCell({ text, w: visLen(text) }, widths[i], aligns[i] || 'left');
                return r === 0 && hasHeader ? mdBold(padded) : padded;
            }).join(' ' + mdDim('│') + ' ');
            out.push(indent + line);
        }
        if (r === 0 && hasHeader) out.push(indent + rule);
    });
    return out.join('\n');
}

/** end of a buffered table -> its rendered lines ('' when there was none) */
function flushTable(state) {
    const rows = state.rows || [];
    state.rows = [];
    return rows.length ? styleTable(rows) : '';
}

/**
 * one line of model markdown -> styled line; no-op when not a TTY. Returns
 * null when the line was buffered (table rows are aligned as a whole block).
 */
function styleMdLine(line, state) {
    if (!COLOR) return line;
    const fenced = styleFence(line, state);
    if (fenced !== null) return fenced;
    if (isTableRow(line)) {
        if (!state.rows) state.rows = [];
        state.rows.push(line);
        return null;
    }
    const table = flushTable(state);

    let out = styleInline(line);
    // then line-level markers: the markers go, the text keeps the emphasis
    out = out
        .replace(/^(\s*)#{1,6}\s+(.*?)(?:\s+#+)?\s*$/, (_, sp, t) => sp + mdBold(t))
        .replace(/^(\s*)([-*+])\s+/, (_, sp, m) => sp + mdDim(m) + ' ')
        .replace(/^(\s*)(\d+\.)\s+/, (_, sp, m) => sp + mdDim(m) + ' ')
        .replace(/^(\s*)>\s?/, (_, sp) => sp + mdDim('│ '));
    return table ? table + '\n' + out : out;
}

/** line-buffered so styles never straddle a chunk boundary */
function mdStream() {
    let buf = '';
    const state = { inFence: false, fenceIndent: 0, fenceChar: '`', lang: '', rows: [] };
    const emit = (line) => {
        const out = styleMdLine(line, state);
        if (out !== null) process.stdout.write(out + '\n');
    };
    return {
        push(chunk) {
            buf += chunk;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                emit(buf.slice(0, i));
                buf = buf.slice(i + 1);
            }
        },
        end() {
            if (buf.length) emit(buf);
            buf = '';
            const table = flushTable(state);
            if (table) process.stdout.write(table + '\n');
            // an answer that stops mid-block still closes the rail
            if (state.inFence) {
                state.inFence = false;
                process.stdout.write(' '.repeat(state.fenceIndent || 0) + mdDim('└─') + '\n');
            }
        },
    };
}

/**
 * a panel cannot be taller than the terminal it sits in: rows that scroll off
 * the top can no longer be erased, so the next redraw printed a second copy
 * below the first. Keep only the newest rows and the erase always lines up.
 */
function capPanelRows(rows, terminalRows) {
    const max = Math.max(3, (terminalRows || 24) - 1);
    return rows.length > max ? rows.slice(rows.length - max) : rows;
}

/** rows drawn below the cursor, so they can be erased again */
const panel = {
    rows: [],
    drawn: 0,
    statusOn: false,

    erase() {
        if (!TTY || !this.drawn) return;
        process.stderr.write(`\x1b[${this.drawn}A\r\x1b[J`);
        this.drawn = 0;
    },

    render() {
        if (!TTY) return;
        this.erase();
        // cap first, erase later: same height on both sides of the redraw
        this.rows = capPanelRows(this.rows, process.stderr.rows);
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
    const h = String(args.query ?? args.url ?? args.pattern ?? args.path ?? args.page ?? '').replace(/\s+/g, ' ').trim();
    if (name === 'man') return `man ${clip(h, 30)}${args.section ? `(${args.section})` : ''}`;
    if (name === 'grep') return `grep ${JSON.stringify(clip(h, 40))}${args.glob ? ' ' + args.glob : ''}`;
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
    // footer data: generation speed/tokens, per-tool wall time
    let tok = 0, genMs = 0, toolCount = 0;
    const starts = [];                       // per call, so parallel calls keep their own timing
    const spans = [];                        // [{ name, start, end }] once a call has finished

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
            const id = calls.length;
            calls.push([name, args]);
            starts[id] = Date.now();
            toolCount++;
            const w = Math.max(10, COLS() - 6);
            let d = describeCall(name, args);
            if (d.length > w) d = describeCall(name, args, true);
            panel.line(`⚙ ${d.length > w ? clip(d, w) : d}`);
            drawn = true;
            return id;
        },

        toolResult(text, id = calls.length - 1) {
            if (starts[id]) {
                spans.push({ name: calls[id]?.[0] || '', start: starts[id], end: Date.now() });
                starts[id] = 0;
            }
            panel.line(`→ ${clip(String(text).split('\n')[0], Math.max(10, COLS() - 10))}`);
            drawn = true;
        },

        /** per-completion generation stats (llama.cpp timings, or a delta-count fallback) */
        usage(u) {
            tok += u.tok || 0;
            genMs += u.ms || 0;
        },

        /** one dim line under the answer: speed, tokens, tool time. TTY only —
         *  piped stdout stays clean markdown */
        footer() {
            if (!TTY || !tok) return;
            // wall time per tool: overlapping parallel calls count once, so
            // "search 1.2s" means the turn spent 1.2s waiting on searches
            const unionMs = (name) => {
                const list = spans.filter((s) => s.name === name).sort((a, b) => a.start - b.start);
                let total = 0, from = -1, to = -1;
                for (const s of list) {
                    if (s.start > to) {
                        if (to > from) total += to - from;
                        from = s.start; to = s.end;
                    } else to = Math.max(to, s.end);
                }
                return to > from ? total + (to - from) : total;
            };
            const bits = [];
            if (genMs > 0) bits.push(`${(tok / (genMs / 1000)).toFixed(1)} tok/s`);
            bits.push(`${tok} tok`);
            const searchMs = unionMs('web_search'), fetchMs = unionMs('web_fetch');
            if (searchMs) bits.push(`search ${(searchMs / 1000).toFixed(1)}s`);
            if (fetchMs) bits.push(`fetch ${(fetchMs / 1000).toFixed(1)}s`);
            if (toolCount) bits.push(`${toolCount} tool${toolCount === 1 ? '' : 's'}`);
            bits.push(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
            process.stdout.write(mdDim('— ' + bits.join(' · ')) + '\n');
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

    // the machine, from free sources only — no subprocesses. a 2 B model cannot
    // tell NixOS from Ubuntu or fish from bash and will otherwise suggest
    // apt/dnf/pip installs that are wrong here
    const distro = (() => {
        try { return /^PRETTY_NAME="?([^"\n]+)"?/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1]; } catch { return ''; }
    })();
    const system = `System: ${os.userInfo().username}@${os.hostname()}, shell ${path.basename(process.env.SHELL || '')}, ${distro || 'unknown OS'}, ${os.arch() === 'x64' ? 'x86_64' : os.arch() === 'arm64' ? 'aarch64' : os.arch()}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM.`
        + ' Give commands for THIS system only (NixOS: nix/NixOS options, not apt/dnf/pip).';

    return [
        `You are "Jerrito", a terminal assistant on Linux. Today is ${today}. You communicate through the terminal: keep answers short.`,
        mode,
        'Rules:',
        '1. Every question is in scope; the project is context, not a filter.',
        '2. For command questions, always use the `man` tool first (web_search if no entry). File contents and names: never guess — grep first (pattern), then read only those lines.',
        '3. For news, versions, prices or anything that could changed, call web_search (then web_fetch on the best URL). Do not rely on your knowledge.',
        '4. You cannot run shell commands. When a command is needed, print the exact command in a code block and explain it in one line.',
        '5. Always cite your sources (a file, web search, etc).',
        '6. If a tool returns nothing, say so instead of making something up.',
        '7. Plain text, no emoji, no preamble, under 120 words unless asked for detail.',
        '8. Stop calling tools once you have enough to answer. Two searches that did not help means: say so.',
        '9. End with the answer, not with a question or an offer to do more.',
        '10. Unseen file: read({path, outline:true}) FIRST (symbols/sections with line numbers, very cheap), then read({path, offset:N, limit:M}) for only that range. Never read a whole file. Do not call a tool twice with the same arguments.',
        '11. If you need multiple lookups, make ALL tool calls in the SAME reply; calls in one reply run at the same time.',
        'Example: "where is X configured?" -> grep({"pattern":"X"}), then read the file:line it returns.',
        '',
        system,
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
// llama.cpp fills every SSE chunk with cumulative timings when asked; servers
// that reject the parameter are remembered so we do not ask again this run
let askTimings = true;

async function complete(messages, signal, render, { allowTools = true } = {}) {
    const body = {
        model: CFG.model,
        messages,
        ...(allowTools ? { tools: TOOLS, tool_choice: 'auto' } : {}),
        temperature: CFG.temp,
        max_tokens: CFG.maxTokens,
        ...SAMPLING,
        stream: true,
    };
    if (askTimings) body.timings_per_token = true;
    const res = await fetch(CFG.base + '/chat/completions', {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + CFG.key },
        body: JSON.stringify(body),
    });

    if (!res.ok && askTimings && res.status === 400 && /timings/i.test(await res.clone().text())) {
        askTimings = false;
        return complete(messages, signal, render, { allowTools });
    }

    if (!res.ok) {
        const body = (await res.text()).slice(0, 400);
        throw new Error(`chat/completions HTTP ${res.status}: ${body}`);
    }

    const ct = res.headers.get('content-type') || '';
    if (!/event-stream/i.test(ct)) {
        const j = await res.json();
        const m = j.choices?.[0]?.message || {};
        if (m.reasoning_content) render.think(m.reasoning_content);
        const textCalls = (m.tool_calls || []).length ? [] : parseTextCalls(m.content || '');
        if (textCalls.length) return { content: '', toolCalls: textCalls.map(asCall) };
        if (m.content) render.answer(m.content);
        if (CFG.stats) showStats(j.usage);
        const t = j.timings;
        render.usage(t
            ? { tok: t.predicted_n || 0, ms: t.predicted_ms || 0, promptTok: t.prompt_n, promptMs: t.prompt_ms }
            : { tok: j.usage?.completion_tokens || 0, ms: 0 });
        return { content: m.content || '', toolCalls: m.tool_calls || [] };
    }

    let buf = '', content = '';
    const calls = [];
    // servers without timings: each content delta is ~one token, close enough
    // for a footer; reasoning deltas do not count (they are not the answer)
    let deltas = 0, firstAt = 0, lastAt = 0, lastTimings = null;
    // small reasoning models put their chain of thought in reasoning_content;
    // it is shown in the panel and never stored in history
    const think = (t) => render.think(t);
    // Some models print the call as *text* — <function name="read"><param…> —
    // instead of using tool_calls. Hold the answer's first few characters back so
    // a textual call can be turned into a real one instead of being printed.
    let held = '', holding = true;
    const flush = () => { if (held) { content += held; render.answer(held); held = ''; } holding = false; };
    const answer = (t) => {
        if (!holding) { content += t; render.answer(t); return; }
        held += t;
        if (/^\s*$/.test(held)) return;                  // whitespace so far
        if (!/^\s*[<{]/.test(held)) return flush();      // prose: stream it now
        if (held.length > 700) return flush();           // far too long to be a call
    };
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
            if (j.timings) lastTimings = j.timings;
            if (d.reasoning_content) think(d.reasoning_content);
            if (d.content) {
                answer(d.content);
                if (!lastTimings) { deltas++; lastAt = Date.now(); if (!firstAt) firstAt = lastAt; }
            }
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
    if (lastTimings) {
        render.usage({ tok: lastTimings.predicted_n || 0, ms: lastTimings.predicted_ms || 0, promptTok: lastTimings.prompt_n, promptMs: lastTimings.prompt_ms });
    } else if (deltas) {
        render.usage({ tok: deltas, ms: lastAt - firstAt });
    }
    if (holding) {
        const textCalls = toolCalls.length ? [] : parseTextCalls(held);
        if (textCalls.length) return { content: '', toolCalls: textCalls.map(asCall) };
        flush();
    }
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
            render.footer();
            if (!content.trim()) {
                process.stdout.write(yellow(step === 0
                    ? '(empty response — try a bigger JERRITO_MAX_TOKENS)'
                    : `(no answer after ${step} tool steps — try a larger JERRITO_STEPS or a model that routes tools better)`) + '\n');
            }
            process.stdout.write('\n');
            return content;
        }
        // The tools are independent reads, so a model that asks three questions
        // in one turn should not pay for three round trips one after another.
        // Batches of CFG.parallel (default 5) — a model that spams searches must
        // not be able to open twenty sockets.
        for (let i = 0; i < toolCalls.length; i += CFG.parallel) {
            const batch = toolCalls.slice(i, i + CFG.parallel);
            // JERRITO_STATS=1 says how the model batched: "2 at once" is the
            // difference between one round trip and two
            if (CFG.stats && toolCalls.length > 1) {
                const names = batch.map((c) => c.function?.name || '?').join(', ');
                process.stderr.write(dim(`[${batch.length} of ${toolCalls.length} tool calls at once: ${names}]\n`));
            }
            const jobs = batch.map((call) => {
                const fn = call.function?.name || '';
                let args = {};
                const raw = call.function?.arguments;
                if (raw && typeof raw === 'object') args = raw;
                else { try { args = JSON.parse(raw || '{}') || {}; } catch { } }
                const id = render.tool(fn, args);
                return (async () => {
                    let text;
                    try { text = (await runTool(fn, args)).text; }
                    catch (e) { text = `Tool error: ${e.name === 'TimeoutError' ? 'request timed out' : e.message}`; }
                    render.toolResult(text, id);      // print each result as it lands
                    return { call, fn, text };
                })();
            });
            // history keeps the model's own order, not the completion order
            for (const { call, fn, text } of await Promise.all(jobs)) {
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id || `call_${Math.random().toString(36).slice(2, 10)}`,
                    name: fn || 'unknown',
                    content: text,
                });
            }
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
    console.log(`${PROG} — stupid-minimal little helper for small local models

usage:
${rows.map(([a, b]) => '  ' + a.padEnd(w) + '  ' + b).join('\n')}

options:
  -m, --model <path|id>  use this .gguf file (saved as the default) or model id
  -u, --base-url <url>   use an existing OpenAI-compatible server, never spawn
  -h, --help             this text

First run: finds llama-server (PATH or nix store), picks a tool-capable .gguf on
this machine, or downloads Sharp-MiniCPM5-2B once to ~/.cache/jerrito/models,
then starts it detached on a free port and reuses it. An idle server releases
its VRAM (sleeps after ${idleSeconds()}s) and a watchdog stops it outright when
another program needs the GPU. Model + server settings live in
~/.config/jerrito/config.json.

env: JERRITO_MODEL_FILE JERRITO_BASE_URL JERRITO_API_KEY JERRITO_TEMP JERRITO_MAX_TOKENS
     JERRITO_TOP_P JERRITO_TOP_K JERRITO_MIN_P JERRITO_REPEAT_PENALTY JERRITO_STATS
     JERRITO_STEPS JERRITO_PARALLEL JERRITO_MAX_CHARS JERRITO_SEARCH_RESULTS
     JERRITO_SEARCH_TIMEOUT JERRITO_SEARCH_HEDGE JERRITO_FETCH_CHARS
     JERRITO_READ_LINES JERRITO_NO_SPAWN JERRITO_BIN_DIR JERRITO_IDLE
     JERRITO_VRAM_FLOOR JERRITO_VRAM_GRACE JERRITO_NO_WATCHDOG JERRITO_BING
`);
}

async function main(argv) {
    // internal: the detached VRAM watchdog (see startWatchdog) — not a user flag
    if (argv[0] === '--watch') return watchdog(Number(argv[1]), argv[2] || '');

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
            const args = toolName === 'read' ? { path: arg, outline: /\boutline\b/.test(process.env.JERRITO_TOOL_ARGS || '') }
                : toolName === 'web_fetch' ? { url: arg }
                    : toolName === 'grep' ? { pattern: question[0] || '', path: question[1], glob: question[2] }
                        : toolName === 'man' ? { page: question[0] || '', section: question[1] }
                            : { query: arg };
            const r = await runTool(toolName, args);
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
    htmlToMarkdown, webSearch, webFetch, readTool, TOOLS, ask, CFG, styleMdLine, flushTable,
    makeTurnRenderer, capPanelRows, fitWidths, wrapCell,
    downloadModel, findServerBinary, findLocalModels, ensureServer, serverArgs, stopServer,
    underPressure, vramFreeBytes, idleSeconds, serverCaps, watchdog, parseSmFreeMiB, systemPrompt,
};
