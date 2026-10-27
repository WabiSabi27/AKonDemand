const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  checkPublishedPaymentReturn, originFromDeploymentMetadata, runCli,
} = require('../scripts/check-published-payment-return.cjs');

function metadata(overrides = {}) {
  return {
    retrievedAt: new Date().toISOString(),
    deployment: {
      success: true, isDeployed: true, hasSuccessfulBuild: true,
      visibility: 'public', primaryUrl: 'https://published.example.com', ...overrides,
    },
  };
}

function routes({ brokenOutcome, brokenSlash = false, fault } = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(url.origin, 'https://published.example.com');
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'manual');
      assert.ok(options.signal instanceof AbortSignal);
      assert.ok(!url.pathname.startsWith('/api/'), 'Automated checks must never read application status');
      const outcome = url.searchParams.has('success') ? 'success' : 'cancellation';
      const broken = outcome === brokenOutcome
        && (url.pathname.startsWith('/mobile/') ? url.pathname.endsWith('/') === brokenSlash : true);
      if (url.pathname.startsWith('/mobile/')) {
        const query = broken && fault === 'lost-query' ? '?success=true' : url.search;
        return new Response('', { status: broken && fault === 'missing' ? 404 : 302, headers: {
          location: `/payment-return${query}`, 'cache-control': 'no-store',
        } });
      }
      assert.equal(url.pathname, '/payment-return');
      return new Response(broken && fault === 'bad-body' ? '{"ok":true}' : '<html>Application</html>', {
        status: broken && fault === 'redirect-again' ? 302 : 200,
        headers: { 'content-type': broken && fault === 'not-html' ? 'application/json' : 'text/html' },
      });
    },
  };
}

async function monitor(snapshot, fetchImpl) {
  const output = [];
  const exitCode = await runCli(['--deployment-metadata', '/private/metadata.json'], {
    readFileImpl: async () => JSON.stringify(snapshot), fetchImpl,
    log: (line) => output.push(line), error: (line) => output.push(line),
  });
  return { exitCode, output: output.join('\n') };
}

test('opt-in post-release monitor uses active metadata and clearly reports route-only coverage', async () => {
  const { fetchImpl, calls } = routes();
  const result = await monitor(metadata(), fetchImpl);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /ROUTES ONLY: paid-application verification NOT RUN/);
  assert.equal((result.output.match(/PASS HTTP ROUTING/g) || []).length, 4);
  assert.equal(calls.length, 8);
  for (const url of calls) {
    assert.equal(url.searchParams.get('id'), 'ba_route_smoke_only');
    assert.deepEqual(url.searchParams.getAll('extra'), ['a/b &', '✓']);
    assert.match(url.search, /&empty=&flag&return=/);
  }
});

for (const outcome of ['success', 'cancellation']) {
  for (const slash of [false, true]) {
    for (const fault of ['missing', 'lost-query', 'redirect-again', 'not-html', 'bad-body']) {
      test(`monitor fails: ${outcome}, slash=${slash}, ${fault}`, async () => {
        const { fetchImpl } = routes({ brokenOutcome: outcome, brokenSlash: slash, fault });
        const result = await monitor(metadata(), fetchImpl);
        assert.equal(result.exitCode, 1);
        assert.match(result.output, /FAIL/);
        assert.doesNotMatch(result.output, /ROUTES ONLY|ba_|cs_test_|https:/);
      });
    }
  }
}

for (const [name, overrides] of [
  ['metadata unavailable', { success: false }],
  ['no deployment', { isDeployed: false }],
  ['unsuccessful build', { hasSuccessfulBuild: false }],
  ['private deployment', { visibility: 'private' }],
  ['password protection', { visibility: 'password' }],
  ['preview domain', { primaryUrl: 'https://preview.replit.dev' }],
  ['preview path', { primaryUrl: 'https://published.example.com/mobile/' }],
  ['missing origin', { primaryUrl: '' }],
  ['http origin', { primaryUrl: 'http://published.example.com' }],
  ['local origin', { primaryUrl: 'https://127.0.0.1' }],
  ['credentials', { primaryUrl: 'https://user:password@published.example.com' }],
]) {
  test(`rejects ${name} before sending requests`, async () => {
    let called = false;
    const result = await monitor(metadata(overrides), async () => { called = true; });
    assert.equal(result.exitCode, 1);
    assert.equal(called, false);
  });
}

test('stale, future, missing or invalid metadata timestamps cannot target an old release', () => {
  const now = Date.now();
  for (const retrievedAt of [undefined, 'invalid', new Date(now - 900_001).toISOString(), new Date(now + 1).toISOString()]) {
    assert.throws(() => originFromDeploymentMetadata({ ...metadata(), retrievedAt }, now));
  }
});

test('untrusted I/O errors, arguments, and malformed JSON never reach logs', async () => {
  const sensitive = 'ba_PRIVATE_CAPABILITY cs_test_PRIVATE /api/biz-accounts/ba_PRIVATE_CAPABILITY/status';
  for (const readFileImpl of [
    async () => { throw new Error(sensitive); },
    async () => sensitive,
  ]) {
    const lines = [];
    assert.equal(await runCli(['--deployment-metadata', 'private.json'], {
      readFileImpl, error: (line) => lines.push(line),
    }), 1);
    assert.doesNotMatch(lines.join('\n'), /PRIVATE|ba_|cs_test_/);
  }
  const result = await monitor(metadata(), async () => { throw new Error(sensitive); });
  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(result.output, /PRIVATE|ba_|cs_test_/);
  const lines = [];
  assert.equal(await runCli(['https://example.com', sensitive], {
    error: (line) => lines.push(line),
  }), 1);
  assert.doesNotMatch(lines.join('\n'), /PRIVATE|ba_|cs_test_/);
});

test('paid fixtures require explicit independent confirmation before even the first GET', async () => {
  let called = false;
  await assert.rejects(checkPublishedPaymentReturn({
    origin: 'https://published.example.com', paidApplicationId: 'ba_PRIVATE_CAPABILITY',
    fetchImpl: async () => { called = true; },
  }), /prior independent confirmation/);
  assert.equal(called, false);
});

test('paid fixture mismatch errors contain neither capability ids nor payment responses', async () => {
  await assert.rejects(checkPublishedPaymentReturn({
    origin: 'https://published.example.com', paidApplicationId: 'ba_PRIVATE_CAPABILITY',
    confirmedPaidSandbox: true,
    fetchImpl: async () => Response.json({ id: 'ba_OTHER_PRIVATE_CAPABILITY' }),
  }), (error) => {
    assert.match(error.message, /identity mismatch/);
    assert.doesNotMatch(error.message, /ba_|PRIVATE/);
    return true;
  });
});

test('real CLI refuses an implicit run, direct origin, or unreadable metadata with exit code 1', () => {
  for (const args of [[], ['https://example.com'], ['--deployment-metadata', '/nonexistent/metadata.json']]) {
    const result = spawnSync(process.execPath, [
      require.resolve('../scripts/check-published-payment-return.cjs'), ...args,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAIL/);
    assert.doesNotMatch(result.stderr, /at |\/nonexistent/);
  }
});
