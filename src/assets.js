// Facts about stylesheets (CSS/SCSS) and locale message files (JSON). Pure
// functions over text; the analysis decides what is a finding. Read-only.
import postcss from "postcss";
import scss from "postcss-scss";
import { languageTag } from "./discover.js";

// Values that say nothing about shared design when they repeat.
const TRIVIAL_VALUES = new Set(["0", "0px", "none", "auto", "inherit", "initial", "unset", "normal", "transparent", "100%"]);
// A selector made only of element names, `*`, `:root`/`html`/`body` and pseudo-elements is a reset or base style.
const ELEMENT_ONLY_SELECTOR = /^(?:\*|[a-z][a-z0-9-]*|:root|::?[a-z-]+(?:\([^)]*\))?|\s|,|>|\+|~)+$/i;

export function normalizeValue(v) {
  return v.trim().replace(/\s+/g, " ").replace(/\s*([,()/])\s*/g, "$1").replace(/#[0-9a-f]{3,8}\b/gi, (h) => h.toLowerCase());
}

/**
 * Custom properties and declaration blocks of one stylesheet.
 * tokens: [{ name, value, line }]; blocks: [{ selector, signature, count, line }]
 * where `signature` is the block's declarations, normalized and sorted.
 */
export function parseStyle(text, file) {
  let root;
  try { root = (file.endsWith(".scss") ? scss : postcss).parse(text, { from: file }); }
  catch (e) { return { tokens: [], blocks: [], error: e.reason || e.message }; }
  const tokens = []; const blocks = [];
  const inKeyframes = (n) => { for (let p = n.parent; p; p = p.parent) if (p.type === "atrule" && /keyframes$/i.test(p.name)) return true; return false; };
  // Custom properties anywhere, including directly inside at-rules such as
  // Tailwind v4's `@theme { --color-x: ... }`. `--text-*: initial` is a
  // namespace reset, not a token.
  root.walkDecls((d) => {
    if (!d.prop.startsWith("--") || d.prop.includes("*") || inKeyframes(d)) return;
    tokens.push({ name: d.prop, value: normalizeValue(d.value), line: d.source && d.source.start ? d.source.start.line : 1 });
  });
  root.walkRules((rule) => {
    if (inKeyframes(rule)) return;
    const decls = (rule.nodes || []).filter((n) => n.type === "decl");
    const plain = decls.filter((d) => !d.prop.startsWith("--")).map((d) => `${d.prop.toLowerCase()}:${normalizeValue(d.value)}${d.important ? "!important" : ""}`);
    if (!plain.length) return;
    const trivial = plain.every((x) => TRIVIAL_VALUES.has(x.slice(x.indexOf(":") + 1)));
    const reset = ELEMENT_ONLY_SELECTOR.test(rule.selector.trim());
    blocks.push({ selector: rule.selector.replace(/\s+/g, " ").trim(), signature: [...new Set(plain)].sort().join(";"), count: new Set(plain).size, line: rule.source && rule.source.start ? rule.source.start.line : 1, trivial, reset });
  });
  return { tokens, blocks, error: null };
}

/** Flat key → string value pairs of a locale JSON file ("a.b.c": "text"). */
export function flattenMessages(text) {
  let json;
  try { json = JSON.parse(text); } catch (e) { return { pairs: null, error: e.message }; }
  const pairs = new Map();
  const walk = (v, prefix) => {
    if (typeof v === "string") { pairs.set(prefix, v); return; }
    if (v && typeof v === "object" && !Array.isArray(v)) for (const k of Object.keys(v)) walk(v[k], prefix ? `${prefix}.${k}` : k);
  };
  walk(json, "");
  return { pairs, error: null };
}

/** Language of a locale file from its name ("es.json", "pt-BR.json") or a directory ("locales/es/common.json"), or null. */
export function localeLanguage(rel) {
  const parts = rel.split("/");
  const base = languageTag(parts[parts.length - 1].replace(/\.json$/, ""));
  if (base) return base;
  for (let i = parts.length - 2; i >= 0; i--) { const t = languageTag(parts[i]); if (t) return t; }
  return null;
}
