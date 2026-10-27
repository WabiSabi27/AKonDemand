const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { runMonitor } = require('../scripts/run-published-payment-monitor.cjs');

const projectId = '12345678-1234-1234-1234-123456789abc';
const workspaceId = 'Workspace123';
const config = { enabled: 'true', apiKey: 'monitor-test-key', projectId, workspaceId };
const deployment = (overrides = {}) => ({
  project: { id: projectId }, workspace: { id: workspaceId },
  status: 'success', deploymentPrivacy: 'public', url: 'https://current.example.com', ...overrides,
});

function transport({ metadataStatus = 200, data = [deployment()], brokenRouting = false } = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    if (url.hostname === 'api.replit.com') {
      assert.equal(url.pathname, '/v1/deployments');
      assert.equal(url.searchParams.get('workspaceId'), workspaceId);
      assert.equal(url.searchParams.get('projectId'), projectId);
      assert.equal(url.searchParams.get('limit'), '1');
      assert.equal(url.searchParams.has('status'), false, 'Never select an old successful deployment');
      assert.equal(options.headers.Authorization, 'Bearer monitor-test-key');
      return Response.json({ data }, { status: metadataStatus });
    }
    assert.equal(url.hostname, 'current.example.com');
    assert.equal(options.headers, undefined, 'Admin API credential must not reach the public origin');
    assert.ok(['/mobile/payment-return', '/mobile/payment-return/', '/payment-return'].includes(url.pathname));
    if (url.pathname.startsWith('/mobile/')) {
      return new Response('', { status: 302, headers: {
        location: brokenRouting ? '/payment-return' : `/payment-return${url.search}`,
        'cache-control': 'no-store',
      } });
    }
    return new Response('<html>Application</html>', { headers: { 'content-type': 'text/html' } });
  };
  return { fetchImpl, requests };
}

async function cycle(overrides = {}) {
  const logs = [];
  const notifications = [];
  const result = await runMonitor({
    ...config, log: (line) => logs.push(line), error: (line) => logs.push(line),
    notify: (line) => notifications.push(line), ...overrides,
  });
  return { result, logs: logs.join('\n'), notifications };
}

test('disabled scheduled runner performs no I/O and sends no notification', async () => {
  const result = await cycle({ enabled: undefined, fetchImpl: async () => assert.fail('Unexpected request') });
  assert.equal(result.result, 0);
  assert.match(result.logs, /SKIP/);
  assert.deepEqual(result.notifications, []);
});

test('scheduled invocation fetches current metadata before all route-only checks', async () => {
  const { fetchImpl, requests } = transport();
  const result = await cycle({ fetchImpl });
  assert.equal(result.result, 0);
  assert.equal(requests.length, 9);
  assert.equal(requests[0].url.hostname, 'api.replit.com');
  assert.match(result.logs, /paid-application verification NOT RUN/);
  assert.deepEqual(result.notifications, []);
});

test('every scheduled invocation obtains fresh metadata instead of reusing an origin', async () => {
  let reads = 0;
  const routeOrigins = [];
  const fetchImpl = async (url) => {
    if (url.hostname === 'api.replit.com') {
      reads++;
      return Response.json({ data: [deployment({ url: `https://release${reads}.example.com` })] });
    }
    routeOrigins.push(url.origin);
    if (url.pathname.startsWith('/mobile/')) {
      return new Response('', { status: 302, headers: {
        location: `/payment-return${url.search}`, 'cache-control': 'no-store',
      } });
    }
    return new Response('<html>Application</html>', { headers: { 'content-type': 'text/html' } });
  };
  assert.equal((await cycle({ fetchImpl })).result, 0);
  assert.equal((await cycle({ fetchImpl })).result, 0);
  assert.equal(reads, 2);
  assert.deepEqual(new Set(routeOrigins.slice(0, 8)), new Set(['https://release1.example.com']));
  assert.deepEqual(new Set(routeOrigins.slice(8)), new Set(['https://release2.example.com']));
});

test('routing regression fails the scheduled job and notifies the operator exactly once', async () => {
  const result = await cycle(transport({ brokenRouting: true }));
  assert.equal(result.result, 1);
  assert.match(result.logs, /query/);
  assert.equal(result.notifications.length, 1);
  assert.match(result.notifications[0], /routing failed/);
  assert.doesNotMatch(result.logs + result.notifications.join(''), /ba_|cs_test_|monitor-test-key|https:/);
});

