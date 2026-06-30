// Config + credentials + sites-profile storage. Zero dependencies.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CONFIG_PATH = path.join(ROOT, 'config.json');
const CONFIG_EXAMPLE_PATH = path.join(ROOT, 'config.example.json');
const SITES_PATH = path.join(ROOT, 'sites.json');

const DEFAULT_CONFIG = {
  // Path to the WP Engine API credentials file (WPE_API_USER / WPE_API_PASSWORD).
  wpeCredsPath: '.wpe-api',
  // SSH public key registered with WP Engine's SSH gateway.
  sshPubKey: '~/.ssh/wpengine_ed25519.pub',
  // Parent directory where client repos are (or will be) cloned.
  projectsRoot: 'C:/laragon/www',
  // GitHub org that hosts the client repos (used by tools/build-repo-map.mjs).
  githubOrg: 'blueshoon',
  // How many sites to set up at once. WP Engine allows 5 SSH connections/user.
  concurrency: 3,
  // Default WordPress version when it can't be detected from the remote.
  defaultWpVersion: '6.9.4',
  phpVersion: '8.2',
  mysqlVersion: '8.0',
};

/** Expand a leading ~ to the user's home directory. */
export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Resolve a possibly-relative path against the wizard repo root. */
export function resolvePath(p) {
  const expanded = expandHome(p);
  return path.isAbsolute(expanded) ? expanded : path.resolve(ROOT, expanded);
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function loadConfig() {
  const fromFile = readJsonIfExists(CONFIG_PATH) || readJsonIfExists(CONFIG_EXAMPLE_PATH) || {};
  return { ...DEFAULT_CONFIG, ...fromFile };
}

export function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

/**
 * Parse a KEY=VALUE env file (the .wpe-api format). Quotes are stripped and
 * blank lines / # comments are ignored.
 */
export function parseEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function loadSites() {
  return readJsonIfExists(SITES_PATH) || [];
}

export function saveSites(sites) {
  fs.writeFileSync(SITES_PATH, JSON.stringify(sites, null, 2) + '\n');
}

/** Upsert a single site profile keyed by slug. */
export function upsertSite(site) {
  const sites = loadSites();
  const i = sites.findIndex((s) => s.slug === site.slug);
  if (i === -1) sites.push(site);
  else sites[i] = { ...sites[i], ...site };
  saveSites(sites);
  return sites;
}
