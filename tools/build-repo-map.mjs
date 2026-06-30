#!/usr/bin/env node
// Regenerate repo-map.json by matching WP Engine installs to GitHub repos.
//
//   node tools/build-repo-map.mjs
//
// Requires: the `gh` CLI authenticated to the org, and WP Engine API creds
// (config.json wpeCredsPath / .wpe-api). Existing manual mappings and any
// entries in the "review" section are preserved unless --overwrite is passed.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig, ROOT } from '../src/store.js';
import { readCreds, getInstalls } from '../src/wpengine.js';

const execFileP = promisify(execFile);
const MAP_PATH = path.join(ROOT, 'repo-map.json');
const overwrite = process.argv.includes('--overwrite');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ENV_SUFFIXES = ['development', 'staging', 'production', 'stage', 'prod', 'stg', 'dev', 'test', 'tst', 'live', 'demo'];
function slugBase(slug) {
  let s = norm(slug);
  for (const suf of ENV_SUFFIXES) {
    if (s.endsWith(suf) && s.length - suf.length >= 4) { s = s.slice(0, -suf.length); break; }
  }
  return s.replace(/\d+$/, '');
}
function domainCore(domain) {
  if (!domain) return '';
  let d = domain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  return norm(d.split('/')[0].split('.')[0]);
}

function bestMatch(install, repoIndex) {
  const keys = [...new Set([domainCore(install.primaryDomain), slugBase(install.name)].filter((k) => k && k.length >= 3))];
  let best = null;
  for (const r of repoIndex) {
    for (const k of keys) {
      let score = 0, why = '';
      if (r.norm === k) { score = 100; why = 'exact'; }
      else if (r.norm.startsWith(k) && k.length >= 5) { score = 80 - (r.norm.length - k.length); why = 'repo-starts-with-key'; }
      else if (k.startsWith(r.norm) && r.norm.length >= 5) { score = 75 - (k.length - r.norm.length); why = 'key-starts-with-repo'; }
      else if (r.norm.includes(k) && k.length >= 6) { score = 60; why = 'repo-includes-key'; }
      else if (k.includes(r.norm) && r.norm.length >= 6) { score = 55; why = 'key-includes-repo'; }
      if (score > (best?.score || 0)) best = { repo: r.name, sshUrl: r.sshUrl, score, why };
    }
  }
  return best;
}

async function ghRepoList(org) {
  const { stdout } = await execFileP('gh', ['repo', 'list', org, '--limit', '1000', '--json', 'name,sshUrl,url'], {
    maxBuffer: 10 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  return JSON.parse(stdout);
}

async function main() {
  const config = loadConfig();
  const org = config.githubOrg || 'blueshoon';

  console.log(`Fetching repos for github.com/${org} via gh…`);
  const repos = await ghRepoList(org);
  const repoIndex = repos.map((r) => ({ ...r, norm: norm(r.name) }));
  console.log(`  ${repos.length} repos.`);

  console.log('Fetching WP Engine installs…');
  const installs = await getInstalls(readCreds(config.wpeCredsPath));
  console.log(`  ${installs.length} installs.`);

  // Preserve existing manual entries unless --overwrite.
  let existing = { installs: {}, review: {} };
  if (fs.existsSync(MAP_PATH)) {
    try { existing = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')); } catch { /* ignore */ }
  }
  const confident = overwrite ? {} : { ...(existing.installs || {}) };
  const review = {};
  const bands = { EXACT: 0, STRONG: 0, WEAK: 0, NONE: 0, KEPT: 0 };

  for (const i of installs) {
    if (!overwrite && confident[i.name]) { bands.KEPT++; continue; }
    const m = bestMatch(i, repoIndex);
    if (m && m.score >= 70) {
      confident[i.name] = { repo: m.repo, sshUrl: m.sshUrl };
      bands[m.score >= 100 ? 'EXACT' : 'STRONG']++;
    } else if (m && m.score >= 50) {
      review[i.name] = { repo: m.repo, sshUrl: m.sshUrl, domain: i.primaryDomain, score: m.score, why: m.why };
      bands.WEAK++;
    } else {
      review[i.name] = { repo: null, sshUrl: null, domain: i.primaryDomain, score: 0, why: 'no-match' };
      bands.NONE++;
    }
  }

  const out = {
    _comment:
      'Maps WP Engine install slug -> GitHub repo under github.com/' + org + '. ' +
      'The wizard locates local clones at <projectsRoot>/<repo> and clones missing repos from sshUrl. ' +
      'Move/add verified entries into "installs"; "review" holds low-confidence guesses and unmatched installs (delete once handled). ' +
      'Regenerate with: node tools/build-repo-map.mjs (existing "installs" entries are preserved; pass --overwrite to rebuild from scratch).',
    org,
    installs: Object.fromEntries(Object.entries(confident).sort(([a], [b]) => a.localeCompare(b))),
    review: Object.fromEntries(Object.entries(review).sort(([a], [b]) => a.localeCompare(b))),
  };
  fs.writeFileSync(MAP_PATH, JSON.stringify(out, null, 2) + '\n');

  console.log(
    `\nWrote ${path.relative(ROOT, MAP_PATH)}: ` +
      `${Object.keys(out.installs).length} mapped (` +
      `+${bands.EXACT} exact, +${bands.STRONG} strong, ${bands.KEPT} kept), ` +
      `${Object.keys(out.review).length} need review (${bands.WEAK} weak, ${bands.NONE} unmatched).`
  );
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
