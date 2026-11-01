const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { expect } = require('@playwright/test');

const specPath = path.join(__dirname, '../tests/browser/landing-page.spec.cjs');
const specSource = fs.readFileSync(specPath, 'utf8');
const missingDependencies = 'Host system is missing dependencies to run browsers.';

// Load the real spec, not a copied implementation of its availability policy.
// Each case gets isolated env, filesystem and Playwright registration doubles.
// No browser executable, network, or application server is used.
function loadSpec({ env = {}, installed = true, launchError, closeError, closeBarrier } = {}) {
  const hooks = [];
  const cases = [];
  const skips = [];
  const calls = { executablePath: 0, exists: [], launch: [], close: 0 };
  class Skip extends Error {}
  const register = (name, body) => cases.push({ name, body });
  register.beforeAll = hook => hooks.push(hook);
  register.skip = (condition, reason) => {
    skips.push({ condition, reason });
    // Playwright aborts a hook immediately when skip(true) is called.
    if (condition) throw new Skip(reason);
  };
  vm.runInNewContext(specSource, {
    __dirname: path.dirname(specPath),
    process: { env },
    require(name) {
      if (name === '@playwright/test') return { test: register, expect };
      if (name === 'node:path') return path;
      if (name === 'node:fs') return {
        readFileSync: fs.readFileSync,
        existsSync(file) {
          calls.exists.push(file);
          return installed;
        },
      };
      throw new Error(`Unexpected import in browser spec: ${name}`);
    },
  }, { filename: specPath });
  assert.equal(hooks.length, 1, 'the actual beforeAll hook must be registered');
  assert.ok(cases.length > 0, 'the actual browser assertions must be registered');

  const runtime = {
    executablePath() {
      calls.executablePath++;
      return '/isolated/bundled-browser';
    },
    async launch(options) {
      calls.launch.push(options);
      if (launchError) throw launchError;
      return {
        async close() {
          calls.close++;
          if (closeBarrier) await closeBarrier;
          if (closeError) throw closeError;
        },
      };
    },
  };
  return {
    calls, cases, skips, Skip,
    run(browserName, launchOptions = {}) {
      return hooks[0]({
        browserName,
        playwright: { chromium: runtime, firefox: runtime, webkit: runtime },
        launchOptions,
      });
    },
  };
}

