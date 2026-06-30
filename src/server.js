// Zero-dependency HTTP server: static dashboard + REST + SSE log streaming.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, saveConfig, loadSites, expandHome } from './store.js';
import { readCreds, getInstalls } from './wpengine.js';
import { detectRepo, defaultRepoPath, repoExists } from './repos.js';
import { loadRepoMap, upsert as upsertRepoMap, sshUrlFor } from './repomap.js';
import { hasScaffold, readLocalPhpVersion } from './scaffold.js';
import { preflight, ddevLaunch } from './ddev.js';
import { JobManager } from './queue.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

let installsCache = null;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

export function createServer() {
  const config = loadConfig();
  const jobs = new JobManager(config);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    try {
      // --- Config + preflight ---
      if (route === 'GET /api/config') {
        return sendJson(res, 200, { config, sites: loadSites() });
      }
      if (route === 'POST /api/config') {
        const body = await readBody(req);
        Object.assign(config, body);
        saveConfig(config);
        return sendJson(res, 200, { config });
      }
      // Persist a repo mapping edited in the UI, and re-resolve that install.
      if (route === 'POST /api/repomap') {
        const body = await readBody(req);
        const slug = String(body.slug || '').trim();
        if (!slug) return sendJson(res, 400, { error: 'slug required' });
        const repoName = String(body.repo || '').trim();
        const sshUrl = repoName ? sshUrlFor(loadRepoMap().org || config.githubOrg, repoName) : null;
        upsertRepoMap(slug, repoName, sshUrl);
        // Refresh the cached row so the UI reflects the new repo immediately.
        if (installsCache) {
          const row = installsCache.find((i) => i.name === slug);
          if (row) {
            const detected = detectRepo(slug, config.projectsRoot, repoName || null);
            const repoPath = detected || defaultRepoPath(slug, config.projectsRoot, repoName || null);
            const scaffolded = repoExists(repoPath) ? hasScaffold(repoPath) : false;
            const localPhp = scaffolded ? readLocalPhpVersion(repoPath) : null;
            Object.assign(row, {
              repo: repoName || null,
              gitUrl: sshUrl,
              repoPath,
              mapped: !!repoName,
              repoExists: repoExists(repoPath),
              hasScaffold: scaffolded,
              localPhp,
              phpMismatch: !!(localPhp && row.phpVersion && localPhp !== row.phpVersion),
            });
            return sendJson(res, 200, { install: row });
          }
        }
        return sendJson(res, 200, { ok: true });
      }

      if (route === 'GET /api/preflight') {
        const lines = [];
        const result = await preflight(config, (l) => lines.push(l));
        return sendJson(res, 200, { ...result, lines });
      }

      // --- Installs discovery ---
      if (route === 'GET /api/installs') {
        const refresh = url.searchParams.get('refresh') === '1';
        if (!installsCache || refresh) {
          const creds = readCreds(config.wpeCredsPath);
          const installs = await getInstalls(creds);
          const map = loadRepoMap();
          // Production only — we never clone staging/dev sites locally.
          installsCache = installs
            .filter((i) => i.environment === 'production')
            .map((i) => {
            const mapped = map.installs[i.name] || null;
            const repoName = mapped?.repo || null;
            const gitUrl = mapped?.sshUrl || (repoName ? sshUrlFor(map.org || config.githubOrg, repoName) : null);
            const detected = detectRepo(i.name, config.projectsRoot, repoName);
            const repoPath = detected || defaultRepoPath(i.name, config.projectsRoot, repoName);
            const scaffolded = repoExists(repoPath) ? hasScaffold(repoPath) : false;
            const localPhp = scaffolded ? readLocalPhpVersion(repoPath) : null;
            return {
              ...i,
              repo: repoName,
              gitUrl,
              repoPath,
              mapped: !!mapped,
              repoExists: repoExists(repoPath),
              hasScaffold: scaffolded,
              localPhp,
              phpMismatch: !!(localPhp && i.phpVersion && localPhp !== i.phpVersion),
            };
          });
        }
        return sendJson(res, 200, { installs: installsCache });
      }

      // --- Jobs ---
      if (route === 'GET /api/jobs') {
        return sendJson(res, 200, { jobs: jobs.list() });
      }
      if (route === 'POST /api/jobs') {
        const body = await readBody(req);
        const sites = Array.isArray(body.sites) ? body.sites : [];
        const created = sites.map((s) => jobs.enqueue(s));
        return sendJson(res, 200, { jobs: created });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/') && url.pathname.endsWith('/log')) {
        const id = url.pathname.split('/')[3];
        const from = Number(url.searchParams.get('from') || 0);
        const slice = jobs.logSlice(id, from);
        if (slice === null) return sendJson(res, 404, { error: 'no such job' });
        return sendJson(res, 200, { log: slice });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/') && url.pathname.endsWith('/stream')) {
        const id = url.pathname.split('/')[3];
        const job = jobs.get(id);
        if (!job) return sendJson(res, 404, { error: 'no such job' });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        // Replay existing log, then stream new lines.
        for (const e of jobs.logSlice(id, 0)) res.write(`data: ${JSON.stringify(e)}\n\n`);
        const onLog = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
        jobs.on(`log:${id}`, onLog);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => {
          clearInterval(ping);
          jobs.off(`log:${id}`, onLog);
        });
        return;
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/jobs/') && url.pathname.endsWith('/launch')) {
        const id = url.pathname.split('/')[3];
        const job = jobs.get(id);
        if (!job || !job.repoPath) return sendJson(res, 404, { error: 'no such job' });
        ddevLaunch(job.repoPath, () => {});
        return sendJson(res, 200, { ok: true });
      }

      // --- SSE for the job list itself ---
      if (route === 'GET /api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const onJobs = () => res.write(`data: ${JSON.stringify({ jobs: jobs.list() })}\n\n`);
        onJobs();
        jobs.on('jobs', onJobs);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => {
          clearInterval(ping);
          jobs.off('jobs', onJobs);
        });
        return;
      }

      // --- Static dashboard ---
      if (req.method === 'GET') return serveStatic(req, res);

      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || String(e) });
    }
  });

  return { server, config };
}

export { expandHome };
