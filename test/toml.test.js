import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToml, TomlError } from '../lib/toml.js';

test('parses scalars, tables, and arrays of tables', () => {
  const doc = parseToml(`
# a comment
title = "hello"
count = 3
enabled = true
ratio = 1.5

[target]
audience = "engineers"

[[rules]]
name = "a"
weight = 1

[[rules]]
name = "b"
weight = 2
`);
  assert.deepEqual(doc, {
    title: 'hello',
    count: 3,
    enabled: true,
    ratio: 1.5,
    target: { audience: 'engineers' },
    rules: [
      { name: 'a', weight: 1 },
      { name: 'b', weight: 2 },
    ],
  });
});

test('parses dotted keys and quoted keys', () => {
  const doc = parseToml(`
a.b.c = 1
"quoted key" = "v"
[table."dotted.key"]
x = 2
`);
  assert.deepEqual(doc, {
    a: { b: { c: 1 } },
    'quoted key': 'v',
    table: { 'dotted.key': { x: 2 } },
  });
});

test('parses arrays with newlines, comments, and trailing commas', () => {
  const doc = parseToml(`
list = [
  1,
  2, # two
  3,
]
`);
  assert.deepEqual(doc.list, [1, 2, 3]);
});

test('parses inline tables', () => {
  const doc = parseToml('point = { x = 1, y = 2.5, name = "p" }');
  assert.deepEqual(doc.point, { x: 1, y: 2.5, name: 'p' });
});

test('parses basic escapes and multiline strings', () => {
  const doc = parseToml(`
escaped = "line\\nnext\\t\\u00e9"
literal = 'C:\\path\\no-escape'
multi = """
one \\
  two
three"""
raw = '''
raw \\
text'''
`);
  assert.equal(doc.escaped, 'line\nnext\té');
  assert.equal(doc.literal, 'C:\\path\\no-escape');
  assert.equal(doc.multi, 'one two\nthree');
  assert.equal(doc.raw, 'raw \\\ntext');
});

test('parses integers, floats, and special numbers', () => {
  const doc = parseToml(`
plain = 42
negative = -7
underscored = 1_000_000
hex = 0xFF
octal = 0o17
binary = 0b101
float = 2.5e2
inf = inf
nan = nan
`);
  assert.equal(doc.plain, 42);
  assert.equal(doc.negative, -7);
  assert.equal(doc.underscored, 1_000_000);
  assert.equal(doc.hex, 255);
  assert.equal(doc.octal, 15);
  assert.equal(doc.binary, 5);
  assert.equal(doc.float, 250);
  assert.equal(doc.inf, Infinity);
  assert.ok(Number.isNaN(doc.nan));
});

test('keeps dates as source text', () => {
  const doc = parseToml('day = 2026-01-02\nstamp = 2026-01-02T03:04:05Z');
  assert.equal(doc.day, '2026-01-02');
  assert.equal(doc.stamp, '2026-01-02T03:04:05Z');
});

test('rejects duplicate keys with a position', () => {
  assert.throws(
    () => parseToml('a = 1\na = 2\n'),
    (error) => error instanceof TomlError && /defined more than once/.test(error.message) && error.line === 2,
  );
});

test('rejects duplicate tables', () => {
  assert.throws(() => parseToml('[a]\nx = 1\n[a]\ny = 2\n'), /declared more than once/);
});

test('rejects malformed values and strings', () => {
  assert.throws(() => parseToml('a = nope\n'), /cannot recognize value/);
  assert.throws(() => parseToml('a = "unterminated'), /string is not closed/);
  assert.throws(() => parseToml('a = "bad \\q escape"\n'), /invalid escape/);
  assert.throws(() => parseToml('a = { x = 1, }\n'), /trailing comma/);
  assert.throws(() => parseToml('a = 1 b = 2\n'), /unexpected content after the key\/value/);
});
