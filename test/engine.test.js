import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { splitParagraphs, mapLimit, runCheck } from '../lib/engine.js';

const hasPython = spawnSync('python3', ['-V'], { stdio: 'ignore' }).status === 0;

const CONFIG = {
  maxParagraphs: 40,
  maxParagraphChars: 2000,
  maxConcurrentLlm: 4,
  llmTimeoutMs: 5000,
  maxOutputTokens: 512,
  python: 'python3',
  scriptTimeoutMs: 5000,
  ruleBaseDir: process.cwd(),
};

const ARTICLE = {
  text: 'Indexes are not free: every extra index slows writes down.\n\nThis analysis is for context only and is not a change recommendation.',
};

function json(value) {
  return JSON.stringify(value);
}

// One fake model routes by the session system prompt, which is the only stable
// discriminator the engine exposes to a stub.
function createFakeLlm({ failRuleName } = {}) {
  const calls = [];
  const counts = new Map();
  return {
    calls,
    stream(options) {
      return (async function* () {
        const system = options.system;
        const user = options.messages[0].content[0].text;
        calls.push({ system, user });
        let text;
        if (system.includes('anti-audience inference')) {
          text = 'Product managers with no database experience who do not care about technical detail.';
        } else if (system.includes('"anti-audience" scoring')) {
          text = json({ paragraphs: [{ index: 1, score: 1 }, { index: 2, score: 5 }] });
        } else if (system.includes('"audience" scoring')) {
          text = json({ paragraphs: [{ index: 1, score: 5 }, { index: 2, score: 3 }] });
        } else if (system.includes('"anti-pattern" scoring')) {
          text = json({ paragraphs: [{ index: 2, hit: true }] });
        } else if (system.includes('"don\'t" scoring')) {
          const name = /Rule name: (.+)/.exec(user)?.[1]?.trim() ?? 'unknown';
          if (failRuleName !== undefined && name === failRuleName) throw new Error('simulated session failure');
          const seen = counts.get(name) ?? 0;
          counts.set(name, seen + 1);
          const violation = seen === 0 ? 2 : 4;
          text = json({ paragraphs: [{ index: 1, violation }, { index: 2, violation: 5 }] });
        } else if (system.includes('"requirement" scoring')) {
          text = json({ article: { compliance: 4 } });
        } else {
          throw new Error(`unexpected scoring session: ${system}`);
        }
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

function makeCtx(llm) {
  return { get: (service) => (service === 'llm' ? llm : undefined) };
}

const SPEC = {
  file: '/tmp/rule.toml',
  baseDir: process.cwd(),
  target: { audience: 'experienced backend engineers', antiAudience: undefined, pandering: 3, audienceLlm: 1, antiAudienceLlm: 1 },
  antiPatterns: [{ id: 'A1', name: 'Disclaimer', description: 'language that disclaims responsibility', llm: 1 }],
  donts: [{ id: 'D1', name: 'Empty adjectives', instruction: 'do not use adjectives without information', scope: 'paragraph', llm: 2 }],
  requirements: [{ id: 'R1', name: 'Clear conclusion', instruction: 'end with an actionable conclusion', scope: 'article', llm: 1 }],
  scripts: [
    {
      id: 'S1',
      name: 'Index check',
      code: 'def check(text):\n    return 0 if "index" in text.lower() else None\n',
      scope: 'paragraph',
    },
  ],
};

test('splitParagraphs prefers blank lines and falls back to newlines', () => {
  assert.equal(splitParagraphs('a\n\nb', { maxParagraphs: 10, maxParagraphChars: 100 }).paragraphs.length, 2);
  assert.equal(splitParagraphs('a\nb', { maxParagraphs: 10, maxParagraphChars: 100 }).paragraphs.length, 2);
  const truncated = splitParagraphs('a\n\nb\n\nc', { maxParagraphs: 2, maxParagraphChars: 100 });
  assert.equal(truncated.paragraphs.length, 2);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.warnings.length, 1);
  assert.throws(() => splitParagraphs('   \n\n  ', { maxParagraphs: 10, maxParagraphChars: 100 }), /empty/);
});

test('mapLimit bounds concurrency and preserves order', async () => {
  let active = 0;
  let peak = 0;
  const output = await mapLimit([1, 2, 3, 4, 5], 2, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return item * 2;
  });
  assert.deepEqual(output, [2, 4, 6, 8, 10]);
  assert.equal(peak, 2);
});

test('one check runs per-rule sessions, replicates them, and averages replicas', { skip: !hasPython }, async () => {
  const llm = createFakeLlm();
  const result = await runCheck({
    ctx: makeCtx(llm),
    route: { provider: 'fake', model: 'fake' },
    spec: SPEC,
    article: ARTICLE,
    config: CONFIG,
  });

  // One inferred anti-audience, one audience, one anti-audience, one
  // anti-pattern, two don't replicas, one article requirement.
  assert.equal(llm.calls.filter((call) => call.system.includes('anti-audience inference')).length, 1);
  assert.equal(llm.calls.filter((call) => call.system.includes('"audience" scoring')).length, 1);
  assert.equal(llm.calls.filter((call) => call.system.includes('"don\'t" scoring')).length, 2);

  // An article-scope rule must actually read the article it scores.
  const articleRuleCall = llm.calls.find((call) => call.system.includes('"requirement" scoring'));
  assert.ok(articleRuleCall, 'article requirement session should run');
  assert.match(articleRuleCall.user, /Indexes are not free/);
  assert.match(articleRuleCall.user, /not a change recommendation/);

  const first = result.paragraphs[0];
  assert.equal(first.audienceFit, 5);
  assert.equal(first.antiAudienceFit, 1);
  assert.ok(Math.abs(first.panderingIndex - (1 + (4 * 5) / 6)) < 1e-9);
  // (closeness 2.333 * 3 + don't quality 3 + script quality 5) / 5 = 3.0
  assert.equal(first.score, 3);

  const second = result.paragraphs[1];
  assert.equal(second.score, 0);
  assert.deepEqual(second.antiPatterns, ['Disclaimer']);

  const dont = result.rules.find((rule) => rule.id === 'D1');
  assert.equal(dont.responses, 2);
  assert.equal(dont.raw, 4); // (3 + 5) / 2
  assert.equal(dont.average, 2); // 6 - 4

  const script = result.rules.find((rule) => rule.id === 'S1');
  assert.equal(script.count, 1);
  assert.equal(script.raw, 0);

  // (paragraph mean 1.5 * 3 + article requirement 4) / 4 = 2.125
  assert.equal(result.score, 2.1);
  assert.match(result.report, /Overall score: 2\.1/);
  assert.match(result.report, /Disclaimer/);
  assert.equal(result.meta.antiAudienceInferred, true);
});

test('a rule whose sessions all fail drops out with warnings, not a failed check', { skip: !hasPython }, async () => {
  const spec = {
    ...SPEC,
    target: { ...SPEC.target, antiAudience: 'product managers with no technical background' },
    antiPatterns: [],
    requirements: [],
    scripts: [],
    donts: [
      { id: 'D1', name: 'Empty adjectives', instruction: 'do not use adjectives without information', scope: 'paragraph', llm: 1 },
      { id: 'D2', name: 'Always fails', instruction: 'this rule always fails', scope: 'paragraph', llm: 2 },
    ],
  };
  const llm = createFakeLlm({ failRuleName: 'Always fails' });
  const result = await runCheck({
    ctx: makeCtx(llm),
    route: { provider: 'fake', model: 'fake' },
    spec,
    article: ARTICLE,
    config: CONFIG,
  });

  assert.equal(llm.calls.filter((call) => call.system.includes('anti-audience inference')).length, 0);
  assert.equal(result.warnings.filter((warning) => /simulated session failure/.test(warning)).length, 2);

  const failed = result.rules.find((rule) => rule.id === 'D2');
  assert.equal(failed.responses, 0);
  assert.equal(failed.average, null);

  const dont = result.rules.find((rule) => rule.id === 'D1');
  assert.equal(dont.responses, 1);
  assert.equal(dont.raw, 3.5); // (2 + 5) / 2

  // (2.75 + 3.25) / 2 = 3.0
  assert.equal(result.score, 3);
});
