import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftRule, isDraftableRuleError, looksLikeToml } from '../lib/draft.js';
import { RuleError } from '../lib/rules.js';

const CONFIG = { maxOutputTokens: 12000, llmTimeoutMs: 5000 };

const TOML = [
  '[target]',
  'audience = "readers deciding whether to try the tool"',
  'anti_audience = "readers who only want a verdict"',
  'pandering = 3',
  '',
  '[[anti_patterns]]',
  'name = "Hype"',
  'description = "unsupported praise"',
  '',
  '[[requirements]]',
  'name = "Sources"',
  'instruction = "key claims cite a source"',
  'scope = "article"',
].join('\n');

function makeCtx(text, capture) {
  return {
    get: (service) =>
      service === 'llm'
        ? {
            stream(options) {
              if (capture !== undefined) capture.user = options.messages[0].content[0].text;
              return (async function* () {
                yield { type: 'text-delta', index: 0, text };
                yield { type: 'finish', reason: { kind: 'stop' } };
              })();
            },
          }
        : undefined,
  };
}

test('reads the rejected file as TOML or as prose', () => {
  assert.equal(looksLikeToml('[target]\naudience = "x"'), true);
  assert.equal(looksLikeToml('[[donts]]\ninstruction = "x"'), true);
  assert.equal(looksLikeToml('# Review spec\n- no hype'), false);
});

test('only TOML syntax failures are drafted around', () => {
  assert.equal(isDraftableRuleError(new RuleError('TOML parse failed: unexpected content')), true);
  assert.equal(isDraftableRuleError(new RuleError('target.audience: missing required field')), false);
  assert.equal(isDraftableRuleError(new Error('TOML parse failed')), false);
});

test('draftRule parses the model output, fences included', async () => {
  const drafted = await draftRule(makeCtx(`\`\`\`toml\n${TOML}\n\`\`\``), { provider: 'fake', model: 'fake' }, {
    article: 'A short article about installing the tool.',
    error: new RuleError('TOML parse failed: unexpected content'),
    sourcePath: '/tmp/notes.md',
    config: CONFIG,
  });

  assert.equal(drafted.spec.target.audience, 'readers deciding whether to try the tool');
  assert.equal(drafted.spec.antiPatterns.length, 1);
  assert.equal(drafted.spec.requirements[0].scope, 'article');
  assert.doesNotMatch(drafted.source, /```/);
});

test('an invalid draft reports both failures', async () => {
  await assert.rejects(
    draftRule(makeCtx('this is not toml'), { provider: 'fake', model: 'fake' }, {
      article: 'A short article.',
      error: new RuleError('TOML parse failed: unexpected content'),
      sourcePath: '/tmp/notes.md',
      config: CONFIG,
    }),
    /drafted rule was also invalid/,
  );
});

test('the rejected file is sent back for translation', async () => {
  const capture = {};
  await draftRule(makeCtx(TOML, capture), { provider: 'fake', model: 'fake' }, {
    article: 'Article body.',
    error: new RuleError('TOML parse failed: expected "="'),
    sourcePath: '/tmp/spec.md',
    source: '# Review spec\n- no hype\n- cite sources',
    config: CONFIG,
  });

  assert.match(capture.user, /no hype/);
  assert.match(capture.user, /Translate or repair it/);
});

test('a rejected file that is the article is not repeated', async () => {
  const capture = {};
  const body = '# Title\n\nBody text.';
  await draftRule(makeCtx(TOML, capture), { provider: 'fake', model: 'fake' }, {
    article: body,
    error: new RuleError('TOML parse failed: expected "="'),
    sourcePath: '/tmp/notes.md',
    source: body,
    config: CONFIG,
  });

  assert.match(capture.user, /\(the article itself\)/);
  assert.doesNotMatch(capture.user, /Body text\.\n\nBody text\./);
});
