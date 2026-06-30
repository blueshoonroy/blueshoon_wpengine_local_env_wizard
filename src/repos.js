// Repo discovery + optional cloning.
import fs from 'node:fs';
import path from 'node:path';
import { run, capture, q } from './proc.js';
import { resolvePath } from './store.js';

/** Extract "owner/repo" from an ssh or https GitHub URL. */
export function ownerRepoFromUrl(gitUrl) {
  if (!gitUrl) return null;
  const m = gitUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Find a local repo under projectsRoot. Prefers the mapped GitHub repo name
 * (repo-map.json), then falls back to the install slug. Returns an absolute
 * path if a directory match exists, else null.
 */
export function detectRepo(slug, projectsRoot, repoName) {
  const root = resolvePath(projectsRoot);
  for (const name of [repoName, slug]) {
    if (!name) continue;
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  }
  return null;
}

/** Default path where the repo would live (mapped repo name preferred). */
export function defaultRepoPath(slug, projectsRoot, repoName) {
  return path.join(resolvePath(projectsRoot), repoName || slug);
}

export function repoExists(repoPath) {
  return !!repoPath && fs.existsSync(repoPath);
}

export async function cloneRepo(gitUrl, dest, onLine) {
  const parent = path.dirname(dest);
  fs.mkdirSync(parent, { recursive: true });

  // Prefer `gh repo clone`: it authenticates with the gh token over HTTPS, so it
  // works without a GitHub SSH key on the machine (only a WP Engine key is set up).
  const ownerRepo = ownerRepoFromUrl(gitUrl);
  const hasGh = (await capture('gh --version')).code === 0;
  if (ownerRepo && hasGh) {
    onLine?.(`Cloning ${ownerRepo} via gh -> ${dest}`);
    const res = await run(`gh repo clone ${q(ownerRepo)} ${q(dest)}`, { onLine });
    if (res.code === 0) return res;
    onLine?.('gh clone failed; falling back to git clone over SSH…');
  }

  onLine?.(`Cloning ${gitUrl} -> ${dest}`);
  return run(`git clone ${q(gitUrl)} ${q(dest)}`, { onLine });
}
