// The plugin surface: one model-facing tool (`ype_check`) plus an optional
// guidance skill. A check is driven by a reproducible TOML rule file, so the
// tool's job is mostly to resolve paths, validate arguments, and delegate to
// the engine. The skill is registered only when the profile provides a skill
// registry; headless profiles keep the tool alone.

import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { draftRule, isDraftableRuleError, looksLikeToml } from './draft.js';
import { runCheck } from './engine.js';
import { resolveModelRoute } from './llm.js';
import { parseRuleSource, RuleError } from './rules.js';

export const name = 'ype-writer';
export const inject = ['tools'];

const SKILL_FILE = fileURLToPath(new URL('../skills/ype-writer/SKILL.md', import.meta.url));
const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));

const DEFAULTS = {
  maxParagraphs: 80,
  maxParagraphChars: 2000,
  maxConcurrentLlm: 6,
  llmTimeoutMs: 180000,
  maxOutputTokens: 12000,
  python: 'python3',
  scriptTimeoutMs: 20000,
  autoDraftRules: true,
};

const LIMITS = {
  maxParagraphs: [1, 200],
  maxParagraphChars: [200, 20000],
  maxConcurrentLlm: [1, 16],
  llmTimeoutMs: [1000, 1800000],
  maxOutputTokens: [256, 32000],
  scriptTimeoutMs: [1000, 300000],
};

const KNOWN_KEYS = new Set([
  ...Object.keys(DEFAULTS),
  'autoDraftRules',
  'provider',
  'model',
  'reasoningEffort',
]);

// A typo in the row config must fail activation, not one unlucky check.
export function normalizeConfig(config) {
  const input = config ?? {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('ype-writer: config must be an object');
  for (const key of Object.keys(input)) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`ype-writer: unknown config field "${key}"`);
  }
  const resolved = { ...DEFAULTS };
  for (const [key, [low, high]] of Object.entries(LIMITS)) {
    if (input[key] === undefined) continue;
    const value = input[key];
    if (!Number.isInteger(value) || value < low || value > high) {
      throw new Error(`ype-writer: config.${key} must be an integer between ${low} and ${high}`);
    }
    resolved[key] = value;
  }
  if (input.python !== undefined) {
    if (typeof input.python !== 'string' || input.python.trim().length === 0) {
      throw new Error('ype-writer: config.python must be a non-empty string');
    }
    resolved.python = input.python.trim();
  }
  const hasProvider = input.provider !== undefined;
  const hasModel = input.model !== undefined;
  if (hasProvider !== hasModel) throw new Error('ype-writer: config.provider and config.model must be set together');
  if (hasProvider) {
    if (typeof input.provider !== 'string' || input.provider.trim().length === 0) throw new Error('ype-writer: config.provider must be a non-empty string');
    if (typeof input.model !== 'string' || input.model.trim().length === 0) throw new Error('ype-writer: config.model must be a non-empty string');
    resolved.provider = input.provider.trim();
    resolved.model = input.model.trim();
  }
  if (input.autoDraftRules !== undefined) {
    if (typeof input.autoDraftRules !== 'boolean') throw new Error('ype-writer: config.autoDraftRules must be a boolean');
    resolved.autoDraftRules = input.autoDraftRules;
  }
  if (input.reasoningEffort !== undefined) {
    if (typeof input.reasoningEffort !== 'string' || input.reasoningEffort.trim().length === 0) {
      throw new Error('ype-writer: config.reasoningEffort must be a non-empty string');
    }
    resolved.reasoningEffort = input.reasoningEffort.trim();
  }
  return resolved;
}

const nullOrNumber = { oneOf: [{ type: 'number' }, { type: 'null' }] };