for (const engine of ['firefox', 'webkit']) {
  test(`${engine}: missing bundled executable skips before launch`, async () => {
    const harness = loadSpec({ installed: false });
    await assert.rejects(harness.run(engine), error => error instanceof harness.Skip);
    assert.deepEqual(harness.calls.exists, ['/isolated/bundled-browser']);
    assert.equal(harness.calls.executablePath, 1);
    assert.equal(harness.calls.launch.length, 0);
    assert.equal(harness.calls.close, 0);
    assert.equal(harness.skips.length, 1);
    assert.equal(harness.skips[0].condition, true);
    assert.match(harness.skips[0].reason, new RegExp(`${engine} runtime not installed`));
    assert.ok(harness.skips[0].reason.includes(`playwright install ${engine}`));
  });

  test(`${engine}: exact Playwright host-dependency diagnostic skips`, async () => {
    // Playwright wraps this exact diagnostic in additional launch output.
    const launchError = new Error(`browserType.launch:\n╔════╗\n${missingDependencies}\n╚════╝`);
    const harness = loadSpec({ launchError });
    const options = { headless: true, timeout: 321 };
    await assert.rejects(harness.run(engine, options), error => error instanceof harness.Skip);
    assert.equal(harness.calls.launch.length, 1);
    assert.equal(harness.calls.launch[0], options);
    assert.equal(harness.calls.close, 0);
    assert.deepEqual(harness.skips.map(skip => skip.condition), [false, true]);
    assert.match(harness.skips[1].reason, new RegExp(`${engine} host libraries unavailable`));
    assert.ok(harness.skips[1].reason.includes(`playwright install --with-deps ${engine}`));
  });

  const failures = [
    ['generic launch crash', () => new Error('browserType.launch: Target page, context or browser has been closed')],
    ['launch timeout', () => Object.assign(new Error('browserType.launch: Timeout 30000ms exceeded'), { name: 'TimeoutError' })],
    ['generic dependency error', () => new Error('Missing host dependencies: libexample.so')],
    ['near-match diagnostic', () => new Error('Host system is missing dependencies to run browsers')],
    ['assertion failure', () => new assert.AssertionError({ message: 'download instruction assertion failed' })],
  ];
  for (const [label, makeError] of failures) {
    test(`${engine}: ${label} propagates unchanged, never skips`, async () => {
      const launchError = makeError();
      const harness = loadSpec({ launchError });
      await assert.rejects(harness.run(engine), error => error === launchError);
      assert.equal(harness.calls.launch.length, 1);
      assert.equal(harness.calls.close, 0);
      assert.deepEqual(harness.skips.map(skip => skip.condition), [false]);
    });
  }

  test(`${engine}: successful probe closes exactly once before returning`, async () => {
    const harness = loadSpec();
    const options = { headless: true, timeout: 123 };
    await harness.run(engine, options);
    assert.equal(harness.calls.launch.length, 1);
    assert.equal(harness.calls.launch[0], options);
    assert.equal(harness.calls.close, 1);
    assert.deepEqual(harness.skips.map(skip => skip.condition), [false]);
  });

  test(`${engine}: probe close failure propagates even with dependency wording`, async () => {
    const closeError = new Error(missingDependencies);
    const harness = loadSpec({ closeError });
    await assert.rejects(harness.run(engine), error => error === closeError);
    assert.equal(harness.calls.close, 1);
    assert.deepEqual(harness.skips.map(skip => skip.condition), [false]);
  });

  test(`${engine}: successful hook awaits asynchronous browser cleanup`, async () => {
    let release;
    const closeBarrier = new Promise(resolve => { release = resolve; });
    const harness = loadSpec({ closeBarrier });
    let finished = false;
    const pending = harness.run(engine).then(() => { finished = true; });
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(harness.calls.close, 1);
      assert.equal(finished, false, 'hook must not finish while close is pending');
    } finally {
      release();
      await pending;
    }
    assert.equal(finished, true);
  });

  test(`${engine}: page assertion after a successful probe fails, never skips`, async () => {
    const harness = loadSpec();
    await harness.run(engine);
    const skipCount = harness.skips.length;
    // Execute an actual registered test body. Its first assertion verifies the
    // selected engine; deliberately violating it must not become an engine skip.
    await assert.rejects(harness.cases[0].body({
      browserName: engine,
      context: { browser: () => ({ browserType: () => ({ name: () => 'wrong-engine' }) }) },
    }), error => {
      assert.ok(!(error instanceof harness.Skip));
      assert.match(error.message, /wrong-engine/);
      return true;
    });
    assert.equal(harness.calls.close, 1);
    assert.equal(harness.skips.length, skipCount);
  });

  for (const strictValue of ['0', 'true', '']) {
    test(`${engine}: strict flag ${JSON.stringify(strictValue)} does not require engines`, async () => {
      const harness = loadSpec({
        env: { LANDING_PAGE_REQUIRE_ALL_BROWSERS: strictValue },
        installed: false,
      });
      await assert.rejects(harness.run(engine), error => error instanceof harness.Skip);
    });
  }
}

const mandatory = [
  { label: 'Chromium', engines: ['chromium'] },
  {
    label: 'explicit executable override',
    engines: ['chromium', 'firefox', 'webkit'],
    launchOptions: { executablePath: '/isolated/explicit-browser' },
  },
  {
    label: 'strict all-browser mode',
    engines: ['chromium', 'firefox', 'webkit'],
    env: { LANDING_PAGE_REQUIRE_ALL_BROWSERS: '1' },
  },
];
for (const { label, engines, env, launchOptions } of mandatory) {
  for (const engine of engines) {
    for (const installed of [false, true]) {
      test(`${label} (${engine}, installed=${installed}) bypasses all optional skip handling`, async () => {
        const harness = loadSpec({
          env, installed, launchError: new Error(missingDependencies),
        });
        await harness.run(engine, launchOptions);
        // Mandatory engines are launched by Playwright's normal browser fixture,
        // outside this hook. Neither filesystem checks nor an availability probe
        // may intercept their missing-runtime or launch failures.
        assert.deepEqual(harness.skips, []);
        assert.deepEqual(harness.calls, {
          executablePath: 0, exists: [], launch: [], close: 0,
        });
      });
    }
  }
}
