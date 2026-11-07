import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRuleSource } from '../lib/rules.js';

const templatesDir = fileURLToPath(new URL('../templates/', import.meta.url));
const skillPath = fileURLToPath(new URL('../skills/ype-writer/SKILL.md', import.meta.url));

function templateNames(dir) {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.toml'))
    .map((file) => file.slice(0, -5))
    .sort();
}

test('every shipped template parses and declares an audience', () => {
  const languages = [templatesDir, join(templatesDir, 'zh_CN')];
  let count = 0;
  for (const dir of languages) {
    for (const name of templateNames(dir)) {
      const path = join(dir, `${name}.toml`);
      const spec = parseRuleSource(readFileSync(path, 'utf8'), { file: path, baseDir: dir });
      assert.ok(spec.target.audience.length > 0, `${name} must declare a non-empty audience`);
      assert.ok(spec.target.pandering >= 1 && spec.target.pandering <= 5, `${name} pandering out of range`);
      count += 1;
    }
  }
  assert.ok(count >= 12, `expected both language sets, found ${count} templates`);
});

test('the English and zh_CN template sets stay in sync', () => {
  assert.deepEqual(templateNames(templatesDir), templateNames(join(templatesDir, 'zh_CN')));
});

test('the bundled skill is English and carries frontmatter', () => {
  const raw = readFileSync(skillPath, 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  assert.ok(frontmatter, 'skill needs YAML frontmatter');
  assert.match(frontmatter[1], /^name:\s*ype-writer$/m);
  assert.match(frontmatter[1], /^description:\s*\S+/m);
  assert.match(raw, /ype_check/);
  assert.doesNotMatch(raw, /[\u4e00-\u9fff]/u, 'skill copy must be English');
});
