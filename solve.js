// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Same answers as makefun-site 1.0.0, byte for byte, on every input. Written from
// the reference's README and code (vendor/makefun-site in the kit): the front
// matter, template dialect, Markdown subset, slug rule and report are its own.
// Speed comes from doing the same work with less allocation and fewer passes:
//   - Markdown renders in one pass with no token tree; inline text is escaped
//     in bulk runs and the scanner jumps straight to the next special char.
//   - Templates are compiled to plain JS functions (one factory per build);
//     a small interpreter with the same semantics is kept as a fallback.
//   - slugify has an ASCII fast path plus a per-build cache; word counting is
//     a single manual pass instead of a regex match.
// Nothing is cached from one case to the next: all per-build state lives in
// run(). No imports, no I/O, no network, no randomness.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;

/** The slug of `text` (baseline logic); the ASCII path skips NFKD + the mark regex. */
function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function slugify(text, cache) {
  if (cache !== undefined) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
  }
  let out = '';
  let gap = false;
  let slow = false;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      slow = true;
      break;
    }
    const ch = text[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  if (slow) out = slugifySlow(text);
  else {
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    if (out === '') out = 'untitled';
  }
  if (cache !== undefined) cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${+date.slice(8, 10)} ${MONTHS[+date.slice(5, 7) - 1]} ${date.slice(0, 4)}`;
}

/** Whether a UTF-16 code unit is whitespace, exactly as /\s/ has it. */
function isWS(code) {
  return (
    code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32 ||
    code === 160 || code === 5760 || (code >= 8192 && code <= 8202) ||
    code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279
  );
}

/** The words of a body: its runs of characters other than whitespace. */
function countWords(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // ASCII fast path: whitespace is 9-13 or 32. Above it, only the exotic
    // Unicode spaces count (160, 1680, 2000-200A, 2028, 2029, 202F, 205F,
    // 3000, FEFF) -- exactly /\s/.
    const ws =
      c < 128
        ? (c >= 9 && c <= 13) || c === 32
        : c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const TAG_OK = /^[^"[\]]+$/;
const NAME_OK = /^[a-z0-9-]+$/;
const SLUG_OK = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY_OK = /^[a-z_]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
      }
      const y = ok ? +raw.slice(0, 4) : 0;
      const mo = ok ? +raw.slice(5, 7) : 0;
      const d = ok ? +raw.slice(8, 10) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_OK.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_OK.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_OK.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Scanned by line offsets, so
 * the body is one slice, never split and re-joined.
 */
export function parseFrontMatter(text) {
  let nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  // The close is found first: a source whose front matter never closes is
  // refused for that, whatever its lines hold.
  let pos = nl === -1 ? text.length : nl + 1;
  let closeAt = -1;
  let closeEnd = -1;
  for (;;) {
    if (pos >= text.length) break;
    nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    if (text.slice(pos, lineEnd) === '---') {
      closeAt = pos;
      closeEnd = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = first.length + 1;
  let lineNo = 1;
  while (pos < closeAt) {
    nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? closeAt - 1 : nl;
    const line = text.slice(pos, lineEnd);
    lineNo++;
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) {
      pos = nl + 1;
      continue;
    }
    const colon = line.indexOf(':');
    let raw;
    if (colon <= 0 || !KEY_OK.test(line.slice(0, colon))) return { error: `line ${lineNo} is not "key: value"` };
    if (colon === line.length - 1) raw = '';
    else if (line[colon + 1] === ' ') raw = line.slice(colon + 2).replace(/[ \t]+$/, '');
    else return { error: `line ${lineNo} is not "key: value"` };
    const key = line.slice(0, colon);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    pos = nl + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown

// (Block dispatch is by first character with manual checks below; no regexes
// are run per line.)

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < 7 && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (line.charCodeAt(n) !== 32 && line.charCodeAt(n) !== 9) return null;
  let j = n;
  while (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9) j++;
  let e = line.length;
  while (e > j && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === j) return null;
  return { depth: n, text: line.slice(j, e) };
}

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` is a thematic break: `---` or `***`, then spaces or tabs only. */
function isHR(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let i = 3; i < line.length; i++) {
    const cc = line.charCodeAt(i);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** Whether `line` is blank: spaces and tabs only (non-empty). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text, or null when `line` does not open one. */
function bulletItem(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return trimLine(line.slice(2));
  return null;
}

/** An ordered item's start number and text, or null when `line` does not open one. */
function orderedItem(line) {
  let i = 0;
  while (i < 9 && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { start: Number(line.slice(0, i)), text: trimLine(line.slice(i + 2)) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isWS(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 96) return fenceOpen(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHR(line);
  if (c === 32 || c === 9) return isBlank(line);
  return false;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s` rendered inline, appended to `parts`; `env.link(target)` is a link's href. */
function inlineTo(parts, s, env) {
  // A fresh trigger regex per call: inlineTo recurses, so no shared state.
  const trig = /[\\`*[]/g;
  let i = 0;
  const len = s.length;
  while (i < len) {
    trig.lastIndex = i;
    const mt = trig.exec(s);
    const j = mt === null ? len : mt.index;
    if (j > i) parts.push(escapeHtml(s.slice(i, j)));
    i = j;
    if (i >= len) break;
    const c = s[i];
    if (c === '\\') {
      // No escapable character needs HTML escaping, so the char is itself.
      if (i + 1 < len && ESCAPABLE.has(s[i + 1])) {
        parts.push(s[i + 1]);
        i += 2;
      } else {
        parts.push('\\');
        i++;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        parts.push('<code>', escapeHtml(s.slice(i + 1, k)), '</code>');
        i = k + 1;
      } else {
        parts.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          parts.push('<strong>');
          inlineTo(parts, s.slice(i + 2, k), env);
          parts.push('</strong>');
          i = k + 2;
        } else {
          parts.push('**');
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1);
      if (k > i + 1) {
        parts.push('<em>');
        inlineTo(parts, s.slice(i + 1, k), env);
        parts.push('</em>');
        i = k + 1;
      } else {
        parts.push('*');
        i++;
      }
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', i + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      parts.push('<a href="', escapeHtml(env.link(target)), '">');
      inlineTo(parts, s.slice(i + 1, k), env);
      parts.push('</a>');
      i = m + 1;
      continue;
    }
    parts.push('[');
    i++;
  }
}

/**
 * `src` rendered in one pass (no token tree): its HTML, its table of contents
 * (every level 2 and 3 heading), its excerpt (the first paragraph's HTML) and
 * its word count.
 */
function renderMarkdown(src, env, slugCache) {
  const lines = src.split('\n');
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const N = lines.length;
  while (i < N) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (line === '') {
      i++;
      continue;
    }
    if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < N && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        out.push('<pre><code', cls, '>');
        if (body.length > 0) out.push(escapeHtml(body.join('\n')), '\n');
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, slugCache), ids);
        if (heading.depth === 2 || heading.depth === 3) {
          const tmp = [];
          inlineTo(tmp, heading.text, env);
          const html = tmp.join('');
          toc.push({ level: heading.depth, id, html });
          out.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
        } else {
          out.push(`<h${heading.depth} id="${id}">`);
          inlineTo(out, heading.text, env);
          out.push(`</h${heading.depth}>\n`);
        }
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHR(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
      const bItem = bulletItem(line);
      if (bItem !== null) {
        const items = [[bItem]];
        i++;
        while (i < N) {
          const m = bulletItem(lines[i]);
          if (m !== null) {
            items.push([m]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        out.push('<ul>\n');
        for (const parts of items) {
          out.push('<li>');
          inlineTo(out, parts.join('\n'), env);
          out.push('</li>\n');
        }
        out.push('</ul>\n');
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < N && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const ls = body.map(trimLine).filter((l) => l !== '');
      if (ls.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineTo(out, ls.join('\n'), env);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const oItem = orderedItem(line);
      if (oItem !== null) {
        const items = [[oItem.text]];
        const start = oItem.start;
        i++;
        while (i < N) {
          const m = orderedItem(lines[i]);
          if (m !== null) {
            items.push([m.text]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        out.push(start !== 1 ? `<ol start="${start}">` : '<ol>', '\n');
        for (const parts of items) {
          out.push('<li>');
          inlineTo(out, parts.join('\n'), env);
          out.push('</li>\n');
        }
        out.push('</ol>\n');
        continue;
      }
    } else if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < N && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    if (excerpt === null) {
      const tmp = [];
      inlineTo(tmp, text, env);
      excerpt = tmp.join('');
      out.push('<p>', excerpt, '</p>\n');
    } else {
      out.push('<p>');
      inlineTo(out, text, env);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '', words: countWords(src) };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }). The fallback interpreter,
 * used only if compiling the templates fails; the compiled form below is what
 * normally runs.
 */
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += ctx.escape(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        xs.forEach((x, k) => {
          const vars = { [n.name]: x, loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        });
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------- template compiler

let genCounter = 0;

/**
 * A template's free variables: first-segment names it reads that no `for` of
 * its own binds, in first-appearance order. Those become the compiled
 * function's parameters; everything else resolves to a loop local or to R.
 */
function freeVarsOf(nodes) {
  const free = [];
  const seen = new Set();
  const add = (n) => {
    if (!seen.has(n)) {
      seen.add(n);
      free.push(n);
    }
  };
  (function walk(ns, bound) {
    for (const n of ns) {
      if (n.kind === 'var' || n.kind === 'raw') {
        if (!bound.has(n.path[0])) add(n.path[0]);
      } else if (n.kind === 'if') {
        if (!bound.has(n.path[0])) add(n.path[0]);
        walk(n.then, bound);
        if (n.else !== null) walk(n.else, bound);
      } else if (n.kind === 'for') {
        if (!bound.has(n.path[0])) add(n.path[0]);
        const b2 = new Set(bound);
        b2.add(n.name);
        b2.add('loop');
        walk(n.body, b2);
      }
    }
  })(nodes, new Set());
  return free;
}

/** The JS expression for a path's first name in the current scope stack. */
function resolveFirst(scopeStack, name) {
  for (let d = scopeStack.length - 1; d >= 0; d--) {
    const e = scopeStack[d].get(name);
    if (e !== undefined) return e;
  }
  return `R[${JSON.stringify(name)}]`;
}

/** Code assigning a fresh temp the value at `path`; returns { code, expr }. */
function genLookup(scopeStack, path) {
  const t = `_t${genCounter++}`;
  let code = `let ${t} = ${resolveFirst(scopeStack, path[0])};\n`;
  for (let k = 1; k < path.length; k++) {
    const seg = JSON.stringify(path[k]);
    code += `if (${t} !== null && typeof ${t} === "object" && hasOwn(${t}, ${seg})) ${t} = ${t}[${seg}]; else ${t} = undefined;\n`;
  }
  return { code, expr: t };
}

/** JS source rendering `nodes` in the current scope stack. */
function genNodes(nodes, scopeStack, info) {
  let code = '';
  for (const n of nodes) {
    if (n.kind === 'text') {
      code += `out += ${JSON.stringify(n.text)};\n`;
    } else if (n.kind === 'var' || n.kind === 'raw') {
      const l = genLookup(scopeStack, n.path);
      code += l.code;
      code += n.kind === 'var' ? `out += esc(textOf(${l.expr}));\n` : `out += textOf(${l.expr});\n`;
    } else if (n.kind === 'if') {
      const l = genLookup(scopeStack, n.path);
      code += l.code;
      code += n.not ? `if (!truthy(${l.expr})) {\n` : `if (truthy(${l.expr})) {\n`;
      code += genNodes(n.then, scopeStack, info);
      if (n.else !== null) {
        code += `} else {\n`;
        code += genNodes(n.else, scopeStack, info);
      }
      code += `}\n`;
    } else if (n.kind === 'for') {
      const l = genLookup(scopeStack, n.path);
      const xs = `_x${genCounter++}`;
      const lp = `_l${genCounter++}`;
      const kk = `_k${genCounter++}`;
      const elem = n.name === 'loop' ? null : `_v${genCounter++}`;
      code += l.code;
      code += `if (Array.isArray(${l.expr})) {\n`;
      code += `const ${xs} = ${l.expr};\n`;
      code += `const ${lp} = { index: 0, first: false, last: false, length: ${xs}.length };\n`;
      code += `for (let ${kk} = 0; ${kk} < ${xs}.length; ${kk}++) {\n`;
      code += `${lp}.index = ${kk} + 1; ${lp}.first = ${kk} === 0; ${lp}.last = ${kk} === ${xs}.length - 1;\n`;
      if (elem !== null) code += `const ${elem} = ${xs}[${kk}];\n`;
      const inner = new Map();
      if (elem !== null) inner.set(n.name, elem);
      // A for-variable named `loop` is overwritten by the loop object itself,
      // exactly as the interpreter's `{ [name]: x, loop: {...} }` does.
      inner.set('loop', lp);
      scopeStack.push(inner);
      code += genNodes(n.body, scopeStack, info);
      scopeStack.pop();
      code += `}\n}\n`;
    } else if (n.kind === 'include') {
      const callee = info.get(n.name);
      if (callee !== undefined) {
        const f = `_f${genCounter++}`;
        const args = callee.freeVars.map((fv) => resolveFirst(scopeStack, fv)).join(', ');
        code += `if (depth < ${INCLUDE_DEPTH}) { const ${f} = F[${JSON.stringify(n.name)}]; if (${f} !== undefined) out += ${f}(R, depth + 1, F${args ? ', ' + args : ''}); }\n`;
      }
      // A missing template, or one that did not parse, renders nothing.
    }
  }
  return code;
}

/**
 * Compile every parsed template into a JS function. Returns { F, tops }:
 * F maps template names to functions, tops maps them to (R) => string entry
 * points that fill each free variable from R. All generated identifiers are
 * synthetic, so template variable names can never collide with JS keywords.
 * Throws only if code generation itself fails; callers fall back to the
 * interpreter then.
 */
function compileTemplates(templates) {
  genCounter = 0;
  const names = [...templates.keys()];
  const info = new Map();
  for (let i = 0; i < names.length; i++) info.set(names[i], { idx: i, freeVars: freeVarsOf(templates.get(names[i])) });
  let src = `\nconst ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };\n`;
  src += `${escapeHtml.toString()}\n${textOf.toString()}\n${truthy.toString()}\nconst esc = escapeHtml;\nconst hasOwn = Object.hasOwn;\n`;
  for (let i = 0; i < names.length; i++) {
    const { freeVars } = info.get(names[i]);
    const params = freeVars.map((_, k) => `_a${k}`).join(', ');
    const rootScope = new Map(freeVars.map((fv, k) => [fv, `_a${k}`]));
    src += `function fn_${i}(R, depth, F${params ? ', ' + params : ''}) {\nlet out = "";\n`;
    src += genNodes(templates.get(names[i]), [rootScope], info);
    src += `return out;\n}\n`;
  }
  src += `const F = Object.create(null);\n`;
  for (let i = 0; i < names.length; i++) src += `F[${JSON.stringify(names[i])}] = fn_${i};\n`;
  src += `const tops = Object.create(null);\n`;
  for (let i = 0; i < names.length; i++) {
    const { freeVars } = info.get(names[i]);
    const args = freeVars.map((fv) => `R[${JSON.stringify(fv)}]`).join(', ');
    src += `tops[${JSON.stringify(names[i])}] = function (R) { return fn_${i}(R, 0, F${args ? ', ' + args : ''}); };\n`;
  }
  src += `return { F, tops };\n`;
  return new Function(src)();
}

// ---------------------------------------------------------------- the build

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  let compiled = null;
  try {
    compiled = compileTemplates(templates);
  } catch {
    compiled = null;
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const broken = new Set();
  const bySource = new Map();
  const output = {};

  // 1. Sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Permalinks: each page's output directory and url, its slug unique in its directory.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown: each body's HTML, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // 5. Collections: the posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources)
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name, slugCache)) ?? { name, slug: slugify(name, slugCache), url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A post's card, as lists show it.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const linkOf = (s) =>
    s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));

  // A page as its layout reads it.
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    if (compiled !== null) {
      const top = compiled.tops[name];
      if (top === undefined) return null;
      const R = Object.create(null);
      R.site = site;
      R.tags = allTags;
      R.recent = recent;
      if (vars !== undefined) for (const k of Object.keys(vars)) R[k] = vars[k];
      return top(R);
    }
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    return renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, { templates, escape: escapeHtml }, 0);
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