for (const [name, options] of [
  ['unauthorized metadata', { metadataStatus: 401 }],
  ['metadata rate limit', { metadataStatus: 429 }],
  ['missing deployment', { data: [] }],
  ['wrong project', { data: [deployment({ project: { id: 'wrong' } })] }],
  ['wrong workspace', { data: [deployment({ workspace: { id: 'wrong' } })] }],
  ['failed active build', { data: [deployment({ status: 'failed' })] }],
  ['suspended deployment', { data: [deployment({ status: 'suspended' })] }],
  ['private deployment', { data: [deployment({ deploymentPrivacy: 'private' })] }],
  ['preview origin', { data: [deployment({ url: 'https://preview.replit.dev' })] }],
  ['absent public URL', { data: [deployment({ url: null })] }],
]) {
  test(`metadata failure notifies without route requests or retries: ${name}`, async () => {
    const { fetchImpl, requests } = transport(options);
    const result = await cycle({ fetchImpl });
    assert.equal(result.result, 1);
    assert.equal(result.notifications.length, 1);
    assert.equal(requests.length, 1);
  });
}

test('configuration and transport failures have safe operator notifications', async () => {
  for (const overrides of [
    { apiKey: undefined }, { workspaceId: undefined }, { projectId: undefined },
    { fetchImpl: async () => { throw new Error('ba_PRIVATE monitor-test-key'); } },
  ]) {
    const result = await cycle(overrides);
    assert.equal(result.result, 1);
    assert.equal(result.notifications.length, 1);
    assert.doesNotMatch(result.logs + result.notifications.join(''), /ba_PRIVATE|monitor-test-key/);
  }
});

test('actual scheduled CLI invokes the checker and emits a failure annotation with nonzero exit', () => {
  // A process-local fetch preload exercises the exact entrypoint/env wiring used
  // by the workflow, with no network, real credentials, or payment fixtures.
  for (const broken of [false, true]) {
    const preload = `
      globalThis.fetch = async (url, options) => {
        if (url.hostname === 'api.replit.com') {
          if (options.headers.Authorization !== 'Bearer monitor-test-key') throw new Error('bad auth');
          return Response.json({ data: [${JSON.stringify(deployment())}] });
        }
        if (options.headers || url.hostname !== 'current.example.com') throw new Error('unsafe request');
        if (url.pathname.startsWith('/mobile/')) return new Response('', { status: 302, headers: {
          location: ${broken} ? '/payment-return' : '/payment-return' + url.search,
          'cache-control': 'no-store',
        } });
        if (url.pathname !== '/payment-return') throw new Error('unsafe path');
        return new Response('<html>Application</html>', { headers: { 'content-type': 'text/html' } });
      };`;
    const result = spawnSync(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      require.resolve('../scripts/run-published-payment-monitor.cjs'),
    ], { encoding: 'utf8', env: {
      PATH: process.env.PATH,
      PAYMENT_RETURN_MONITOR_ENABLED: 'true', REPLIT_MONITOR_API_KEY: 'monitor-test-key',
      REPLIT_MONITOR_WORKSPACE_ID: workspaceId, REPLIT_MONITOR_PROJECT_ID: projectId,
    } });
    assert.equal(result.status, broken ? 1 : 0, result.stderr);
    if (broken) assert.match(result.stderr, /::error title=Published payment-return monitor/);
    else assert.match(result.stdout, /paid-application verification NOT RUN/);
    assert.doesNotMatch(result.stdout + result.stderr, /ba_|cs_test_|monitor-test-key/);
  }
});

test('committed workflow has an opt-in automatic schedule, bounded runner, and failure reporting', () => {
  const workflow = readFileSync(require.resolve('../../../.github/workflows/payment-return-monitor.yml'), 'utf8');
  assert.match(workflow, /schedule:\s+- cron:/);
  assert.match(workflow, /release:\s+types: \[published\]/);
  assert.match(workflow, /if: vars\.PAYMENT_RETURN_MONITOR_ENABLED == 'true'/);
  assert.match(workflow, /run: node artifacts\/mobile\/scripts\/run-published-payment-monitor\.cjs/);
  assert.match(workflow, /if: failure\(\)/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.match(workflow, /timeout-minutes: 6/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /continue-on-error|pnpm .*build|publish.*--|stripe/i);
});
