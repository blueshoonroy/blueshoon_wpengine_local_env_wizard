// Loads/saves repo-map.json — the committed WP Engine-install -> GitHub-repo map.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './store.js';

const MAP_PATH = path.join(ROOT, 'repo-map.json');

export function loadRepoMap() {
  try {
    const data = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
    return { org: data.org, installs: data.installs || {}, review: data.review || {}, _raw: data };
  } catch {
    return { org: undefined, installs: {}, review: {}, _raw: { installs: {}, review: {} } };
  }
}

/** Mapped repo for a slug, checking confident entries then the review section. */
export function lookup(slug) {
  const m = loadRepoMap();
  return m.installs[slug] || m.review[slug] || null;
}

/** Derive the ssh clone URL for a repo name under the configured org. */
export function sshUrlFor(org, repo) {
  return `git@github.com:${org || 'blueshoon'}/${repo}.git`;
}

/**
 * Persist a confident mapping for slug. Passing an empty/falsy repo removes the
 * entry. Always writes into "installs" and clears any stale "review" entry.
 */
export function upsert(slug, repo, sshUrl) {
  const m = loadRepoMap();
  const data = m._raw;
  data.installs = data.installs || {};
  data.review = data.review || {};
  if (repo) {
    data.installs[slug] = { repo, sshUrl: sshUrl || sshUrlFor(data.org, repo) };
  } else {
    delete data.installs[slug];
  }
  delete data.review[slug];
  fs.writeFileSync(MAP_PATH, JSON.stringify(data, null, 2) + '\n');
  return data.installs[slug] || null;
}
