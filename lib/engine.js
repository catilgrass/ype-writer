// The check engine. Every scoring session is independent: audience and
// anti-audience sessions read the whole article, each rule gets its own
// session (or replicas), and script rules run deterministically. Replicas are
// averaged, and a failed replica degrades the report instead of the check: one
// bad model call must not erase the rest of the signal.

import { dirname } from 'node:path';
import { applyFilters } from './filters.js';
import { callJson, callText } from './llm.js';
import { runScriptRule } from './python.js';
import { closeness, mean, panderingIndex, qualityFromViolation, round1, toScore, weightedMean } from './scores.js';

// Audience closeness stays worth more than any single rule so a rule cannot
// outvote the question "was this written for its reader?".
const PANDER_WEIGHT = 3;
const RULE_WEIGHT = 1;

// Blank lines are the canonical separator; single newlines are the fallback
// because many editors and chat panes collapse blank lines on paste.
export function splitParagraphs(text, { maxParagraphs, maxParagraphChars }) {
  const normalized = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (normalized.length === 0) throw new Error('The article is empty');
  let blocks = normalized
    .split(/\n[ \t]*\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (blocks.length <= 1) {
    const lines = normalized
      .split('\n')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (lines.length > 1) blocks = lines;
  }

  const warnings = [];
  let truncated = false;
  const total = blocks.length;
  if (total > maxParagraphs) {
    truncated = true;
    warnings.push(`The article has ${total} paragraphs, more than maxParagraphs=${maxParagraphs}; only the first ${maxParagraphs} are scored`);
    blocks = blocks.slice(0, maxParagraphs);
  }
  const paragraphs = blocks.map((block, index) => {
    const body = block.length > maxParagraphChars ? `${block.slice(0, maxParagraphChars)}…` : block;
    if (body.length !== block.length) truncated = true;
    return { index: index + 1, text: body, chars: block.length };
  });
  return { paragraphs, truncated, warnings, totalParagraphs: total, totalChars: normalized.length };
}

// Order is preserved so parallel results can be read back side by side.
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function articleBlock(paragraphs) {
  return paragraphs.map((paragraph) => `[${paragraph.index}] ${paragraph.text}`).join('\n\n');
}

function paragraphEntries(payload) {
  const list = Array.isArray(payload) ? payload : isPlainObject(payload) && Array.isArray(payload.paragraphs) ? payload.paragraphs : [];
  return list.filter((entry) => isPlainObject(entry) && Number.isInteger(entry.index));
}

// Models occasionally invent paragraph indices; out-of-range ones are dropped
// rather than folded into the wrong paragraph.
function toParagraphScoreMap(payload, field, paragraphCount) {
  const scores = new Map();
  for (const entry of paragraphEntries(payload)) {
    if (entry.index < 1 || entry.index > paragraphCount) continue;
    const score = toScore(entry[field]);
    if (score !== null) scores.set(entry.index, score);
  }
  return scores;
}

function toParagraphHitMap(payload, paragraphCount) {
  const hits = new Map();
  for (const entry of paragraphEntries(payload)) {
    if (entry.index < 1 || entry.index > paragraphCount) continue;
    if (entry.hit === true || entry.hit === 'true') hits.set(entry.index, true);
  }
  return hits;
}

function toArticleScore(payload, field) {
  if (!isPlainObject(payload) || !isPlainObject(payload.article)) return null;
  return toScore(payload.article[field]);
}

// The prompts are deliberately blunt about the scale so two sessions converge
// on the same judgment; the JSON-only contract keeps parsing cheap.
const JSON_ONLY = 'Output JSON only: no code fences, no commentary.';

function audienceSystem() {
  return [
    'You are Ype!\'s "audience" scoring session. You judge only how well the text serves the target audience.',
    'Score each paragraph from 1 to 5:',
    "5 = fully matched to the audience's background, concerns, vocabulary, and information density;",
    '4 = mostly matched, a few generic spots;',
    '3 = readable for the audience, but no choices were made for them;',
    '2 = the audience needs extra background to keep up;',
    '1 = barely written for this audience.',
    JSON_ONLY,
  ].join('\n');
}

function antiSystem() {
  return [
    'You are Ype!\'s "anti-audience" scoring session. You judge only how easily the anti-audience still follows the text.',
    'Score each paragraph from 1 to 5:',
    '5 = the anti-audience reads it effortlessly;',
    '4 = mostly reads it;',
    '3 = needs some background;',
    '2 = mostly cannot follow it;',
    '1 = cannot follow the jargon, insider terms, or in-group framing at all.',
    JSON_ONLY,
  ].join('\n');
}

const PANDER_HINT = ' (1 = extremely in-group; 3 = both groups understand; 5 = over-explained even for the audience)';

function audienceUser({ audience, pandering, paragraphs }) {
  return [
    `Audience profile: ${audience}`,
    `Target pandering: ${pandering}${PANDER_HINT}`,
    `The article has ${paragraphs.length} paragraphs:`,
    articleBlock(paragraphs),
    '',
    'Output one integer score per paragraph (nothing else, no notes):',
    '{"paragraphs":[{"index":1,"score":4}]}',
  ].join('\n');
}

function antiUser({ antiAudience, pandering, paragraphs }) {
  return [
    `Anti-audience profile: ${antiAudience}`,
    `Target pandering: ${pandering}${PANDER_HINT}`,
    `The article has ${paragraphs.length} paragraphs:`,
    articleBlock(paragraphs),
    '',
    'Output one integer score per paragraph (nothing else, no notes):',
    '{"paragraphs":[{"index":1,"score":2}]}',
  ].join('\n');
}

function inferenceSystem() {
  return [
    'You are Ype!\'s "anti-audience inference" session.',
    'Given the audience profile and a sample of the article, infer the group that stands in sharpest contrast: least served by this article and most likely to miss its jargon.',
    'Output one 50-120 word description of that group: who they are, their background, and why they struggle to read this. No JSON, no title, no other text.',
  ].join('\n');
}

function inferenceUser({ audience, paragraphs }) {
  const sample = paragraphs
    .slice(0, 2)
    .map((paragraph) => paragraph.text)
    .join('\n\n');
  return [`Audience profile: ${audience}`, 'Article sample:', sample].join('\n\n');
}

function ruleSystem(kind) {
  const focus = kind === 'anti_pattern' ? 'anti-pattern' : kind === 'dont' ? "don't" : 'requirement';
  return [
    `You are Ype!'s "${focus}" scoring session. You handle exactly one rule per call.`,
    'Read the whole article first, then score that rule per paragraph (or for the whole article); every score must be grounded in the full context.',
    JSON_ONLY,
  ].join('\n');
}

const FIELD_BY_KIND = { dont: 'violation', requirement: 'compliance' };

function ruleScaleLines(kind) {
  if (kind === 'dont') {
    return ['Give an integer violation score from 1 to 5:', '5 = severe violation; 4 = clear violation; 3 = partial violation; 2 = minor violation; 1 = essentially no violation.'];
  }
  return ['Give an integer compliance score from 1 to 5:', '5 = fully met; 4 = mostly met; 3 = partly met; 2 = rarely met; 1 = hardly met.'];
}

function ruleUser({ rule, kind, paragraphs }) {
  if (kind === 'anti_pattern') {
    return [
      `Rule name: ${rule.name}`,
      `Anti-pattern: ${rule.description}`,
      `The article has ${paragraphs.length} paragraphs:`,
      articleBlock(paragraphs),
      '',
      'For each paragraph, return true when it hits this anti-pattern and false otherwise; when unsure, return false.',
      'Output (nothing else, no notes):',
      '{"paragraphs":[{"index":1,"hit":true}]}',
    ].join('\n');
  }

  const field = FIELD_BY_KIND[kind];
  const lines = [`Rule name: ${rule.name}`, `${kind === 'dont' ? 'Do not' : 'Requirement'}: ${rule.instruction}`, ...ruleScaleLines(kind)];

  if (rule.scope === 'article') {
    lines.push(
      '',
      `The article has ${paragraphs.length} paragraphs:`,
      articleBlock(paragraphs),
      '',
      'Score the whole article against this rule (not per paragraph):',
      'Output (nothing else, no notes):',
      `{"article":{"${field}":3}}`,
    );
    return lines.join('\n');
  }

  lines.push(
    '',
    `The article has ${paragraphs.length} paragraphs:`,
    articleBlock(paragraphs),
    '',
    'Score each paragraph; omit paragraphs where the rule does not apply.',
    'Output (nothing else, no notes):',
    `{"paragraphs":[{"index":1,"${field}":3}]}`,
  );
  return lines.join('\n');
}

// Replica averaging is what makes llm > 1 lower variance instead of just
// multiplying cost with correlated noise.
function combineMaps(maps) {
  const combined = new Map();
  for (const map of maps) {
    for (const [index, value] of map) {
      const list = combined.get(index) ?? [];
      list.push(value);
      combined.set(index, list);
    }
  }
  const result = new Map();
  for (const [index, list] of combined) result.set(index, mean(list));
  return result;
}

// Anti-patterns are boolean, so replicas vote: a paragraph is only zeroed when
// a majority agrees, which keeps one stray session from nuking a paragraph.
function combineHits(maps) {
  const counts = new Map();
  for (const map of maps) {
    for (const index of map.keys()) counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  const detected = new Map();
  for (const [index, count] of counts) {
    if (count * 2 > maps.length) detected.set(index, count);
  }
  return detected;
}

function formatStars(pandering) {
  return '⭐'.repeat(Math.max(1, Math.min(5, Math.round(pandering))));
}

function decimal(value) {
  return value === null || value === undefined ? '—' : String(round1(value));
}

function clip(text, length) {
  const compact = String(text).replace(/\s+/g, ' ').trim();
  return compact.length <= length ? compact : `${compact.slice(0, length)}…`;
}

function cell(value, length) {
  return clip(value, length).replace(/\|/g, '\\|');
}

// A check never throws for one failed session: partial data is more useful than
// no report, and the warnings section is where confidence is lost.
export async function runCheck({ ctx, route, spec, article, config, signal }) {
  const filtered = await applyFilters({ filters: spec.filters ?? [], text: article.text, config, signal });
  const split = splitParagraphs(filtered.text, {
    maxParagraphs: config.maxParagraphs,
    maxParagraphChars: config.maxParagraphChars,
  });
  const { paragraphs } = split;
  const warnings = [...split.warnings];
  const paragraphCount = paragraphs.length;
  const callOptions = { route, maxTokens: config.maxOutputTokens, timeoutMs: config.llmTimeoutMs, signal };

  let antiAudience = spec.target.antiAudience;
  let antiAudienceInferred = false;
  if (antiAudience === undefined || antiAudience.length === 0) {
    antiAudience = await callText(ctx, {
      ...callOptions,
      label: 'anti-audience inference',
      system: inferenceSystem(),
      user: inferenceUser({ audience: spec.target.audience, paragraphs }),
    });
    antiAudienceInferred = true;
  }

  const tasks = [];
  const pushReplicas = (count, build) => {
    for (let replica = 0; replica < count; replica += 1) tasks.push(build(replica));
  };

  pushReplicas(spec.target.audienceLlm, (replica) => {
    const label = `audience scoring #${replica + 1}`;
    return {
      kind: 'audience',
      label,
      run: async () => {
        const payload = await callJson(ctx, {
          ...callOptions,
          label,
          system: audienceSystem(),
          user: audienceUser({ audience: spec.target.audience, pandering: spec.target.pandering, paragraphs }),
        });
        return toParagraphScoreMap(payload, 'score', paragraphCount);
      },
    };
  });

  pushReplicas(spec.target.antiAudienceLlm, (replica) => {
    const label = `anti-audience scoring #${replica + 1}`;
    return {
      kind: 'anti',
      label,
      run: async () => {
        const payload = await callJson(ctx, {
          ...callOptions,
          label,
          system: antiSystem(),
          user: antiUser({ antiAudience, pandering: spec.target.pandering, paragraphs }),
        });
        return toParagraphScoreMap(payload, 'score', paragraphCount);
      },
    };
  });

  const pushRule = (rule, ruleKind) => {
    pushReplicas(rule.llm, (replica) => {
      const label = `${ruleKindLabel(ruleKind)} "${rule.name}" #${replica + 1}`;
      return {
        kind: 'rule',
        ruleKind,
        rule,
        label,
        run: async () => {
          const payload = await callJson(ctx, {
            ...callOptions,
            label,
            system: ruleSystem(ruleKind),
            user: ruleUser({ rule, kind: ruleKind, paragraphs }),
          });
          if (ruleKind === 'anti_pattern') return toParagraphHitMap(payload, paragraphCount);
          const field = FIELD_BY_KIND[ruleKind];
          if (rule.scope === 'article') return toArticleScore(payload, field);
          return toParagraphScoreMap(payload, field, paragraphCount);
        },
      };
    });
  };

  for (const rule of spec.antiPatterns) pushRule(rule, 'anti_pattern');
  for (const rule of spec.donts) pushRule(rule, 'dont');
  for (const rule of spec.requirements) pushRule(rule, 'requirement');

  const scriptTasks = spec.scripts.map((script) => ({
    script,
    run: () =>
      runScriptRule({
        script,
        paragraphs: paragraphs.map((paragraph) => paragraph.text),
        python: config.python,
        cwd: script.path === undefined ? config.ruleBaseDir : dirname(script.path),
        timeoutMs: config.scriptTimeoutMs,
        signal,
      }),
  }));

  const [llmResults, scriptRunResults] = await Promise.all([
    mapLimit(tasks, config.maxConcurrentLlm, async (task) => {
      try {
        return { task, ok: true, value: await task.run() };
      } catch (error) {
        return { task, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }),
    mapLimit(scriptTasks, Math.min(4, config.maxConcurrentLlm), async (task) => {
      try {
        return { task, ok: true, value: await task.run() };
      } catch (error) {
        return { task, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  ]);

  const audienceMaps = [];
  const antiMaps = [];
  const ruleReplicas = new Map();
  for (const result of llmResults) {
    if (!result.ok) {
      warnings.push(`${result.task.label} failed: ${result.error}`);
      continue;
    }
    const { task } = result;
    if (task.kind === 'audience') audienceMaps.push(result.value);
    else if (task.kind === 'anti') antiMaps.push(result.value);
    else {
      const entry = ruleReplicas.get(task.rule.id) ?? { rule: task.rule, ruleKind: task.ruleKind, values: [] };
      entry.values.push(result.value);
      ruleReplicas.set(task.rule.id, entry);
    }
  }

  const scriptScores = new Map();
  for (const result of scriptRunResults) {
    if (!result.ok) {
      warnings.push(`script rule "${result.task.script.name}" failed: ${result.error}`);
      continue;
    }
    for (const error of result.value.errors) {
      warnings.push(`script rule "${result.task.script.name}" paragraph ${error.index + 1}: ${error.message}`);
    }
    scriptScores.set(result.task.script.id, result.value.scores);
  }

  const anySignal = audienceMaps.length > 0 || antiMaps.length > 0 || ruleReplicas.size > 0 || scriptScores.size > 0;
  if (!anySignal && tasks.length + scriptTasks.length > 0) {
    const first = warnings.find((warning) => warning.includes('failed')) ?? 'no usable scoring results';
    throw new Error(`Every scoring session failed: ${first}`);
  }

  const audienceScores = combineMaps(audienceMaps);
  const antiScores = combineMaps(antiMaps);

  const rules = [];
  const paragraphRuleValues = new Map();
  const articleContributions = [];

  const summaryBase = (rule, kind) => ({
    id: rule.id,
    name: rule.name,
    kind,
    scope: kind === 'anti_pattern' ? 'paragraph' : rule.scope,
    llm: rule.llm,
    responses: 0,
    average: null,
    count: 0,
  });

  for (const rule of spec.antiPatterns) {
    const replicas = ruleReplicas.get(rule.id) ?? { values: [] };
    const detected = combineHits(replicas.values);
    const hits = paragraphs.filter((paragraph) => detected.has(paragraph.index)).map((paragraph) => paragraph.index);
    rules.push({
      ...summaryBase(rule, 'anti_pattern'),
      responses: replicas.values.length,
      average: hits.length === 0 ? 5 : 0,
      count: hits.length,
      hits,
    });
  }

  for (const rule of spec.donts) {
    const replicas = ruleReplicas.get(rule.id) ?? { values: [] };
    const summary = { ...summaryBase(rule, 'dont'), responses: replicas.values.length };
    if (rule.scope === 'article') {
      const averageViolation = mean(replicas.values.filter((value) => typeof value === 'number'));
      const quality = averageViolation === null ? null : qualityFromViolation(averageViolation);
      summary.average = quality;
      summary.count = averageViolation === null ? 0 : 1;
      summary.raw = averageViolation;
      if (quality !== null) articleContributions.push({ rule, quality });
    } else {
      const map = combineMaps(replicas.values);
      const averageViolation = mean([...map.values()]);
      summary.average = averageViolation === null ? null : qualityFromViolation(averageViolation);
      summary.count = map.size;
      summary.raw = averageViolation;
      paragraphRuleValues.set(rule.id, map);
    }
    rules.push(summary);
  }

  for (const rule of spec.requirements) {
    const replicas = ruleReplicas.get(rule.id) ?? { values: [] };
    const summary = { ...summaryBase(rule, 'requirement'), responses: replicas.values.length };
    if (rule.scope === 'article') {
      const averageCompliance = mean(replicas.values.filter((value) => typeof value === 'number'));
      summary.average = averageCompliance;
      summary.count = averageCompliance === null ? 0 : 1;
      summary.raw = averageCompliance;
      if (averageCompliance !== null) articleContributions.push({ rule, quality: averageCompliance });
    } else {
      const map = combineMaps(replicas.values);
      const averageCompliance = mean([...map.values()]);
      summary.average = averageCompliance;
      summary.count = map.size;
      summary.raw = averageCompliance;
      paragraphRuleValues.set(rule.id, map);
    }
    rules.push(summary);
  }

  for (const script of spec.scripts) {
    const scores = scriptScores.get(script.id);
    const observations = scores === undefined ? [] : scores.filter((value) => typeof value === 'number');
    const averageViolation = mean(observations);
    const summary = {
      id: script.id,
      name: script.name,
      kind: 'script',
      scope: 'paragraph',
      llm: 0,
      responses: scores === undefined ? 0 : 1,
      average: averageViolation === null ? null : qualityFromViolation(averageViolation),
      count: observations.length,
      raw: averageViolation,
    };
    rules.push(summary);
    if (scores !== undefined) paragraphRuleValues.set(script.id, new Map(scores.map((value, index) => [index + 1, value])));
  }

  const paragraphRows = paragraphs.map((paragraph) => {
    const audienceFit = audienceScores.get(paragraph.index) ?? null;
    const antiAudienceFit = antiScores.get(paragraph.index) ?? null;
    const measured = audienceFit !== null && antiAudienceFit !== null ? panderingIndex(audienceFit, antiAudienceFit) : null;
    const close = measured === null ? null : closeness(measured, spec.target.pandering);
    const antiPatternHits = rules
      .filter((rule) => rule.kind === 'anti_pattern' && rule.hits.includes(paragraph.index))
      .map((rule) => rule.name);

    const ruleScores = [];
    for (const rule of spec.donts) {
      if (rule.scope !== 'paragraph') continue;
      const value = paragraphRuleValues.get(rule.id)?.get(paragraph.index);
      if (value === undefined || value === null) continue;
      ruleScores.push({ id: rule.id, name: rule.name, kind: 'dont', raw: round1(value), quality: round1(qualityFromViolation(value)) });
    }
    for (const rule of spec.requirements) {
      if (rule.scope !== 'paragraph') continue;
      const value = paragraphRuleValues.get(rule.id)?.get(paragraph.index);
      if (value === undefined || value === null) continue;
      ruleScores.push({ id: rule.id, name: rule.name, kind: 'requirement', raw: round1(value), quality: round1(value) });
    }
    for (const script of spec.scripts) {
      const value = paragraphRuleValues.get(script.id)?.get(paragraph.index);
      if (value === undefined || value === null) continue;
      ruleScores.push({
        id: script.id,
        name: script.name,
        kind: 'script',
        raw: round1(value),
        quality: round1(qualityFromViolation(value)),
      });
    }

    let score;
    if (antiPatternHits.length > 0) {
      score = 0;
    } else {
      const parts = [];
      if (close !== null) parts.push({ value: close, weight: PANDER_WEIGHT });
      for (const ruleScore of ruleScores) {
        if (ruleScore.quality !== null) parts.push({ value: ruleScore.quality, weight: RULE_WEIGHT });
      }
      score = weightedMean(parts);
    }

    return {
      index: paragraph.index,
      preview: clip(paragraph.text, 40),
      audienceFit,
      antiAudienceFit,
      panderingIndex: measured,
      closeness: close,
      score: score === null ? null : round1(score),
      antiPatterns: antiPatternHits,
      ruleScores,
    };
  });

  const paragraphMean = mean(paragraphRows.map((row) => row.score));
  const overallParts = [];
  if (paragraphMean !== null) overallParts.push({ value: paragraphMean, weight: PANDER_WEIGHT });
  for (const contribution of articleContributions) overallParts.push({ value: contribution.quality, weight: RULE_WEIGHT });
  const overall = weightedMean(overallParts);
  const measuredPandering = mean(paragraphRows.map((row) => row.panderingIndex));

  const meta = {
    ruleFile: spec.file ?? '(inline)',
    audience: spec.target.audience,
    antiAudience,
    antiAudienceInferred,
    paragraphCount,
    model: `${route.provider}/${route.model}`,
    truncated: split.truncated,
    filters: filtered.applied,
    filterRemovedChars: filtered.removedChars,
  };

  const report = buildReport({
    score: overall === null ? null : round1(overall),
    paragraphMean,
    measuredPandering,
    spec,
    meta,
    paragraphs: paragraphRows,
    rules,
    warnings,
  });

  return {
    report,
    score: overall === null ? null : round1(overall),
    targetPandering: spec.target.pandering,
    measuredPandering,
    paragraphs: paragraphRows,
    rules,
    warnings,
    meta,
  };
}

function ruleKindLabel(kind) {
  if (kind === 'anti_pattern') return 'anti-pattern';
  if (kind === 'dont') return "don't";
  return 'requirement';
}

// The report is the product surface: every number the score is built from
// appears in it, so a reader can recompute the total without the engine.
function buildReport({ score, paragraphMean, measuredPandering, spec, meta, paragraphs, rules, warnings }) {
  const lines = [];
  lines.push('# Ype! Check Report');
  lines.push('');
  lines.push(`**Overall score: ${score === null ? '—' : score} / 5**`);
  if (paragraphMean !== null) lines.push(`Paragraph mean: ${round1(paragraphMean)} / 5; measured pandering: ${decimal(measuredPandering)} (target ${spec.target.pandering})`);
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Rule file | ${cell(meta.ruleFile, 100)} |`);
  lines.push(`| Audience | ${cell(meta.audience, 80)} |`);
  lines.push(`| Anti-audience | ${cell(meta.antiAudience, 80)}${meta.antiAudienceInferred ? ' (LLM-inferred)' : ''} |`);
  lines.push(`| Target pandering | ${formatStars(spec.target.pandering)} (${spec.target.pandering}) |`);
  lines.push(`| Paragraphs | ${meta.paragraphCount}${meta.truncated ? ' (truncated)' : ''} |`);
  lines.push(`| Model | ${meta.model} |`);
  if (meta.filters.length > 0) lines.push(`| Filters | ${meta.filters.join(', ')} (removed ${meta.filterRemovedChars} chars) |`);
  lines.push('');

  lines.push('## Paragraph scores');
  lines.push('');
  lines.push('| # | Opening | Audience | Anti-audience | Pandering index | Closeness | Rules (raw) | Score |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const paragraph of paragraphs) {
    const rulesText =
      paragraph.ruleScores.length === 0
        ? '—'
        : paragraph.ruleScores.map((ruleScore) => `${ruleScore.id}=${ruleScore.raw}`).join(' ');
    lines.push(
      `| ${paragraph.index} | ${cell(paragraph.preview, 24)} | ${formatInteger(paragraph.audienceFit)} | ${formatInteger(paragraph.antiAudienceFit)} | ${decimal(paragraph.panderingIndex)} | ${decimal(paragraph.closeness)} | ${rulesText} | ${decimal(paragraph.score)} |`,
    );
  }
  lines.push('');

  if (rules.length > 0) {
    lines.push('## Rules');
    lines.push('');
    for (const rule of rules) {
      const replicas = rule.llm > 0 ? `${rule.llm} LLM session(s)` : 'script rule';
      let detail;
      if (rule.kind === 'anti_pattern') {
        detail = rule.count === 0 ? 'no paragraph hit' : `hit ${rule.count} paragraph(s): ${rule.hits.join(', ')}`;
      } else if (rule.kind === 'script') {
        detail = rule.raw === null ? 'no usable result' : `mean violation ${decimal(rule.raw)} / 5 across ${rule.count} paragraph(s)`;
      } else if (rule.kind === 'dont') {
        detail = rule.raw === null ? 'no usable result' : `mean violation ${decimal(rule.raw)} / 5 (quality ${decimal(rule.average)})`;
        if (rule.scope === 'article') detail += ', whole-article';
      } else {
        detail = rule.raw === null ? 'no usable result' : `mean compliance ${decimal(rule.raw)} / 5`;
        if (rule.scope === 'article') detail += ', whole-article';
      }
      lines.push(`- **${rule.id} ${rule.name}** (${kindName(rule.kind)}, ${replicas}): ${detail}`);
    }
    lines.push('');
  }

  const problemParagraphs = paragraphs.filter((paragraph) => paragraph.antiPatterns.length > 0 || (paragraph.score !== null && paragraph.score <= 2.5));
  if (problemParagraphs.length > 0) {
    lines.push('## Paragraphs to look at');
    lines.push('');
    for (const paragraph of problemParagraphs) {
      const reasons = [];
      if (paragraph.antiPatterns.length > 0) reasons.push(`anti-pattern hit: ${paragraph.antiPatterns.join(', ')}`);
      if (paragraph.score === 0 && paragraph.antiPatterns.length === 0) reasons.push('scored 0');
      if (paragraph.closeness !== null && paragraph.closeness < 2.5) reasons.push(`pandering index ${decimal(paragraph.panderingIndex)} is off target ${spec.target.pandering}`);
      if (paragraph.ruleScores.length > 0) reasons.push(`rule raw scores ${paragraph.ruleScores.map((ruleScore) => `${ruleScore.id}=${ruleScore.raw}`).join(' ')}`);
      lines.push(`- Paragraph ${paragraph.index} (${decimal(paragraph.score)}): ${clip(paragraph.preview, 40)}`);
      lines.push(`  - ${reasons.join('; ')}`);
    }
    lines.push('');
  }

  if (warnings.length > 0) {
    lines.push('## Warnings');
    lines.push('');
    for (const warning of warnings) lines.push(`- ${warning}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function formatInteger(value) {
  return value === null || value === undefined ? '—' : String(value);
}

function kindName(kind) {
  if (kind === 'anti_pattern') return 'anti-pattern';
  if (kind === 'dont') return "don't";
  if (kind === 'requirement') return 'requirement';
  return 'script';
}