const RULE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'kind', 'scope', 'llm', 'responses', 'average', 'count'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string', enum: ['anti_pattern', 'dont', 'requirement', 'script'] },
    scope: { type: 'string', enum: ['paragraph', 'article'] },
    llm: { type: 'integer' },
    responses: { type: 'integer' },
    average: nullOrNumber,
    count: { type: 'integer' },
    raw: nullOrNumber,
    hits: { type: 'array', items: { type: 'integer' } },
  },
};

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['report', 'score', 'targetPandering', 'measuredPandering', 'paragraphs', 'rules', 'warnings', 'meta'],
  properties: {
    report: { type: 'string' },
    score: nullOrNumber,
    targetPandering: { type: 'number' },
    measuredPandering: nullOrNumber,
    paragraphs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'preview', 'audienceFit', 'antiAudienceFit', 'panderingIndex', 'closeness', 'score', 'antiPatterns', 'ruleScores'],
        properties: {
          index: { type: 'integer' },
          preview: { type: 'string' },
          audienceFit: nullOrNumber,
          antiAudienceFit: nullOrNumber,
          panderingIndex: nullOrNumber,
          closeness: nullOrNumber,
          score: nullOrNumber,
          antiPatterns: { type: 'array', items: { type: 'string' } },
          ruleScores: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'name', 'kind', 'raw', 'quality'],
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                kind: { type: 'string', enum: ['dont', 'requirement', 'script'] },
                raw: { type: 'number' },
                quality: { type: 'number' },
              },
            },
          },
        },
      },
    },
    rules: { type: 'array', items: RULE_SCHEMA },
    warnings: { type: 'array', items: { type: 'string' } },
    meta: {
      type: 'object',
      additionalProperties: false,
      required: ['ruleFile', 'audience', 'antiAudience', 'antiAudienceInferred', 'paragraphCount', 'model', 'truncated', 'filters', 'filterRemovedChars', 'generated', 'generatedRule'],
      properties: {
        ruleFile: { type: 'string' },
        audience: { type: 'string' },
        antiAudience: { type: 'string' },
        antiAudienceInferred: { type: 'boolean' },
        paragraphCount: { type: 'integer' },
        model: { type: 'string' },
        truncated: { type: 'boolean' },
        filters: { type: 'array', items: { type: 'string' } },
        filterRemovedChars: { type: 'integer' },
        generated: { type: 'boolean' },
        generatedRule: { type: 'string' },
      },
    },
  },
};

const DESCRIPTION = [
  'Audit an article paragraph by paragraph against a reproducible TOML rule file and return a combined score.',
  'Audience and anti-audience sessions score each paragraph independently; every rule gets its own LLM session (replicas are averaged) and Python script rules run deterministically.',
  'Rules: required [target] audience = "..."; optional anti_audience (inferred by the LLM when omitted), pandering = 1-5, audience_llm / anti_audience_llm.',
  'Tables: [[anti_patterns]] description (a hit zeroes that paragraph); [[donts]] / [[requirements]] instruction with scope = "paragraph" (default) or "article"; [[scripts]] path or code (Python check(text)). Every LLM rule accepts llm = 1-8.',
  'Pass template instead of rule to run a bundled template (for example "health-science" or "zh_CN/health-science") without writing a file.',
  'When the rule file is not parseable TOML, a temporary rule is translated or repaired from that file and the article (one extra model call, two at most) and never written to disk; disable with autoDraftRules: false.',
].join('\n');

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    rule: {
      type: 'string',
      description: 'Path to the rule file (absolute or relative to the session working directory). All rules for one check come from this file.',
    },
    template: {
      type: 'string',
      description: 'Bundled template name such as "health-science" or "zh_CN/health-science". Use instead of rule to skip writing a file.',
    },
    text: {
      type: 'string',
      description: 'Full article text. Use instead of path.',
    },
    path: {
      type: 'string',
      description: 'Path to the article file (absolute or relative to the session working directory). Use instead of text.',
    },
  },
};

