import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp,
  closeness,
  mean,
  panderingIndex,
  qualityFromViolation,
  round1,
  toScore,
  weightedMean,
} from '../lib/scores.js';

test('pandering index interpolates between audience and anti-audience fit', () => {
  assert.equal(panderingIndex(5, 5), 3);
  assert.ok(Math.abs(panderingIndex(5, 1) - 1 - (4 * 5) / 6) < 1e-9);
  assert.ok(Math.abs(panderingIndex(1, 5) - (1 + 4 / 6)) < 1e-9);
  assert.equal(panderingIndex(0, 0), null);
});

test('closeness peaks at the target and falls linearly', () => {
  assert.equal(closeness(3, 3), 5);
  assert.equal(closeness(4, 3), 3);
  assert.equal(closeness(2, 3), 3);
  assert.equal(closeness(1, 3), 1);
  assert.equal(closeness(5, 3), 1);
  assert.equal(closeness(0.5, 3), 0);
  assert.equal(closeness(null, 3), null);
});

test('violation scores invert into quality scores', () => {
  assert.equal(qualityFromViolation(0), 5);
  assert.equal(qualityFromViolation(1), 5);
  assert.equal(qualityFromViolation(3), 3);
  assert.equal(qualityFromViolation(5), 1);
});

test('weighted mean ignores missing values and reports null when empty', () => {
  assert.equal(weightedMean([{ value: 2, weight: 3 }, { value: 4, weight: 1 }]), 2.5);
  assert.equal(weightedMean([{ value: null, weight: 3 }, { value: 4, weight: 1 }]), 4);
  assert.equal(weightedMean([]), null);
});

test('mean and rounding helpers', () => {
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(mean([null, 2]), 2);
  assert.equal(mean([]), null);
  assert.equal(round1(2.25), 2.3);
  assert.equal(round1(2.24), 2.2);
  assert.equal(clamp(9, 1, 5), 5);
});

test('model scores are rounded, clamped, and coerced from numeric strings', () => {
  assert.equal(toScore(4), 4);
  assert.equal(toScore(4.6), 5);
  assert.equal(toScore('3'), 3);
  assert.equal(toScore(0), 1);
  assert.equal(toScore(9), 5);
  assert.equal(toScore('x'), null);
  assert.equal(toScore(undefined), null);
});
