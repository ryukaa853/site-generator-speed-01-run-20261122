// A fast drop-in for makefun-site 1.0.0.
//
// Written from the makefun-site README spec and its reference behaviour:
// front matter, the template dialect, the Markdown subset, the slug rule
// and the build report are makefun-site's own. No code is copied from the
// reference: this file is an independent implementation of that spec,
// organised for speed — a chunk-scanning Markdown renderer, a slug memo,
// and templates compiled to small functions with per-case caching of the
// renders that only read the site-wide values.
//
// run(input) returns the output tree: { path: text } for every page the
// build writes, the index and tag pages, build-report.txt and each static
// file, byte for byte as makefun-site 1.0.0 returns it.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;
function esc(s) {
  // Most strings hold nothing to escape; returning them untouched avoids
  // building a throwaway copy of every plain chunk.
  return ESC_TEST.test(s) ? s.replace(ESC_RE, (c) => ESCAPES[c]) : s;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(date) {
  // The date is a validated YYYY-MM-DD string: slice it, don't split it.
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

const RESERVED = ['posts', 'tags', 'page'];

// ---------------------------------------------------------------- slugs

function makeSlugger() {
  const memo = new Map();
  const marks = /\p{M}/gu;
  const nonAscii = /[^\x00-\x7F]/;
  function slugify(text) {
    let out = memo.get(text);
    if (out !== undefined) return out;
    // ASCII text is already in NFKD with no combining marks.
    const plain = nonAscii.test(text) ? text.normalize('NFKD').replace(marks, '') : text;
    let s = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = s.length > 0;
        continue;
      }
      if (gap) s += '-';
      gap = false;
      s += keep;
    }
    s = s.slice(0, 64).replace(/-+$/, '');
    out = s === '' ? 'untitled' : s;
    memo.set(text, out);
    return out;
  }
  return slugify;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function fmString(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
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
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

function fmValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = fmString(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    const m = FM_DATE.exec(raw);
    const y = m ? Number(m[1]) : 0;
    const mo = m ? Number(m[2]) : 0;
    const d = m ? Number(m[3]) : 0;
    if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    for (const t of tags) if (t === '' || !FM_TAG.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    return { value: tags };
  }
  if (key === 'draft') {
    return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  if (key === 'slug') {
    return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
  }
  return { error: `unknown key "${key}"` };
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

function parseFrontMatter(text) {
  // Find the opening line without splitting the whole source: the body is
  // most of the text, and splitting it here would build every body line
  // once just to throw it away (the Markdown pass splits it again).
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  let closeStart = -1;
  let closeEnd = -1;
  let pos = firstNl;
  while (pos !== -1) {
    const at = text.indexOf('\n---', pos);
    if (at === -1) break;
    const after = at + 4;
    if (after === text.length || text[after] === '\n') {
      closeStart = at + 1;
      closeEnd = after === text.length ? text.length : after + 1;
      break;
    }
    pos = at + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const fmText = text.slice(firstNl + 1, closeStart - 1);
  const lines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line) || line[0] === '#') continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] === undefined ? '' : m[2]).replace(/[ \t]+$/, '');
    if (FM_KEYS.indexOf(key) === -1) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd >= text.length ? '' : text.slice(closeEnd) };
}

// ---------------------------------------------------------------- Markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const CONTINUED_RE = /^ {2,}\S/;
const MD_SPECIAL = /[\\`*\[]/;

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function headingOf(line) {
  if (line[0] !== '#') return null;
  const m = HEADING_RE.exec(line);
  if (m === null || m[2] === '') return null;
  return { depth: m[1].length, text: m[2] };
}

function endsParagraph(line) {
  if (line === '') return true;
  const c = line[0];
  if (c === '`') return FENCE_OPEN.test(line);
  if (c === '#') return headingOf(line) !== null;
  if (c === '-' || c === '*') return HR_RE.test(line);
  if (c === ' ' || c === '\t') return isBlank(line);
  return false;
}

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

