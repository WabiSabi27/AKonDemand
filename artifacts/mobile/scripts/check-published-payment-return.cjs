#!/usr/bin/env node
const { readFile } = require('node:fs/promises');
const { isDeepStrictEqual } = require('node:util');

class CheckFailure extends Error {}
function check(condition, message) {
  if (!condition) throw new CheckFailure(message);
}

function publicOrigin(origin) {
  let base;
  try { base = new URL(origin); } catch { throw new CheckFailure('Invalid public origin'); }
  check(base.protocol === 'https:', 'Expected an HTTPS public origin');
  check(base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password,
    'Supply only the public origin, without a path, query, fragment, or credentials');
  check(!/(^|\.)(localhost|local|internal|replit\.dev)$/i.test(base.hostname)
    && !/^[\d.]+$/.test(base.hostname) && !base.hostname.includes(':'),
  'Preview and local origins are not supported');
  return base;
}

function originFromDeploymentMetadata(snapshot, now = Date.now()) {
  const age = now - Date.parse(snapshot?.retrievedAt);
  check(Number.isFinite(age) && age >= 0 && age <= 15 * 60_000,
    'Deployment metadata must be retrieved within the last 15 minutes');
  const info = snapshot.deployment;
  check(info?.success === true, 'Deployment metadata is unavailable');
  check(info.isDeployed === true && info.hasSuccessfulBuild === true,
    'An active successful deployment is required');
  check(info.visibility === 'public', 'The deployment must be public for this unauthenticated check');
  return publicOrigin(info.primaryUrl).origin;
}

/**
 * GET-only release smoke check. Never opens Checkout or calls a payment mutation.
 * Optional application id MUST be an already-paid sandbox application: the public
 * status endpoint may reconcile unpaid applications, so do not supply an unpaid id.
 */
async function checkPublishedPaymentReturn({
  origin, paidApplicationId, confirmedPaidSandbox = false, fetchImpl = fetch,
}) {
  const base = publicOrigin(origin);
  if (paidApplicationId) {
    check(confirmedPaidSandbox === true,
      'Paid verification requires prior independent confirmation of an already-paid sandbox fixture');
    check(/^ba_[a-zA-Z0-9_-]+$/.test(paidApplicationId), 'Invalid paid fixture configuration');
  }
  const request = (path) => fetchImpl(new URL(path, base), {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(30_000),
  });
  const paidStatus = async () => {
    const response = await request(`/api/biz-accounts/${paidApplicationId}/status`);
    check(response.status === 200, 'Already-paid sandbox application must exist publicly');
    const status = await response.json();
    check(status.id === paidApplicationId, 'Paid fixture response identity mismatch');
    check(['pending', 'accepted', 'approved', 'rejected'].includes(status.status),
      'Application must already be beyond awaiting_payment');
    check(status.paidAt && Number.isFinite(Date.parse(status.paidAt)),
      'Public status must confirm an existing payment');
    return {
      status: status.status, paidAt: status.paidAt,
      applicationPayment: status.applicationPayment,
      onboardingPayment: status.onboardingPayment,
    };
  };
  const before = paidApplicationId ? await paidStatus() : null;
  const id = paidApplicationId || 'ba_route_smoke_only';
  const extra = '&session=cs_test_route_smoke_only&extra=a%2Fb+%26&extra=%E2%9C%93&empty=&flag&return=https%3A%2F%2Fexample.com';
  const results = [];
  for (const [outcome, query] of [
    ['success', `?success=true&id=${id}${extra}`],
    ['cancellation', `?cancelled=true&id=${id}${extra}`],
  ]) {
    for (const suffix of ['', '/']) {
      const legacy = await request(`/mobile/payment-return${suffix}${query}`);
       check(legacy.status === 302, `${outcome}: legacy path must redirect once`);
      const location = legacy.headers.get('location');
       check(location === `/payment-return${query}`,
        `${outcome}: redirect must preserve the exact raw query string`);
       check(legacy.headers.get('cache-control') === 'no-store', `${outcome}: redirect must not be cached`);
      await legacy.text();
      const destination = await request(location);
       check(destination.status === 200, `${outcome}: destination must not redirect again`);
       check(/text\/html/i.test(destination.headers.get('content-type') || ''),
         `${outcome}: destination must return HTML`);
      const html = await destination.text();
       check(/<html[\s>]/i.test(html), `${outcome}: destination must serve HTML markup`);
      results.push(`${outcome}${suffix ? ' (trailing slash)' : ''}: 302 → 200; query unchanged`);
    }
  }
  if (before) check(isDeepStrictEqual(await paidStatus(), before), 'Payment state must remain unchanged');
  return { results, paidApplicationVerified: Boolean(before) };
}

async function runCli(args, { readFileImpl = readFile, fetchImpl = fetch, log = console.log, error = console.error } = {}) {
  try {
    check(args.length === 2 && args[0] === '--deployment-metadata',
      'Usage: node scripts/check-published-payment-return.cjs --deployment-metadata METADATA_JSON_FILE');
    const snapshot = JSON.parse(await readFileImpl(args[1], 'utf8'));
    const origin = originFromDeploymentMetadata(snapshot);
    // Automated monitoring is deliberately route-only. Never call the public
    // status endpoint: even a GET may reconcile an unpaid application.
    const result = await checkPublishedPaymentReturn({ origin, fetchImpl });
    for (const line of result.results) log(`PASS HTTP ROUTING ${line}`);
    log('ROUTES ONLY: paid-application verification NOT RUN; no payment or status endpoints called.');
    return 0;
  } catch (failure) {
    // Do not print raw transport/JSON/assertion errors, URLs, response bodies,
    // or stack traces: they may contain capability ids or payment details.
    error(`FAIL ${failure instanceof CheckFailure ? failure.message : 'Metadata read, response parsing, or network request failed (details withheld).'}`);
    return 1;
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { checkPublishedPaymentReturn, originFromDeploymentMetadata, runCli };
