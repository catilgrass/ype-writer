import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../lib/index.js';

test('autoDraftRules defaults to true and rejects non-booleans', () => {
  assert.equal(normalizeConfig({}).autoDraftRules, true);
  assert.equal(normalizeConfig({ autoDraftRules: false }).autoDraftRules, false);
  assert.throws(() => normalizeConfig({ autoDraftRules: 'yes' }), /boolean/);
});