// Inline rendering: one regex scan for every markup character, in C,
// instead of four indexOf passes per character. A fresh regex per call:
// inlineMd recurses into itself for strong/emphasis/link text, so no
// regex may be shared. Plain runs are escaped in one replace each.
function inlineMd(s, link) {
  if (!MD_SPECIAL.test(s)) return esc(s);
  const re = /[\\`*\[]/g;
  const n = s.length;
  let out = '';
  let plain = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const j = m.index;
    const c = s[j];
    if (c === '\\' && j + 1 < n && ESCAPABLE.has(s[j + 1])) {
      if (j > plain) out += esc(s.slice(plain, j));
      out += ESCAPES[s[j + 1]] || s[j + 1];
      plain = j + 2;
      re.lastIndex = j + 2;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > plain) out += esc(s.slice(plain, j));
        out += `<code>${esc(s.slice(j + 1, k))}</code>`;
        plain = k + 1;
        re.lastIndex = k + 1;
      } else {
        re.lastIndex = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > plain) out += esc(s.slice(plain, j));
          out += `<strong>${inlineMd(s.slice(j + 2, k), link)}</strong>`;
          plain = k + 2;
          re.lastIndex = k + 2;
        } else {
          re.lastIndex = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > plain) out += esc(s.slice(plain, j));
        out += `<em>${inlineMd(s.slice(j + 1, k), link)}</em>`;
        plain = k + 1;
        re.lastIndex = k + 1;
      } else {
        re.lastIndex = j + 1;
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', j + 1);
    const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !/\s/.test(target)) {
      if (j > plain) out += esc(s.slice(plain, j));
      out += `<a href="${esc(link(target))}">${inlineMd(s.slice(j + 1, k), link)}</a>`;
      plain = mm + 1;
      re.lastIndex = mm + 1;
      continue;
    }
    re.lastIndex = j + 1;
  }
  if (n > plain) out += esc(s.slice(plain, n));
  return out;
}

function renderMarkdown(src, link, slugify) {
  const lines = src.split('\n');
  let html = '';
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const total = lines.length;
  while (i < total) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = line[0] === '`' ? FENCE_OPEN.exec(line) : null;
    if (fence !== null) {
      const body = [];
      i++;
      while (i < total && !(lines[i][0] === '`' && FENCE_CLOSE.test(lines[i]))) body.push(lines[i++]);
      i++;
      const cls = fence[1] === '' ? '' : ` class="language-${esc(fence[1])}"`;
      const inner = body.length === 0 ? '' : `${esc(body.join('\n'))}\n`;
      html += `<pre><code${cls}>${inner}</code></pre>\n`;
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const h = inlineMd(heading.text, link);
      html += `<h${heading.depth} id="${id}">${h}</h${heading.depth}>\n`;
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: h });
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    if (line[0] === '>') {
      const body = [];
      while (i < total && lines[i][0] === '>') body.push(lines[i++].replace(/^> ?/, ''));
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      html += kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inlineMd(kept.join('\n'), link)}</p>\n</blockquote>\n`;
      continue;
    }
    const bullet = (line[0] === '-' || line[0] === '*') ? BULLET_RE.exec(line) : null;
    const ordered = bullet === null && line[0] >= '0' && line[0] <= '9' ? ORDERED_RE.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED_RE : BULLET_RE;
      const items = [];
      while (i < total) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (lines[i][0] === ' ' && lines[i][1] === ' ' && CONTINUED_RE.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && Number(ordered[1]) !== 1 ? `<ol start="${Number(ordered[1])}">` : `<${tag}>`;
      let out = `${open}\n`;
      for (const parts of items) out += `<li>${inlineMd(parts.join('\n'), link)}</li>\n`;
      html += `${out}</${tag}>\n`;
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < total && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const phtml = inlineMd(body.join('\n'), link);
    if (excerpt === null) excerpt = phtml;
    html += `<p>${phtml}</p>\n`;
  }
  return { html, toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

// Split a template source into tokens. A {% %} tag alone on its line takes
// the whole line (and its newline) with it; {{ }} and {{{ }}} never do.
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
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null ? parent.else : parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// The names a template reads from its calling scope (names bound by its own
// for loops excluded, includes followed through the scope they are called
// in). Used to find renders that only read the site-wide values.
function externalsOf(nodes, parsed, bound, visiting) {
  const out = new Set();
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      const inner = new Set(bound);
      inner.add(n.name);
      inner.add('loop');
      for (const e of externalsOf(n.body, parsed, inner, visiting)) out.add(e);
    } else if (n.kind === 'if') {
      // handled above; branches share the same scope
    }
    if (n.kind === 'if') {
      for (const e of externalsOf(n.then, parsed, bound, visiting)) out.add(e);
      if (n.else !== null) for (const e of externalsOf(n.else, parsed, bound, visiting)) out.add(e);
    } else if (n.kind === 'include') {
      const sub = parsed.get(n.name);
      if (sub !== undefined && !visiting.has(n.name)) {
        visiting.add(n.name);
        for (const e of externalsOf(sub, parsed, new Set(), visiting)) if (!bound.has(e)) out.add(e);
        visiting.delete(n.name);
      }
    }
  }
  return out;
}

// --- template helpers shared by every compiled template -------------------

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function getOwn(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

// --- compiling a parsed template into a function --------------------------
// fn(S, D, O, C, H, T): S is the flat scope (a null-prototype object holding
// every visible name), D the include depth, O the output chunk array, C the
// per-case engine, H the helpers, T the array of all compiled templates
// (includes call straight into it by index, with no Map lookup). For loops
// mutate S with save/restore, which is safe because rendering is sequential.

function pathExpr(path) {
  let e = `S.${path[0]}`;
  for (let k = 1; k < path.length; k++) e = `G(${e},${JSON.stringify(path[k])})`;
  return e;
}

function compileNodes(nodes, code, ctx) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      code.push(`O.push(${JSON.stringify(n.text)});`);
    } else if (n.kind === 'var') {
      code.push(`O.push(E(X(${pathExpr(n.path)})));`);
    } else if (n.kind === 'raw') {
      code.push(`O.push(X(${pathExpr(n.path)}));`);
    } else if (n.kind === 'if') {
      const cond = n.not ? `!Y(${pathExpr(n.path)})` : `Y(${pathExpr(n.path)})`;
      code.push(`if(${cond}){`);
      compileNodes(n.then, code, ctx);
      if (n.else !== null) {
        code.push('}else{');
        compileNodes(n.else, code, ctx);
      }
      code.push('}');
    } else if (n.kind === 'for') {
      const v = n.name;
      // Save/restore by assignment, never by delete: deleting a property
      // would drop the scope object into dictionary mode and slow every
      // later read of it. Restoring the saved value (undefined when the
      // name was absent) reads exactly the same to a template.
      code.push(`{const $_a=${pathExpr(n.path)};if(Array.isArray($_a)){for(let $_k=0;$_k<$_a.length;$_k++){const $_hv=S.${v},$_lo=S.loop;S.${v}=$_a[$_k];S.loop={index:$_k+1,first:$_k===0,last:$_k===$_a.length-1,length:$_a.length};`);
      compileNodes(n.body, code, ctx);
      code.push(`S.${v}=$_hv;S.loop=$_lo;}}}`);
    } else if (n.kind === 'include') {
      const k = ctx.index.get(n.name);
      if (k === undefined) {
        // No template of that name: renders nothing.
      } else if (ctx.cacheable[k]) {
        code.push(`C.c(${k},S,D+1,O);`);
      } else {
        const t = `$_t${ctx.n++}`;
        code.push(`{const ${t}=T[${k}];if(D<8&&${t})${t}(S,D+1,O,C,H,T);}`);
      }
    }
  }
}

function compileTemplate(nodes, ctx) {
  const code = ['const {e:E,x:X,y:Y,g:G}=H;'];
  compileNodes(nodes, code, ctx);
  return new Function('S', 'D', 'O', 'C', 'H', 'T', code.join(''));
}

const HELPERS = {
  e: esc,
  x: textOf,
  y: truthy,
  g: getOwn,
};

// A per-case engine: the compiled templates, the cache for site-wide
// renders, and the site-wide values themselves. Templates with identical
// source (the filler partials repeat) compile once per build.
function makeEngine(parsed, sources) {
  const names = [...parsed.keys()];
  const index = new Map(names.map((n, i) => [n, i]));
  const cacheable = new Array(names.length).fill(false);
  for (let i = 0; i < names.length; i++) {
    const ext = externalsOf(parsed.get(names[i]), parsed, new Set(), new Set([names[i]]));
    let ok = true;
    for (const e of ext) if (e !== 'site' && e !== 'tags' && e !== 'recent') { ok = false; break; }
    cacheable[i] = ok;
  }
  const ctx = { index, cacheable, n: 0 };
  const compiled = new Map();
  const fns = new Array(names.length);
  for (let i = 0; i < names.length; i++) {
    const src = sources.get(names[i]);
    let fn = compiled.get(src);
    if (fn === undefined) {
      fn = compileTemplate(parsed.get(names[i]), ctx);
      compiled.set(src, fn);
    }
    fns[i] = fn;
  }
  const cache = new Map();
  const engine = { fns, index, cacheable, cache, site: null, tags: null, recent: null };
  // A cached include: only when the scope still reads the site-wide values
  // (a loop could shadow site/tags/recent), and keyed by template and depth
  // (a render at a deeper level may lose its own includes to the depth cap).
  engine.c = (k, S, d, O) => {
    if (d > 8) return;
    const fn = fns[k];
    if (fn === undefined) return;
    if (S.site === engine.site && S.tags === engine.tags && S.recent === engine.recent) {
      const key = k * 16 + d;
      let s = cache.get(key);
      if (s === undefined) {
        const tmp = [];
        fn(S, d, tmp, engine, HELPERS, fns);
        s = tmp.join('');
        cache.set(key, s);
      }
      O.push(s);
      return;
    }
    fn(S, d, O, engine, HELPERS, fns);
  };
  engine.render = (name, vars) => {
    const k = index.get(name);
    if (k === undefined) return null;
    const O = [];
    fns[k](vars, 0, O, engine, HELPERS, fns);
    return O.join('');
  };
  return engine;
}

// ---------------------------------------------------------------- the build

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

// The words of a body: its runs of characters other than whitespace.
// Counted by hand instead of matching /\S+/g, which builds a throwaway
// array of every word. The whitespace set below is exactly JavaScript's
// \s: ASCII whitespace plus U+00A0, U+1680, U+2000-U+200A, U+2028,
// U+2029, U+202F, U+205F, U+3000 and U+FEFF.
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c <= 32) ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
    else if (c < 0xA0) ws = false;
    else ws = c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) || c === 0x2028
      || c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

export function run(input) {
  const slugify = makeSlugger();
  const report = [];
  const parsed = new Map();
  const tplSources = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    tplSources.set(name, input.templates[name]);
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const engine = makeEngine(parsed, tplSources);
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};
  const broken = new Set();

  // Sources, in code-unit order of their paths.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter and the refusal checks, in order.
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
    let own = undefined;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout !== undefined ? s.data.layout : (s.post ? 'post' : 'page');
    if (!parsed.has(layout)) {
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

  // Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, with links resolved to pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const resolved = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target[0] === '/' || target[0] === '#') return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      let path;
      if (rel === '') path = null;
      else {
        const key = `${dir}\n${rel}`;
        if (resolved.has(key)) path = resolved.get(key);
        else {
          path = resolvePath(dir, rel);
          resolved.set(key, path);
        }
      }
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, each named as first met in collection order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags !== undefined ? s.data.tags : []) {
      const slug = slugify(name);
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
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      const t = bySlug.get(slug);
      return t !== undefined ? t : { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date !== undefined ? s.data.date : '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date !== undefined ? s.data.date : '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary !== undefined ? s.data.summary : '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    // The tag objects themselves: templates only read name, slug and url
    // off them, so the small {name, slug, url} copies are unnecessary.
    tags: s.tagRefs,
  });
  // One card per kept source, built once and shared by its page, the index
  // and the tag pages (a post's card used to be rebuilt for its page).
  for (const s of kept) s.card = cardOf(s);
  const cards = new Map(posts.map((p) => [p, p.card]));
  const pageOf = (s) => {
    const c = s.card;
    return {
      title: c.title,
      url: c.url,
      date: c.date,
      date_long: c.date_long,
      summary: c.summary,
      excerpt: c.excerpt,
      reading_minutes: c.reading_minutes,
      tags: c.tags,
      slug: s.slug,
      content: s.html,
      // The toc entries already are {level, id, html}, exactly what the
      // page's toc holds; no copies needed.
      toc: s.toc,
      newer: linkOf(s.newer !== undefined && s.newer !== null ? s.newer : null),
      older: linkOf(s.older !== undefined && s.older !== null ? s.older : null),
      is_post: s.post,
    };
  };

  // Layouts.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  engine.site = site;
  engine.tags = allTags;
  engine.recent = recent;
  const topVars = (extra) => {
    const vars = Object.create(null);
    vars.site = site;
    vars.tags = allTags;
    vars.recent = recent;
    for (const k of Object.keys(extra)) vars[k] = extra[k];
    return vars;
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = engine.render(s.layout, topVars({ page: pageOf(s) }));
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = engine.render('index', topVars({
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    }));
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = engine.render('tag', topVars({
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    }));
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = engine.render('tags', topVars({}));
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report.
  for (const b of broken) report.push(b);
  report.sort(byCodeUnits);
  const lines = report;
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
