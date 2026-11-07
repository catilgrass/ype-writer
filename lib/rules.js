// Rule model: parse TOML, validate strictly, normalise into what the engine
// consumes. Strictness is deliberate: a rule file is the reproducible half of a
// check, so unknown keys, typos, or wrong types must fail before any model call
// instead of silently changing the meaning of a score.

import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseToml, TomlError } from './toml.js';

// Carries the source file so errors from templates, examples, and user rules
// stay distinguishable when a session checks more than one article.
export class RuleError extends Error {
  constructor(message, file) {
    super(file === undefined ? message : `${file}: ${message}`);
    this.name = 'RuleError';
    this.file = file;
  }
}

const TARGET_KEYS = new Set(['audience', 'audience_llm', 'anti_audience', 'anti_audience_llm', 'pandering']);
const RULE_KEYS = {
  anti_patterns: new Set(['name', 'description', 'llm']),
  donts: new Set(['name', 'instruction', 'scope', 'llm']),
  requirements: new Set(['name', 'instruction', 'scope', 'llm']),
  scripts: new Set(['name', 'path', 'code']),
};
const MAX_RULES = { anti_patterns: 20, donts: 20, requirements: 20, scripts: 10 };
const MAX_LLM = 8;
const SCOPES = new Set(['paragraph', 'article']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(file, path, message) {
  throw new RuleError(`${path}: ${message}`, file);
}

function readString(file, path, value, { required = false, allowEmpty = false } = {}) {
  if (value === undefined) {
    if (required) fail(file, path, 'missing required field');
    return undefined;
  }
  if (typeof value !== 'string') fail(file, path, 'must be a string');
  const text = value.trim();
  if (!allowEmpty && text.length === 0) fail(file, path, 'must not be empty');
  return text;
}

// A profile can be given as one string or an array; joining keeps the prompt
// stable regardless of how the rule author formatted it.
function readExpression(file, path, value, { required = false } = {}) {
  if (value === undefined) {
    if (required) fail(file, path, 'missing required field');
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) fail(file, path, 'must be a non-empty array');
    const parts = value.map((entry, index) => readString(file, `${path}[${index}]`, entry, { required: true }));
    return parts.join('; ');
  }
  return readString(file, path, value, { required });
}

function readLlm(file, path, value) {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LLM) {
    fail(file, path, `must be an integer between 1 and ${MAX_LLM}`);
  }
  return value;
}

function readScope(file, path, value, { articleAllowed = true } = {}) {
  if (value === undefined) return 'paragraph';
  if (typeof value !== 'string' || !SCOPES.has(value)) fail(file, path, 'must be "paragraph" or "article"');
  if (!articleAllowed && value !== 'paragraph') fail(file, path, 'script rules only accept "paragraph"');
  return value;
}

function readRuleArray(file, path, value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(file, path, `must be an array (use [[${path}]])`);
  const cap = MAX_RULES[path];
  if (value.length > cap) fail(file, path, `at most ${cap} entries allowed`);
  return value;
}

function assertKeys(file, path, table, allowed) {
  for (const key of Object.keys(table)) {
    if (!allowed.has(key)) fail(file, `${path}.${key}`, `unknown field (allowed: ${[...allowed].join(' / ')})`);
  }
}

// Names appear in the report and must be unique, so a missing name falls back
// to the instruction text and duplicates gain a suffix.
function makeNamer() {
  const used = new Map();
  return (explicit, fallback) => {
    const base = explicit ?? fallback.trim().slice(0, 24) ?? '';
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    return count === 0 ? base : `${base} #${count + 1}`;
  };
}

