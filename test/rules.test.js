import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRuleSource, RuleError } from '../lib/rules.js';

const here = dirname(fileURLToPath(import.meta.url));
const example = resolve(here, '../examples/rule.toml');

test('parses the shipped example rule file', async () => {
  const spec = parseRuleSource(await readFile(example, 'utf8'), { file: example });
  assert.equal(spec.target.audience.length > 0, true);
  assert.equal(spec.target.pandering, 3);
  assert.equal(spec.target.audienceLlm, 1);
  assert.equal(spec.antiPatterns.length, 1);
  assert.equal(spec.donts.length, 2);
  assert.equal(spec.donts[0].llm, 2);
  assert.equal(spec.donts[1].scope, 'paragraph');
  assert.equal(spec.requirements[1].scope, 'article');
  assert.equal(spec.scripts[0].path, resolve(dirname(example), 'scripts/no_first_person.py'));
});

test('defaults llm to one and accepts expression arrays', () => {
  const spec = parseRuleSource(`
[target]
audience = ["backend engineers", "familiar with SQL"]
pandering = 2.5

[[donts]]
instruction = "do not use empty adjectives"
`);
  assert.equal(spec.target.audience, 'backend engineers; familiar with SQL');
  assert.equal(spec.target.pandering, 2.5);
  assert.equal(spec.target.audienceLlm, 1);
  assert.equal(spec.donts[0].llm, 1);
  assert.equal(spec.donts[0].scope, 'paragraph');
});

test('requires an audience', () => {
  assert.throws(() => parseRuleSource('[target]\npandering = 3\n'), (error) => error instanceof RuleError && /audience/.test(error.message));
});

test('rejects unknown keys and fields', () => {
  assert.throws(() => parseRuleSource('[target]\naudience = "x"\nnope = 1\n'), /unknown field/);
  assert.throws(() => parseRuleSource('[target]\naudience = "x"\n[[donts]]\ninstruction = "x"\nextra = 1\n'), /unknown field/);
});

test('rejects out-of-range llm counts', () => {
  assert.throws(() => parseRuleSource('[target]\naudience = "x"\naudience_llm = 0\n'), /between 1 and 8/);
  assert.throws(() => parseRuleSource('[target]\naudience = "x"\n[[donts]]\ninstruction = "x"\nllm = 9\n'), /between 1 and 8/);
});

test('rejects scripts without exactly one source and validates the path', () => {
  assert.throws(() => parseRuleSource('[target]\naudience = "x"\n[[scripts]]\nname = "s"\n'), /path or code/);
  assert.throws(() => parseRuleSource('[target]\naudience = "x"\n[[scripts]]\npath = "missing.py"\ncode = "def check(t): return 0"\n'), /path or code/);
  assert.throws(
    () => parseRuleSource('[target]\naudience = "x"\n[[scripts]]\npath = "missing-script.py"\n', { file: resolve(here, 'placeholder.toml') }),
    /script file not found/,
  );
});

test('rejects an article scope on a script and a bad scope value', () => {
  const inline = resolve(here, 'inline.toml');
  assert.throws(
    () => parseRuleSource('[target]\naudience = "x"\n[[scripts]]\ncode = "def check(t): return 0"\nscope = "article"\n', { file: inline }),
    /unknown field/,
  );
  assert.throws(() => parseRuleSource('[target]\naudience = "x"\n[[donts]]\ninstruction = "x"\nscope = "global"\n'), /paragraph/);
});

test('reports TOML syntax errors as rule errors with the file name', () => {
  assert.throws(
    () => parseRuleSource('a = = 1\n', { file: '/tmp/bad.toml' }),
    (error) => error instanceof RuleError && error.message.includes('/tmp/bad.toml') && /TOML parse failed/.test(error.message),
  );
});

test('parses script filters', () => {
  const spec = parseRuleSource(`
[target]
audience = "x"

[[filters]]
name = "comments"
code = "def filter(text): return text.upper()"
`);
  assert.equal(spec.filters.length, 1);
  assert.equal(spec.filters[0].name, 'comments');
  assert.equal(spec.filters[0].code, 'def filter(text): return text.upper()');
});

test('rejects bad filter definitions', () => {
  assert.throws(() => parseRuleSource('[target]\naudience = "x"\n[[filters]]\nkind = "markdown"\n'), /unknown field/);
  assert.throws(() => parseRuleSource('[target]\naudience = "x"\n[[filters]]\n'), /path or code/);
  assert.throws(() => parseRuleSource('[target]\naudience = "x"\n[[filters]]\nname = ""\ncode = "x"\n'), /empty/);
});
