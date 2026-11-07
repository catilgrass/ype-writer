// Temporary rule drafting. Some projects cannot keep a rule file next to the
// article: the document lives in a wiki, a ticket, or a branch that must stay
// clean. When the supplied rule file is not TOML, the model drafts a rule from
// the article, the check runs with it, and the draft is never written to disk.
// One retry exists because a near-miss field name is cheap to fix and a failed
// demo is expensive to explain; past that the bill stops.

import { dirname } from 'node:path';
import { callText, unfence } from './llm.js';
import { parseRuleSource, RuleError } from './rules.js';

const MAX_ATTEMPTS = 2;

// Only a syntax failure is worth drafting around. A rule that parses but names
// an unknown field is a real bug and must surface as one.
export function isDraftableRuleError(error) {
  return error instanceof RuleError && /TOML parse failed/.test(error.message);
}

// A file that already looks like TOML is being repaired; anything else is being
// translated into a rule. The distinction only affects the report warning.
export function looksLikeToml(text) {
  return /(^|\n)[ \t]*\[\[?[A-Za-z0-9_.-]+\]\]?[ \t]*$/mu.test(text) || /(^|\n)[ \t]*[A-Za-z0-9_.-]+[ \t]*=[ \t]*/mu.test(text);
}

function draftSystem() {
  return [
    'You draft a temporary rule.toml for exactly one article.',
    'The caller could not use their rule file, so this rule is generated once, used once, and never saved.',
    'Output TOML only: no code fences, no commentary.',
  ].join('\n');
}

// The skeleton spells out field names because anti_patterns uses description
// and donts/requirements use instruction; a model that swaps them wastes a call.
const SKELETON = [
  '[target]',
  'audience = "..."',
  'anti_audience = "..."',
  'pandering = 3',
  '',
  '[[anti_patterns]]',
  'name = "..."',
  'description = "..."',
  '',
  '[[donts]]',
  'name = "..."',
  'instruction = "..."',
  'scope = "paragraph"',
  '',
  '[[requirements]]',
  'name = "..."',
  'instruction = "..."',
  'scope = "article"',
].join('\n');

// The rejected file is fed back in full because a Markdown spec or a
// near-miss TOML is the best statement of intent the model will get; dropping
// it would force the draft to invent rules from the article instead of
// translating what the author already wrote.
function draftUser({ article, error, sourcePath, source, previousError }) {
  const body = article;
  const rejected = typeof source === 'string' ? source.trim() : '';
  const rejectedIsArticle = rejected.length > 0 && rejected === article.trim();
  const lines = [
    `Why a rule is needed: the rule file ${sourcePath} could not be parsed as TOML (${error.message}).`,
    '',
    'The file content that failed to parse:',
    '',
    rejected.length === 0 ? '(empty)' : rejectedIsArticle ? '(the article itself)' : rejected,
    '',
    'Translate or repair it: if the content states review requirements, even in prose or Markdown, turn them into the equivalent rule.toml entries faithfully. If it is not a rule (for example the article itself), infer the rules from the article instead.',
    '',
    'Article:',
    body,
    '',
    'Write 2-3 anti_patterns, 2-3 donts, and 2-3 requirements for this article.',
    'Use exactly this skeleton (keep the field names):',
    '',
    SKELETON,
    '',
    'Rules: names and instructions in the same language as the article; no [[scripts]], [[filters]], or llm keys; under 60 lines.',
  ];
  if (previousError !== undefined) {
    lines.push('', `Your previous answer was rejected with: ${previousError.message}`, 'Output corrected TOML only.');
  }
  return lines.join('\n');
}

// Two attempts maximum: the second one gets the validation error and usually
// fixes a field-name or missing-key miss without another round trip.
export async function draftRule(ctx, route, { article, error, sourcePath, source, config, signal }) {
  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const text = await callText(ctx, {
      route,
      label: 'rule drafting',
      system: draftSystem(),
      user: draftUser({ article, error, sourcePath, source, previousError: lastError }),
      maxTokens: Math.min(config.maxOutputTokens, 4000),
      timeoutMs: config.llmTimeoutMs,
      signal,
    });

    const candidate = unfence(text);
    try {
      const spec = parseRuleSource(candidate, { file: `${sourcePath} (generated)`, baseDir: dirname(sourcePath) });
      return { source: candidate, spec };
    } catch (draftError) {
      lastError = draftError;
    }
  }

  throw new Error(
    `rule file ${sourcePath} is not valid TOML (${error.message}); the drafted rule was also invalid (${lastError.message}). Fix the rule file or run without it.`,
  );
}