export function normalizeRuleDocument(doc, { file, baseDir }) {
  if (!isPlainObject(doc)) fail(file, 'root', 'a rule file must be a TOML table');

  const allowedRoot = new Set(['target', ...Object.keys(RULE_KEYS)]);
  for (const key of Object.keys(doc)) {
    if (!allowedRoot.has(key)) fail(file, key, `unknown top-level table (allowed: ${[...allowedRoot].join(' / ')})`);
  }

  const targetValue = doc.target;
  if (targetValue !== undefined && !isPlainObject(targetValue)) fail(file, 'target', 'must be a table');
  const target = targetValue ?? {};
  assertKeys(file, 'target', target, TARGET_KEYS);
  const audience = readExpression(file, 'target.audience', target.audience, { required: true });
  const antiAudience = readExpression(file, 'target.anti_audience', target.anti_audience);
  const audienceLlm = readLlm(file, 'target.audience_llm', target.audience_llm);
  const antiAudienceLlm = readLlm(file, 'target.anti_audience_llm', target.anti_audience_llm);
  let pandering = 3;
  if (target.pandering !== undefined) {
    if (typeof target.pandering !== 'number' || !Number.isFinite(target.pandering) || target.pandering < 1 || target.pandering > 5) {
      fail(file, 'target.pandering', 'must be a number between 1 and 5');
    }
    pandering = target.pandering;
  }

  const namer = makeNamer();

  const antiPatterns = readRuleArray(file, 'anti_patterns', doc.anti_patterns).map((entry, index) => {
    const path = `anti_patterns[${index}]`;
    if (!isPlainObject(entry)) fail(file, path, 'must be a table');
    assertKeys(file, path, entry, RULE_KEYS.anti_patterns);
    const description = readString(file, `${path}.description`, entry.description, { required: true });
    return {
      id: `A${index + 1}`,
      name: namer(readString(file, `${path}.name`, entry.name), description),
      description,
      llm: readLlm(file, `${path}.llm`, entry.llm),
    };
  });

  const donts = readRuleArray(file, 'donts', doc.donts).map((entry, index) => {
    const path = `donts[${index}]`;
    if (!isPlainObject(entry)) fail(file, path, 'must be a table');
    assertKeys(file, path, entry, RULE_KEYS.donts);
    const instruction = readString(file, `${path}.instruction`, entry.instruction, { required: true });
    return {
      id: `D${index + 1}`,
      name: namer(readString(file, `${path}.name`, entry.name), instruction),
      instruction,
      scope: readScope(file, `${path}.scope`, entry.scope),
      llm: readLlm(file, `${path}.llm`, entry.llm),
    };
  });

  const requirements = readRuleArray(file, 'requirements', doc.requirements).map((entry, index) => {
    const path = `requirements[${index}]`;
    if (!isPlainObject(entry)) fail(file, path, 'must be a table');
    assertKeys(file, path, entry, RULE_KEYS.requirements);
    const instruction = readString(file, `${path}.instruction`, entry.instruction, { required: true });
    return {
      id: `R${index + 1}`,
      name: namer(readString(file, `${path}.name`, entry.name), instruction),
      instruction,
      scope: readScope(file, `${path}.scope`, entry.scope),
      llm: readLlm(file, `${path}.llm`, entry.llm),
    };
  });

  const scripts = readRuleArray(file, 'scripts', doc.scripts).map((entry, index) => {
    const path = `scripts[${index}]`;
    if (!isPlainObject(entry)) fail(file, path, 'must be a table');
    assertKeys(file, path, entry, RULE_KEYS.scripts);
    const hasPath = entry.path !== undefined;
    const hasCode = entry.code !== undefined;
    if (hasPath === hasCode) fail(file, path, 'provide exactly one of path or code');
    const name = readString(file, `${path}.name`, entry.name);
    const code = hasCode ? readString(file, `${path}.code`, entry.code, { required: true }) : undefined;
    let scriptPath;
    if (hasPath) {
      const raw = readString(file, `${path}.path`, entry.path, { required: true });
      scriptPath = isAbsolute(raw) ? raw : resolve(baseDir, raw);
      if (!existsSync(scriptPath) || !statSync(scriptPath).isFile()) {
        fail(file, `${path}.path`, `script file not found: ${scriptPath}`);
      }
    }
    return {
      id: `S${index + 1}`,
      name: namer(name, hasPath ? entry.path : `inline script ${index + 1}`),
      path: scriptPath,
      code,
      scope: 'paragraph',
    };
  });

  return {
    file,
    baseDir: baseDir ?? (file === undefined ? process.cwd() : dirname(file)),
    target: { audience, antiAudience, pandering, audienceLlm, antiAudienceLlm },
    antiPatterns,
    donts,
    requirements,
    scripts,
  };
}

// TOML errors lose their parser position when rethrown; keep the original
// message so a broken rule file is fixable without rerunning with debug output.
export function parseRuleSource(source, context = {}) {
  const file = context.file;
  const baseDir = context.baseDir ?? (file === undefined ? process.cwd() : dirname(file));
  let doc;
  try {
    doc = parseToml(source);
  } catch (error) {
    if (error instanceof TomlError) throw new RuleError(`TOML parse failed: ${error.message}`, file);
    throw error;
  }
  return normalizeRuleDocument(doc, { file, baseDir });
}
