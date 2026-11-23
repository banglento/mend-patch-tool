// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), applies its edits to the tree of text files rooted at the
// working directory, and writes every change or none. Node 22, standard
// library only. Run as: node main.ts [options] [PATCH]
//
// SPEC.md is the contract: sections 1-4 (invocation, output, files, format
// detection), 5 (three-tier line matching), 6 (unified diffs), 7
// (SEARCH/REPLACE), 8 (V4A), 9 (JSON edits), 10 (order and atomicity).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file split into lines the way SPEC.md section 3 says. */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A line as a tier sees it: exact, trailing spaces/tabs off, or both ends off. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every position where O occurs in lines at a tier, from `from` on; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from: number, endAtLast = false): number[] {
  const res: number[] = [];
  if (o.length === 0) return res;
  const keys = o.map((l) => tierKey(l, tier));
  for (let i = from; i + o.length <= lines.length; i++) {
    if (endAtLast && i + o.length !== lines.length) continue;
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (tierKey(lines[i + k]!, tier) !== keys[k]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier at which O occurs at least once from `from`, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from: number, endAtLast = false): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(lines, o, t, from, endAtLast);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to a single line at the first tier where one is. */
function findSingle(lines: string[], single: string, strict: boolean, from: number): number | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    for (let i = from; i < lines.length; i++) {
      if (tierKey(lines[i]!, t) === tierKey(single, t)) return i;
    }
  }
  return null;
}

/** One line of N: a context line points at its line of O, an added line carries its own text. */
interface NewLine {
  text: string;
  oIndex: number | null;
}

