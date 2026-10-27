#!/usr/bin/env node
const { runCli } = require('./check-published-payment-return.cjs');

class MonitorFailure extends Error {}
function requireConfig(condition, message) {
  if (!condition) throw new MonitorFailure(message);
}

/**
 * One scheduled monitoring cycle. The workflow supplies the schedule; this
 * runner obtains fresh metadata on EVERY invocation, then runs route-only HTTP
 * checks. It never publishes, reads application status, or retries payments.
 *
 * Metadata contract: https://api.replit.com/openapi.json, GET /deployments.
 * This single-read client makes no retries or pagination requests. On quota
 * exhaustion it fails the job rather than competing with other API callers.
 */
async function runMonitor({
  enabled, apiKey, workspaceId, projectId, fetchImpl = fetch,
  log = console.log, error = console.error,
  notify = (message) => console.error(`::error title=Published payment-return monitor::${message}`),
}) {
  if (enabled !== 'true') {
    log('SKIP Published payment-return monitoring is not enabled.');
    return 0;
  }
  try {
    requireConfig(typeof apiKey === 'string' && apiKey.length > 0,
      'Monitoring requires a configured read-only Replit Admin API key.');
    requireConfig(typeof workspaceId === 'string' && /^[A-Za-z0-9]{1,255}$/.test(workspaceId),
      'Monitoring requires a valid workspace id.');
    requireConfig(typeof projectId === 'string'
      && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(projectId),
    'Monitoring requires a valid project id.');

    // Ordered by publish time by the service. Do not filter to success: a failed
    // or suspended current deployment must not fall back to an old healthy one.
    const url = new URL('https://api.replit.com/v1/deployments');
    url.searchParams.set('workspaceId', workspaceId);
    url.searchParams.set('projectId', projectId);
    url.searchParams.set('limit', '1');
    const response = await fetchImpl(url, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    requireConfig(response.status !== 429, 'Deployment metadata rate-limited; no automatic retry was attempted.');
    requireConfig(response.status === 200, 'Deployment metadata request failed; check monitoring access.');
    const payload = await response.json();
    requireConfig(Array.isArray(payload.data) && payload.data.length === 1,
      'No unambiguous current deployment was returned.');
    const current = payload.data[0];
    requireConfig(current.project?.id === projectId && current.workspace?.id === workspaceId,
      'Deployment metadata does not match the configured project and workspace.');
    requireConfig(current.status === 'success', 'The current deployment is not successful.');
    // Normalize the documented Admin API response to the same validated snapshot
    // used by getDeploymentInfo(). No URL/configuration fallback is permitted.
    const snapshot = {
      retrievedAt: new Date().toISOString(),
      deployment: {
        success: true, isDeployed: true, hasSuccessfulBuild: true,
        primaryUrl: current.url, visibility: current.deploymentPrivacy,
      },
    };
    const exitCode = await runCli(['--deployment-metadata', 'fresh-service-response'], {
      readFileImpl: async () => JSON.stringify(snapshot), fetchImpl, log, error,
    });
    if (exitCode !== 0) {
      notify('Legacy payment-return routing failed. Inspect the failed monitoring run; paid verification was not performed.');
    }
    return exitCode;
  } catch (failure) {
    error(`FAIL ${failure instanceof MonitorFailure ? failure.message : 'Deployment metadata or monitoring request failed (details withheld).'}`);
    notify('Published payment-return monitoring could not complete. Inspect the failed monitoring run; paid verification was not performed.');
    return 1;
  }
}

if (require.main === module) {
  runMonitor({
    enabled: process.env.PAYMENT_RETURN_MONITOR_ENABLED,
    apiKey: process.env.REPLIT_MONITOR_API_KEY,
    workspaceId: process.env.REPLIT_MONITOR_WORKSPACE_ID,
    projectId: process.env.REPLIT_MONITOR_PROJECT_ID,
  }).then((code) => { process.exitCode = code; });
}

module.exports = { runMonitor };
