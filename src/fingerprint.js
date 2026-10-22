// Structural fingerprints for top-level code units (functions, components, classes).
//
// Normalization is binding-aware, not textual: an identifier is "local" when the
// checker resolves it to a declaration inside the unit (renamed to L0, L1, ... by
// order of first appearance) and "free" otherwise (kept by name, and its resolved
// declaration recorded). Comments and formatting never reach the AST.
//
//   exact: structure + free names + literal values + type annotations
//   near:  structure + free names (literals and types abstracted away)
import crypto from "node:crypto";
import ts from "typescript";

const sha = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
const K = ts.SyntaxKind;

const LITERAL_KINDS = new Set([
  K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.NumericLiteral, K.BigIntLiteral,
  K.RegularExpressionLiteral, K.TemplateHead, K.TemplateMiddle, K.TemplateTail, K.JsxText,
]);

function isTypeNode(n) {
  // ts.isTypeNode also covers keyword types (string, number, ...). A class's
  // `extends Base` clause is runtime behavior, so it is not treated as a type.
  if (n.kind === K.ExpressionWithTypeArguments && n.parent && n.parent.kind === K.HeritageClause && n.parent.token === K.ExtendsKeyword && n.parent.parent && (n.parent.parent.kind === K.ClassDeclaration || n.parent.parent.kind === K.ClassExpression)) return false;
  return ts.isTypeNode(n) || n.kind === K.TypeParameter || n.kind === K.InterfaceDeclaration || n.kind === K.TypeAliasDeclaration ||
    (n.kind === K.HeritageClause && n.token === K.ImplementsKeyword);
}

function isPropertyNameIdentifier(id) {
  const p = id.parent;
  if (!p) return false;
  switch (p.kind) {
    case K.PropertyAccessExpression: return p.name === id;
    case K.QualifiedName: return p.right === id;
    case K.PropertyAssignment: case K.PropertyDeclaration: case K.PropertySignature:
    case K.MethodDeclaration: case K.MethodSignature: case K.GetAccessor: case K.SetAccessor:
    case K.EnumMember:
      return p.name === id;
    case K.JsxAttribute: return p.name === id;
    case K.BindingElement: return p.propertyName === id;
    case K.ImportSpecifier: case K.ExportSpecifier: return p.propertyName === id;
    case K.LabeledStatement: case K.BreakStatement: case K.ContinueStatement: return true;
    default: return false;
  }
}

function unwrap(e) {
  while (e && (e.kind === K.ParenthesizedExpression || e.kind === K.AsExpression || e.kind === K.SatisfiesExpression || e.kind === K.TypeAssertionExpression || e.kind === K.NonNullExpression)) e = e.expression;
  return e;
}

function isFunctionish(e) {
  e = unwrap(e);
  if (!e) return false;
  if (e.kind === K.ArrowFunction || e.kind === K.FunctionExpression || e.kind === K.ClassExpression) return true;
  // memo(...), forwardRef(...), React.memo(...), observer(...), etc.
  if (e.kind === K.CallExpression) return e.arguments.some((a) => isFunctionish(a));
  return false;
}

/** Top-level units of a source file: { name, declNode, bodyNode, nameNode } */
export function collectUnits(sf) {
  const out = [];
  for (const st of sf.statements) {
    if (st.kind === K.FunctionDeclaration && st.body) {
      out.push({ name: st.name ? st.name.text : "default", declNode: st, bodyNode: st, nameNode: st.name });
    } else if (st.kind === K.ClassDeclaration) {
      out.push({ name: st.name ? st.name.text : "default", declNode: st, bodyNode: st, nameNode: st.name });
    } else if (st.kind === K.VariableStatement) {
      for (const d of st.declarationList.declarations) {
        if (d.name.kind === K.Identifier && d.initializer && isFunctionish(d.initializer)) {
          out.push({ name: d.name.text, declNode: d, bodyNode: d.initializer, nameNode: d.name });
        }
      }
    } else if (st.kind === K.ExportAssignment && isFunctionish(st.expression)) {
      out.push({ name: "default", declNode: st, bodyNode: st.expression, nameNode: null });
    }
  }
  return out;
}

/**
 * Fingerprint one unit.
 * ctx.resolveFree(symbol, identifier) -> resolution key string for a free identifier.
 */
