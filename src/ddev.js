// Thin wrappers around the host `ddev` binary + WP Engine SSH helpers.
import fs from 'node:fs';
import { run, capture, q } from './proc.js';
import { resolvePath } from './store.js';

/** Check that the host has the tools this wizard drives. */
export async function preflight(config, onLine) {
  const problems = [];

  const ddevV = await capture('ddev --version');
  if (ddevV.code !== 0) problems.push('`ddev` not found on PATH. Install DDEV: https://ddev.com');
  else onLine?.(`ddev: ${ddevV.stdout.trim()}`);

  const docker = await capture('docker info --format "{{.ServerVersion}}"');
  if (docker.code !== 0) problems.push('Docker is not running. Start Docker Desktop and retry.');
  else onLine?.(`docker: ${docker.stdout.trim()}`);

  const keyPub = resolvePath(config.sshPubKey);
  const keyPriv = keyPub.replace(/\.pub$/, '');
  if (!fs.existsSync(keyPub)) {
    problems.push(
      `SSH public key not found at ${keyPub}. Create a WP Engine SSH-gateway key ` +
        `(https://wpengine.com/support/ssh-gateway/) or set sshPubKey in config.json.`
    );
  } else if (!fs.existsSync(keyPriv)) {
    problems.push(`SSH private key not found at ${keyPriv} (expected alongside the .pub key).`);
  } else {
    onLine?.(`ssh key: ${keyPub}`);
  }

  return { ok: problems.length === 0, problems };
}

/** Confirm the WP Engine SSH gateway accepts our key for this install. */
export async function checkSsh(wpengineEnv, config, onLine) {
  const keyPriv = resolvePath(config.sshPubKey).replace(/\.pub$/, '');
  const host = `${wpengineEnv}@${wpengineEnv}.ssh.wpengine.net`;
  const cmd = `ssh -i ${q(keyPriv)} -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15 ${q(host)} "echo ok"`;
  const { code } = await run(cmd, { onLine });
  return code === 0;
}

/**
 * Optionally refresh the remote DB dump before pulling, so we get current data
 * instead of WP Engine's (up to ~24h old) mysql.sql. Non-fatal on failure.
 */
export async function freshDbExport(wpengineEnv, config, onLine) {
  const keyPriv = resolvePath(config.sshPubKey).replace(/\.pub$/, '');
  const host = `${wpengineEnv}@${wpengineEnv}.ssh.wpengine.net`;
  const remote = `cd sites/${wpengineEnv} && wp db export wp-content/mysql.sql --quiet`;
  const cmd = `ssh -i ${q(keyPriv)} -o StrictHostKeyChecking=accept-new -o BatchMode=yes ${q(host)} ${q(remote)}`;
  onLine?.('Generating a fresh database export on the remote...');
  const { code } = await run(cmd, { onLine });
  if (code !== 0) onLine?.('WARN: fresh export failed; falling back to the existing mysql.sql.');
  return code === 0;
}

export async function ddevStart(repoPath, onLine, env) {
  return run('ddev start', { cwd: repoPath, onLine, env });
}

export async function ddevPull(repoPath, extraArgs, onLine) {
  return run(`ddev pull wpengine ${extraArgs} -y`, { cwd: repoPath, onLine });
}

/** Resolve the local URL for a started project. */
export async function ddevUrl(repoPath, fallbackName) {
  const { code, stdout } = await capture('ddev describe -j', { cwd: repoPath });
  if (code === 0) {
    try {
      const data = JSON.parse(stdout);
      const url = data?.raw?.primary_url || data?.raw?.httpsurl || data?.raw?.httpurl;
      if (url) return url;
    } catch {
      /* fall through */
    }
  }
  return fallbackName ? `https://${fallbackName}.ddev.site` : null;
}

export async function ddevLaunch(repoPath, onLine) {
  return run('ddev launch', { cwd: repoPath, onLine });
}

/** Set the project's PHP version to match production, then restart. */
export async function ddevSetPhp(repoPath, version, onLine) {
  const cfg = await run(`ddev config --php-version=${version}`, { cwd: repoPath, onLine });
  if (cfg.code !== 0) return cfg;
  return run('ddev restart', { cwd: repoPath, onLine });
}

export async function ddevIsRunning(repoPath) {
  const { code, stdout } = await capture('ddev describe -j', { cwd: repoPath });
  if (code !== 0) return false;
  try {
    return (JSON.parse(stdout)?.raw?.status || '') === 'running';
  } catch {
    return false;
  }
}

/**
 * Re-pull the latest production DB and re-import it. Ensures the project is up,
 * then runs the (forced) update-db command — download-only pull + ddev import-db
 * + the post-import-db search-replace.
 */
export async function ddevRefreshDb(repoPath, onLine) {
  if (!(await ddevIsRunning(repoPath))) {
    onLine?.('Project not running — starting it first…');
    const s = await run('ddev start', { cwd: repoPath, onLine });
    if (s.code !== 0) return s;
  }
  return run('ddev update-db', { cwd: repoPath, onLine });
}
