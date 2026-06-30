// WP Engine Hosting Platform API client.
// Auth + pagination mirror wp-site-audit/list-environments.sh.
import { parseEnvFile, resolvePath } from './store.js';

const API_BASE = 'https://api.wpengineapi.com/v1';

export function readCreds(credsPath) {
  const env = parseEnvFile(resolvePath(credsPath));
  const user = env.WPE_API_USER || process.env.WPE_API_USER;
  const password = env.WPE_API_PASSWORD || process.env.WPE_API_PASSWORD;
  if (!user || !password) {
    throw new Error(
      'WP Engine API credentials not found. Set WPE_API_USER / WPE_API_PASSWORD ' +
        'in your creds file (copy .wpe-api.example) or the environment.'
    );
  }
  return { user, password };
}

function authHeader(creds) {
  const token = Buffer.from(`${creds.user}:${creds.password}`).toString('base64');
  return `Basic ${token}`;
}

async function apiGet(creds, pathAndQuery) {
  const res = await fetch(`${API_BASE}${pathAndQuery}`, {
    headers: { Authorization: authHeader(creds), Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`WP Engine API ${res.status} on ${pathAndQuery}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** Fetch every install across all accounts (paginated). */
export async function listInstalls(creds) {
  const limit = 100;
  let offset = 0;
  let count = Infinity;
  const installs = [];
  while (offset < count) {
    const data = await apiGet(creds, `/installs?limit=${limit}&offset=${offset}`);
    count = data.count ?? 0;
    const results = data.results ?? [];
    for (const r of results) {
      installs.push({
        name: r.name,
        environment: r.environment,
        primaryDomain: r.primary_domain || null,
        status: r.status,
        accountId: r.account?.id || null,
        phpVersion: r.php_version || null,
      });
    }
    if (results.length === 0) break;
    offset += limit;
  }
  return installs;
}

/** Map of account id -> account name. */
export async function listAccounts(creds) {
  const map = {};
  try {
    const data = await apiGet(creds, '/accounts?limit=100');
    for (const a of data.results ?? []) map[a.id] = a.name;
  } catch {
    // Non-fatal: fall back to raw ids.
  }
  return map;
}

/** Installs decorated with account names, plus a guessed remote domain. */
export async function getInstalls(creds) {
  const [installs, accounts] = await Promise.all([listInstalls(creds), listAccounts(creds)]);
  return installs
    .map((i) => ({
      ...i,
      accountName: (i.accountId && accounts[i.accountId]) || i.accountId || 'unknown',
      // The live domain to mirror; falls back to the WP Engine default host.
      remoteDomain: i.primaryDomain || `${i.name}.wpengine.com`,
    }))
    .sort((a, b) => a.accountName.localeCompare(b.accountName) || a.name.localeCompare(b.name));
}