export function fingerprint(unit, sf, checker, ctx) {
  const node = unit.bodyNode;
  const start = node.getStart(sf);
  const end = node.end;
  const selfSym = unit.nameNode ? checker.getSymbolAtLocation(unit.nameNode) : null;
  const localIndex = new Map();
  const exact = [];
  const near = [];
  const literals = []; // [{v, len}]
  const free = new Map(); // name -> key
  let nodes = 0;

  const inside = (decl) => decl.getSourceFile() === sf && decl.pos >= node.pos && decl.end <= end;

  const symbolFor = (id) => {
    let s = checker.getSymbolAtLocation(id);
    if (!s && id.parent && id.parent.kind === K.ShorthandPropertyAssignment) s = checker.getShorthandAssignmentValueSymbol(id.parent);
    return s;
  };

  const visit = (n, inType) => {
    nodes++;
    const typeHere = inType || isTypeNode(n);
    if (typeHere && !inType) {
      // Types count for "exact" (as normalized text) but never for "near".
      exact.push("T:" + n.getText(sf).replace(/\s+/g, " "));
      return;
    }
    if (n.kind === K.Identifier || n.kind === K.PrivateIdentifier) {
      const text = n.text;
      if (isPropertyNameIdentifier(n)) { exact.push("P:" + text); near.push("P:" + text); return; }
      const sym = symbolFor(n);
      let tok;
      if (sym && selfSym && sym === selfSym) tok = "SELF";
      else if (sym && sym.declarations && sym.declarations.length && sym.declarations.every(inside)) {
        if (!localIndex.has(sym)) localIndex.set(sym, localIndex.size);
        tok = "L" + localIndex.get(sym);
      } else {
        tok = "F:" + text;
        if (!free.has(text)) free.set(text, ctx.resolveFree(sym, n));
      }
      if (n.parent && n.parent.kind === K.ShorthandPropertyAssignment) { exact.push("P:" + text); near.push("P:" + text); }
      exact.push(tok); near.push(tok);
      return;
    }
    if (LITERAL_KINDS.has(n.kind)) {
      const v = n.kind === K.JsxText ? n.text.replace(/\s+/g, " ").trim() : n.text;
      if (n.kind === K.JsxText && !v) return; // formatting-only JSX whitespace
      exact.push(`V${n.kind}:${v}`);
      near.push(`V${n.kind}`);
      literals.push({ v: v.length > 80 ? v.slice(0, 77) + "..." : v, len: v.length });
      return;
    }
    exact.push(String(n.kind)); near.push(String(n.kind));
    ts.forEachChild(n, (c) => visit(c, typeHere));
  };
  // At the unit root, `function f() {}`, `const f = function () {}` and
  // `const f = () => {}` normalize to the same shape (concise arrow bodies
  // become `{ return ...; }`). Nested functions keep their exact kind.
  const root = unwrap(node);
  if (root.kind === K.FunctionDeclaration || root.kind === K.FunctionExpression || root.kind === K.ArrowFunction) {
    const push = (t) => { exact.push(t); near.push(t); nodes++; };
    if (node !== root) exact.push("WRAP");
    push("FN");
    for (const m of root.modifiers || []) if (m.kind === K.AsyncKeyword) push("async");
    if (root.asteriskToken) push("gen");
    for (const tp of root.typeParameters || []) visit(tp, false);
    push("(");
    for (const p of root.parameters) visit(p, false);
    push(")");
    if (root.type) visit(root.type, false);
    if (root.body && root.body.kind === K.Block) visit(root.body, false);
    else if (root.body) { push(String(K.Block)); push(String(K.ReturnStatement)); visit(root.body, false); }
  } else {
    visit(node, false);
  }

  const lineStart = sf.getLineAndCharacterOfPosition(start);
  const lineEnd = sf.getLineAndCharacterOfPosition(end);
  // Similarity uses `near` with every local as the same token. Locals are
  // numbered by first use, so one added variable renumbers every later one and
  // a one-line change would otherwise rewrite most of the shingles after it.
  const sim = similaritySketch(near.map((t) => (/^L\d+$/.test(t) ? "L" : t)));
  return {
    shingles: sim.shingles,
    minhash: sim.minhash,
    exact: sha(exact.join("\u0001")),
    near: sha(near.join("\u0001")),
    nodes,
    lines: lineEnd.line - lineStart.line + 1,
    line: lineStart.line + 1,
    col: lineStart.character + 1,
    literals,
    free: Object.fromEntries([...free.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  };
}

// ---------- similarity sketch (for copies that are close but not identical) ----------
// k-token shingles of the "near" stream, and a 32-value MinHash over them, so
// similar units can be found without comparing every pair.
const SHINGLE_K = 5;
const MINHASH_N = 32;
const fnv = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
const SEEDS = Array.from({ length: MINHASH_N }, (_, i) => [fnv("a" + i) | 1, fnv("b" + i)]);

export function similaritySketch(tokens) {
  const ids = tokens.map(fnv);
  const set = new Set();
  for (let i = 0; i + SHINGLE_K <= ids.length; i++) {
    let h = 0x811c9dc5;
    for (let j = 0; j < SHINGLE_K; j++) { h ^= ids[i + j]; h = Math.imul(h, 0x01000193); }
    set.add(h >>> 0);
  }
  const shingles = Uint32Array.from(set).sort();
  const minhash = new Uint32Array(MINHASH_N).fill(0xffffffff);
  for (const x of shingles) for (let m = 0; m < MINHASH_N; m++) {
    const v = (Math.imul(SEEDS[m][0], x) + SEEDS[m][1]) >>> 0;
    if (v < minhash[m]) minhash[m] = v;
  }
  return { shingles, minhash };
}

/** Jaccard overlap of the literal values two units contain (1 when neither has literals). */
export function literalOverlap(a, b) {
  const A = new Set(a.literals.map((l) => (typeof l === "string" ? l : l.v))); const B = new Set(b.literals.map((l) => (typeof l === "string" ? l : l.v)));
  if (!A.size && !B.size) return 1;
  let inter = 0; for (const v of A) if (B.has(v)) inter++;
  return inter / (A.size + B.size - inter);
}

// LSH over the MinHash: 8 bands of 4 rows. Two units become candidates when any
// band is identical (about 98% of pairs at 0.8 Jaccard); candidates are then
// compared exactly. Shared by the scan and by lookups against the index.
export const LSH_BANDS = 8;
export const LSH_ROWS = 4;
export function lshBands(minhash) {
  const out = [];
  for (let b = 0; b < LSH_BANDS; b++) out.push(b + ":" + Array.from(minhash.slice(b * LSH_ROWS, b * LSH_ROWS + LSH_ROWS)).join(","));
  return out;
}

// Compact, deterministic encoding of uint32 arrays for the index (little-endian base64).
export function encodeU32(arr) {
  const buf = Buffer.alloc(arr.length * 4);
  arr.forEach((v, i) => buf.writeUInt32LE(v >>> 0, i * 4));
  return buf.toString("base64");
}
export function decodeU32(str) {
  const buf = Buffer.from(str, "base64");
  const out = new Uint32Array(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readUInt32LE(i * 4);
  return out;
}

/** Jaccard similarity of two sorted shingle arrays. */
export function jaccard(a, b) {
  let i = 0, j = 0, inter = 0;
  while (i < a.length && j < b.length) { if (a[i] === b[j]) { inter++; i++; j++; } else if (a[i] < b[j]) i++; else j++; }
  const union = a.length + b.length - inter;
  return union ? inter / union : 0;
}

/**
 * Standalone fingerprinting for code that is not part of the analyzed program
 * (a snippet, or a file just edited by an agent). Builds a one-file program so
 * local/free classification still comes from the checker, not from text.
 */
export function fingerprintStandalone(code, fileName = "snippet.tsx") {
  const opts = { allowJs: true, noLib: true, types: [], noEmit: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext };
  const sf0 = ts.createSourceFile(fileName, code, ts.ScriptTarget.ESNext, true, fileName.endsWith(".ts") ? ts.ScriptKind.TS : fileName.match(/\.[cm]?js$/) ? ts.ScriptKind.JS : fileName.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.TSX);
  const host = ts.createCompilerHost(opts, true);
  host.getSourceFile = (f) => (f === fileName ? sf0 : undefined);
  host.fileExists = (f) => f === fileName;
  host.readFile = (f) => (f === fileName ? code : undefined);
  host.writeFile = () => { throw new Error("read-only"); };
  host.resolveModuleNameLiterals = (lits) => lits.map(() => ({ resolvedModule: undefined }));
  const program = ts.createProgram({ rootNames: [fileName], options: opts, host });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(fileName);
  const ctx = { resolveFree: (sym, id) => (sym && sym.flags & ts.SymbolFlags.Alias ? "import:" + id.text : "name:" + id.text) };
  return collectUnits(sf).map((u) => ({ name: u.name, ...fingerprint(u, sf, checker, ctx) }));
}
