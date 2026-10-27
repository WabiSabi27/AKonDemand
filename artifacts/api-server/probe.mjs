const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
const xReplitToken = process.env.REPL_IDENTITY ? 'repl ' + process.env.REPL_IDENTITY :
                     process.env.WEB_REPL_RENEWAL ? 'depl ' + process.env.WEB_REPL_RENEWAL : null;
const url = new URL(`https://${hostname}/api/v2/connection`);
url.searchParams.set('include_secrets', 'true');
url.searchParams.set('connector_names', 'stripe');
url.searchParams.set('environment', 'development');
const r = await fetch(url, { headers: { 'Accept': 'application/json', 'X-Replit-Token': xReplitToken }});
const data = await r.json();
const item = data.items?.[0];
if (!item) { console.log('no stripe connection'); process.exit(1); }
const secret = item.settings.secret;
console.log('key_prefix:', secret.slice(0,12)+'...', 'mode:', secret.includes('test')?'TEST':'LIVE');

const Stripe = (await import('stripe')).default;
const s = new Stripe(secret);
try {
  const a = await s.accounts.retrieve();
  console.log('PLATFORM ACCT:');
  console.log('  id:        ', a.id);
  console.log('  email:     ', a.email);
  console.log('  business:  ', a.business_profile?.name || a.settings?.dashboard?.display_name);
  console.log('  country:   ', a.country);
  console.log('  details_submitted:', a.details_submitted);
  console.log('  capabilities:', JSON.stringify(a.capabilities));
} catch(e){ console.log('retrieve fail:', e.message); }
try {
  const t = await s.accounts.create({ type:'express', country:'US', email:'probe@example.com'});
  console.log('CONNECT WORKS — created', t.id);
  await s.accounts.del(t.id).catch(()=>{});
} catch(e){ console.log('CONNECT BLOCKED:', e.message); }