// Naming the path in the error is what lets a model recover without retrying
// with the same bad argument.
async function readTextFile(path, label) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${label} not found: ${path}`);
    if (error?.code === 'EISDIR') throw new Error(`${label} is a directory: ${path}`);
    throw new Error(`Cannot read ${label} ${path}: ${error?.message ?? error}`);
  }
}

// Templates ship with the package; resolving by name keeps checks reproducible
// and lets the tool accumulate reusable rule sets without touching the workspace.
function availableTemplates() {
  const names = [];
  for (const entry of readdirSync(TEMPLATES_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.toml')) {
      names.push(entry.name.slice(0, -5));
    } else if (entry.isDirectory()) {
      for (const inner of readdirSync(join(TEMPLATES_DIR, entry.name))) {
        if (inner.endsWith('.toml')) names.push(`${entry.name}/${inner.slice(0, -5)}`);
      }
    }
  }
  return names.sort();
}

function resolveTemplate(name) {
  const normalized = name.trim();
  const names = availableTemplates();
  if (!names.includes(normalized)) {
    throw new Error(`Unknown template "${normalized}". Available: ${names.join(', ')}`);
  }
  return join(TEMPLATES_DIR, `${normalized}.toml`);
}

// Tool-call arguments arrive untyped; validating here keeps the engine free of
// argument-shape branches and produces errors a model can act on.
function readArguments(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object');
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(PARAMETERS.properties, key)) {
      throw new Error(`Unknown argument "${key}" (allowed: ${Object.keys(PARAMETERS.properties).join(', ')})`);
    }
  }
  if (args.rule !== undefined && typeof args.rule !== 'string') throw new Error('Argument "rule" must be a string');
  if (args.template !== undefined && typeof args.template !== 'string') throw new Error('Argument "template" must be a string');
  if (args.text !== undefined && typeof args.text !== 'string') throw new Error('Argument "text" must be a string');
  if (args.path !== undefined && typeof args.path !== 'string') throw new Error('Argument "path" must be a string');
  const hasRule = typeof args.rule === 'string' && args.rule.trim().length > 0;
  const hasTemplate = typeof args.template === 'string' && args.template.trim().length > 0;
  if (hasRule === hasTemplate) throw new Error('Provide exactly one of "rule" (rule file) or "template" (bundled template name)');
  const hasText = typeof args.text === 'string' && args.text.trim().length > 0;
  const hasPath = typeof args.path === 'string' && args.path.trim().length > 0;
  if (hasText === hasPath) throw new Error('Provide exactly one of "text" or "path"');
  return {
    rule: hasRule ? args.rule.trim() : undefined,
    template: hasTemplate ? args.template.trim() : undefined,
    text: hasText ? args.text : undefined,
    path: hasPath ? args.path.trim() : undefined,
  };
}

// The skill frontmatter is a flat key/value block by design; a YAML dependency
// for four fields would not pay for itself.
function parseSkillDocument(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (match === null) return { meta: {}, content: raw.trim() };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z][\w-]*):\s*(.*)$/u.exec(line.trim());
    if (entry === null) continue;
    const value = entry[2].trim();
    if (value.length > 0) meta[entry[1]] = value;
  }
  return { meta, content: raw.slice(match[0].length).trim() };
}

// The machine-specific template path is appended at registration so the skill
// never has to guess where the package was installed.
function templateAppendix() {
  const names = availableTemplates();
  return [
    '',
    '## Bundled templates on this machine',
    '',
    `Template directory: ${TEMPLATES_DIR}`,
    '',
    ...names.map((name) => `- ${name} (${name.includes('/') ? name.split('/')[0] : 'en'})`),
    '',
  ].join('\n');
}

function registerSkill(ctx) {
  ctx.inject(['skills'], (scope) => {
    try {
      const { meta, content } = parseSkillDocument(readFileSync(SKILL_FILE, 'utf8'));
      scope.skills.register({
        name: meta.name ?? 'ype-writer',
        description: meta.description ?? 'Constrain a written article with a reproducible rule file, then score and iterate with ype_check',
        ...(meta.whenToUse === undefined ? {} : { whenToUse: meta.whenToUse }),
        source: 'dsh-ype-writer',
        content: `${content}\n${templateAppendix()}`,
      });
    } catch (error) {
      // The tool must keep working even when the skill cannot load.
      ctx.logger?.warn?.(`ype-writer: skill registration failed: ${error.message}`);
    }
  });
}

export function apply(ctx, config) {
  const settings = normalizeConfig(config);

  ctx.tools.register({
    name: 'ype_check',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.report }],
      // The report is for the model; the client panel needs the same numbers
      // without the Markdown, so the projection drops the rendered report.
      presentationMeta: (_args, value) => ({
        score: value.score,
        targetPandering: value.targetPandering,
        measuredPandering: value.measuredPandering,
        paragraphs: value.paragraphs,
        rules: value.rules,
        warnings: value.warnings,
        meta: value.meta,
      }),
    },
    async execute(args, exec) {
      const input = readArguments(args);
      const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
      const articleText = input.text !== undefined ? input.text : await readTextFile(resolve(cwd, input.path), 'article file');
      const rulePath = input.template === undefined ? resolve(cwd, input.rule) : resolveTemplate(input.template);
      const ruleSource = await readTextFile(rulePath, input.template === undefined ? 'rule file' : 'template');
      const route = resolveModelRoute(ctx, exec, settings);

      let spec;
      try {
        spec = parseRuleSource(ruleSource, { file: rulePath, baseDir: dirname(rulePath) });
      } catch (error) {
        if (!(error instanceof RuleError)) throw error;
        // A template is our own asset: a syntax error there is a bug, not a
        // reason to spend a model call. Validation errors are never drafted
        // around either; they point at a real mistake in a real rule.
        if (input.template !== undefined || !settings.autoDraftRules || !isDraftableRuleError(error)) {
          throw new Error(error.message);
        }
        const drafted = await draftRule(ctx, route, {
          article: articleText,
          error,
          sourcePath: rulePath,
          source: ruleSource,
          config: settings,
          signal: exec.signal,
        });
        spec = drafted.spec;
        spec.file = rulePath;
        spec.generated = { from: rulePath, source: drafted.source, error: error.message, repaired: looksLikeToml(ruleSource) };
      }
      return runCheck({
        ctx,
        route,
        spec,
        article: { text: articleText },
        config: { ...settings, ruleBaseDir: dirname(rulePath) },
        signal: exec.signal,
      });
    },
  });

  registerSkill(ctx);
}
