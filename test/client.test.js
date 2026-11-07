import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

test('client module registers the tool card and the review panel', () => {
  const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');

  let registration;
  const context = { window: { __ModuleLoader__: { load(value) { registration = value; } } }, console };
  vm.createContext(context);
  vm.runInContext(source, context);

  assert.equal(registration.id, 'dsh-ype-writer');
  const React = {
    createElement: () => null,
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useSyncExternalStore: () => [],
  };
  const exports = registration.factory((specifier) => {
    if (specifier === 'react') return React;
    throw new Error(`unexpected require ${specifier}`);
  });

  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual(Array.from(exports.inject), ['slots', 'layout', 'locale']);

  const registered = [];
  const ctx = {
    effect: (fn) => fn(),
    locale: { register() {}, bind() { return (key) => key; } },
    slots: {
      inject(_name, factory) { factory(); },
      register(def, component) { registered.push({ def, component }); },
    },
    layout: { selectPanel() {} },
  };
  exports.apply(ctx);

  assert.equal(registered.length, 2);
  assert.deepEqual({ ...registered[0].def }, { name: 'tool.call.toolview', key: 'ype_check', locale: 'ype-writer' });
  assert.deepEqual({ ...registered[1].def }, { name: 'main', key: 'ype-review', locale: 'ype-writer' });
});
