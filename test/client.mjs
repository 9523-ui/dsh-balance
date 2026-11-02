import assert from 'node:assert/strict';

const registered = [];
let loaded;
globalThis.window = {
  __ModuleLoader__: {
    load(info) {
      loaded = info;
    },
  },
};

const React = {
  Fragment: {},
  createElement: () => null,
  useCallback: (fn) => fn,
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
};
const modules = { react: React };

await import('../client.js');
assert.ok(loaded, 'client bundle must register a lazy factory');
assert.equal(loaded.id, '@local/dsh-balance');

const module = loaded.factory((name) => {
  assert.ok(name in modules, 'unexpected module request: ' + name);
  return modules[name];
});
assert.deepEqual(module.inject, ['slots', 'locale']);

const ctx = {
  effect(fn) {
    return fn();
  },
  locale: {
    register(namespace, dictionaries) {
      assert.equal(namespace, 'dsh-balance');
      assert.equal(typeof dictionaries.zh.label, 'string');
      assert.equal(typeof dictionaries.en.label, 'string');
      return () => {};
    },
    bind(namespace) {
      assert.equal(namespace, 'dsh-balance');
      return (key) => key;
    },
  },
  slots: {
    inject(owner, callback) {
      assert.equal(owner, 'conversation.composer.dock');
      return callback();
    },
    register(options, component) {
      registered.push({ options, component });
      return () => {};
    },
  },
};

module.apply(ctx);
assert.equal(registered.length, 1);
assert.equal(registered[0].options.name, 'conversation.composer.dock');
assert.equal(registered[0].options.id, 'dsh-balance');
assert.equal(typeof registered[0].component, 'function');

console.log('client wiring test passed');
