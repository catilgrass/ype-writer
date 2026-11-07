import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runFilterScript } from '../lib/python.js';

const hasPython = spawnSync('python3', ['-V'], { stdio: 'ignore' }).status === 0;
const filtersDir = fileURLToPath(new URL('../filters/', import.meta.url));

function run(name, text) {
  return runFilterScript({
    script: { path: `${filtersDir}${name}.py` },
    text,
    python: 'python3',
    cwd: filtersDir,
    timeoutMs: 5000,
  });
}

test('comments filter keeps only // lines', { skip: !hasPython }, async () => {
  const out = await run('comments', 'const x = 1;\n// first comment\nsetup();\n// second comment\n');
  assert.equal(out, '// first comment\n\n// second comment');
});

test('markdown filter keeps prose and fenced contents', { skip: !hasPython }, async () => {
  const input = ['# Title', '', 'Intro with **bold** and [a link](https://example.test).', '', '---', '', '```text', 'install cmd', '```'].join('\n');
  const out = await run('markdown', input);
  assert.doesNotMatch(out, /# Title/);
  assert.doesNotMatch(out, /^---$/m);
  assert.match(out, /Intro with bold and a link\./);
  assert.match(out, /install cmd/);
});

test('code filter keeps only fenced blocks', { skip: !hasPython }, async () => {
  const input = 'Prose.\n\n```js\nconst x = 1;\n```\n\nMore prose.';
  assert.equal(await run('code', input), 'const x = 1;');
});