/** Build N's lines for a match at `at`: context lines come from the file, other lines are re-indented at tier 2. */
function buildReplacement(fileLines: string[], at: number, o: string[], n: NewLine[], tier: number): string[] {
  if (tier !== 2) {
    return n.map((e) => (e.oIndex !== null ? fileLines[at + e.oIndex]! : e.text));
  }
  const f = leadingWs(fileLines[at]!);
  const p = leadingWs(o[0]!);
  return n.map((e) => {
    if (e.oIndex !== null) return fileLines[at + e.oIndex]!;
    const t = e.text;
    if (t === '' || /^[ \t]*$/.test(t)) return t;
    if (t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- JSON edits (SPEC.md section 9) ----

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = parseFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, renderFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface HunkBodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noEol: boolean;
  rawEmpty: boolean;
}

interface Hunk {
  a: number;
  body: HunkBodyLine[];
}

interface Section {
  oldP: string | null | undefined;
  newP: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  isNewFile: boolean;
  isDeletedFile: boolean;
  hasPair: boolean;
  hasHunk: boolean;
  hunks: Hunk[];
}

function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

function diffPath(raw: string): string | null {
  const p = raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw;
  return p === '/dev/null' ? null : p;
}

function applyHunks(f: FileLines, hunks: Hunk[], strict: boolean, path: string): FileLines {
  let lines = f.lines.slice();
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    const n: NewLine[] = [];
    for (const b of h.body) {
      if (b.kind === 'ctx') {
        o.push(b.text);
        n.push({ text: b.text, oIndex: o.length - 1 });
      } else if (b.kind === 'old') {
        o.push(b.text);
      } else {
        n.push({ text: b.text, oIndex: null });
      }
    }
    let lastCtxNew: HunkBodyLine | undefined;
    for (let k = h.body.length - 1; k >= 0; k--) {
      const b = h.body[k]!;
      if (b.kind === 'ctx' || b.kind === 'new') {
        lastCtxNew = b;
        break;
      }
    }
    if (o.length > 0) {
      const found = findTier(lines, o, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const repl = buildReplacement(lines, best, o, n, found.tier);
      const atEnd = best + o.length === lines.length;
      lines = [...lines.slice(0, best), ...repl, ...lines.slice(best + o.length)];
      if (atEnd) final = !(lastCtxNew !== undefined && lastCtxNew.noEol);
    } else {
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = at === lines.length;
      lines = [...lines.slice(0, at), ...n.map((e) => e.text), ...lines.slice(at)];
      if (atEnd) final = !(lastCtxNew !== undefined && lastCtxNew.noEol);
    }
    d += n.length - o.length;
  }
  return { lines, br: f.br, final };
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.oldP !== undefined ? sec.oldP : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
  const newPath = sec.newP !== undefined ? sec.newP : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
  const isCreate = oldPath === null || sec.isNewFile;
  const isDelete = newPath === null || sec.isDeletedFile;
  if (isCreate) {
    const np = newPath;
    return (tree) => {
      if (np === undefined || np === null) throw new Fail('unsafe', '');
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const ls: string[] = [];
      let lastPlus: HunkBodyLine | undefined;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.kind === 'new') {
            ls.push(b.text);
            lastPlus = b;
          }
        }
      }
      const final = !(lastPlus !== undefined && lastPlus.noEol);
      tree.now.set(np, ls.length === 0 ? '' : ls.join('\n') + (final ? '\n' : ''));
    };
  }
  if (isDelete) {
    const op = oldPath;
    return (tree) => {
      if (op === undefined || op === null) throw new Fail('unsafe', '');
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
    };
  }
  if (oldPath !== newPath) {
    const op = oldPath as string;
    const np = newPath as string;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const cur = tree.get(op);
      if (cur === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(parseFile(cur), sec.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, renderFile(out));
      tree.moves.push([op, np]);
    };
  }
  const p = oldPath as string;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const out = applyHunks(parseFile(cur), sec.hunks, strict, p);
    tree.now.set(p, renderFile(out));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const startSection = (diffOld?: string, diffNew?: string): void => {
    const s: Section = {
      oldP: undefined,
      newP: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      diffOld,
      diffNew,
      isNewFile: false,
      isDeletedFile: false,
      hasPair: false,
      hasHunk: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1], m[2]);
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur === null || cur.hasPair || cur.hasHunk) startSection();
        cur!.oldP = diffPath(headerPath(line));
        cur!.newP = diffPath(headerPath(next));
        cur!.hasPair = true;
        i += 2;
        continue;
      }
      if (cur !== null && !cur.hasHunk) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
      cur.hunks.push(hunk);
      cur.hasHunk = true;
      i++;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1]!.startsWith('+++ ')) break;
        if (bl === '') {
          hunk.body.push({ kind: 'ctx', text: '', noEol: false, rawEmpty: true });
          i++;
          continue;
        }
        if (bl.startsWith(' ')) {
          hunk.body.push({ kind: 'ctx', text: bl.slice(1), noEol: false, rawEmpty: false });
          i++;
          continue;
        }
        if (bl.startsWith('-')) {
          hunk.body.push({ kind: 'old', text: bl.slice(1), noEol: false, rawEmpty: false });
          i++;
          continue;
        }
        if (bl.startsWith('+')) {
          hunk.body.push({ kind: 'new', text: bl.slice(1), noEol: false, rawEmpty: false });
          i++;
          continue;
        }
        if (bl.startsWith('\\')) {
          if (hunk.body.length > 0) hunk.body[hunk.body.length - 1]!.noEol = true;
          i++;
          continue;
        }
        break;
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.rawEmpty) hunk.body.pop();
        else break;
      }
      continue;
    }
    if (cur !== null && !cur.hasHunk) {
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line === 'rename from') {
        cur.renameFrom = '';
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line === 'rename to') {
        cur.renameTo = '';
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isNewFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDeletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = parseFile(cur);
    const found = findTier(f.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const n: NewLine[] = newLines.map((t) => ({ text: t, oIndex: null }));
    const repl = buildReplacement(f.lines, at, oldLines, n, found.tier);
    const out = [...f.lines.slice(0, at), ...repl, ...f.lines.slice(at + oldLines.length)];
    tree.now.set(path, renderFile({ lines: out, br: f.br, final: f.final }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), strict));
    prevReplace = rep;
    prevPath = path;
    i = rep + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NewLine[];
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, raw: Array<{ text: string; num: number }>, headerNum: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to:')) {
    moveTo = raw[0]!.text.slice('*** Move to:'.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let curChunk: V4aChunk | null = null;
  while (idx < raw.length) {
    const r = raw[idx]!;
    const l = r.text;
    if (l.startsWith('@@')) {
      const anchorText = l.slice(2).trim();
      curChunk = { anchor: anchorText === '' ? null : anchorText, eof: false, o: [], n: [] };
      chunks.push(curChunk);
      idx++;
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (curChunk === null) throw new Exit2(`error: parse ${r.num}`);
      curChunk.eof = true;
      curChunk = null;
      idx++;
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (curChunk === null) {
        if (chunks.length === 0) {
          curChunk = { anchor: null, eof: false, o: [], n: [] };
          chunks.push(curChunk);
        } else {
          throw new Exit2(`error: parse ${r.num}`);
        }
      }
      if (l === '') {
        curChunk.o.push('');
        curChunk.n.push({ text: '', oIndex: curChunk.o.length - 1 });
      } else if (l.startsWith(' ')) {
        const t = l.slice(1);
        curChunk.o.push(t);
        curChunk.n.push({ text: t, oIndex: curChunk.o.length - 1 });
      } else if (l.startsWith('-')) {
        curChunk.o.push(l.slice(1));
      } else {
        curChunk.n.push({ text: l.slice(1), oIndex: null });
      }
      idx++;
      continue;
    }
    throw new Exit2(`error: parse ${r.num}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerNum}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = parseFile(cur);
    let lines = f.lines.slice();
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        const a = findSingle(lines, c.anchor, strict, cursor);
        if (a === null) throw new Fail('no-match', path);
        cursor = a + 1;
      }
      if (c.o.length === 0) {
        const at = c.eof ? lines.length : cursor;
        lines = [...lines.slice(0, at), ...c.n.map((e) => e.text), ...lines.slice(at)];
        cursor = at + c.n.length;
      } else {
        const found = findTier(lines, c.o, strict, cursor, c.eof);
        if (found === null) throw new Fail('no-match', path);
        const at = found.occ[0]!;
        const repl = buildReplacement(lines, at, c.o, c.n, found.tier);
        lines = [...lines.slice(0, at), ...repl, ...lines.slice(at + c.o.length)];
        cursor = at + c.n.length;
      }
    }
    const out = renderFile({ lines, br: f.br, final: f.final });
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i++;
    if (i >= last) break;
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File:')) {
      kind = 'add';
      path = line.slice('*** Add File:'.length).trim();
    } else if (line.startsWith('*** Delete File:')) {
      kind = 'delete';
      path = line.slice('*** Delete File:'.length).trim();
    } else if (line.startsWith('*** Update File:')) {
      kind = 'update';
      path = line.slice('*** Update File:'.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerNum = i + 1;
    i++;
    const raw: Array<{ text: string; num: number }> = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:')) break;
      raw.push({ text: l, num: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (blank(r.text)) fileLines.push('');
        else throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push(v4aDeleteEdit(path));
    } else {
      edits.push(v4aUpdateEdit(path, raw, headerNum, strict));
    }
  }
  return edits;
}

// ---- Invocation (SPEC.md sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const moveOld = new Set<string>();
  const moveNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      moveOld.add(o);
      moveNew.add(n);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCompare)) {
    if (moveOld.has(p) || moveNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCompare)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
