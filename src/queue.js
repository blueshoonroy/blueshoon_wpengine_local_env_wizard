// Concurrency-capped job manager + the per-site setup pipeline.
import { EventEmitter } from 'node:events';
import { resolvePath, upsertSite } from './store.js';
import { hasScaffold, generate } from './scaffold.js';
import { detectRepo, defaultRepoPath, repoExists, cloneRepo } from './repos.js';
import { lookup as lookupRepo } from './repomap.js';
import { checkSsh, freshDbExport, ddevStart, ddevUrl, ddevRefreshDb, ddevSetPhp } from './ddev.js';

const MAX_LOG_LINES = 4000;
let nextId = 1;

export class JobManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.jobs = new Map();
    this.waiting = [];
    this.running = 0;
  }

  get concurrency() {
    return Math.max(1, Number(this.config.concurrency) || 3);
  }

  list() {
    return [...this.jobs.values()].map((j) => this.publicView(j));
  }

  get(id) {
    const j = this.jobs.get(id);
    return j ? this.publicView(j) : null;
  }

  publicView(j) {
    return {
      id: j.id,
      slug: j.slug,
      kind: j.kind,
      repoPath: j.repoPath,
      status: j.status,
      step: j.step,
      url: j.url,
      error: j.error,
      opts: j.opts,
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      logLength: j.log.length,
    };
  }

  logSlice(id, from = 0) {
    const j = this.jobs.get(id);
    if (!j) return null;
    return j.log.slice(from);
  }

  enqueue(site) {
    const id = String(nextId++);
    const job = {
      id,
      slug: site.slug,
      kind: ['refresh-db', 'set-php'].includes(site.kind) ? site.kind : 'setup',
      repoPath: site.repoPath || null,
      status: 'queued',
      step: 'queued',
      url: null,
      error: null,
      opts: {
        remoteDomain: site.remoteDomain,
        wpVersion: site.wpVersion || this.config.defaultWpVersion,
        mediaMode: site.mediaMode === 'download' ? 'download' : 'proxy',
        freshDb: !!site.freshDb,
        gitUrl: site.gitUrl || null,
        clone: !!site.clone,
        phpVersion: site.phpVersion || this.config.phpVersion,
        mysqlVersion: site.mysqlVersion || this.config.mysqlVersion,
      },
      log: [],
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    };
    this.jobs.set(id, job);
    this.waiting.push(job);
    this.emit('jobs');
    this.pump();
    return this.publicView(job);
  }

  pump() {
    while (this.running < this.concurrency && this.waiting.length) {
      const job = this.waiting.shift();
      this.running++;
      const runner =
        job.kind === 'refresh-db'
          ? this.runRefreshDb(job)
          : job.kind === 'set-php'
            ? this.runSetPhp(job)
            : this.runSite(job);
      runner
        .catch((e) => this.appendLog(job, `unexpected error: ${e?.message || e}`))
        .finally(() => {
          this.running--;
          this.emit('jobs');
          this.pump();
        });
    }
  }

  appendLog(job, line) {
    const entry = { t: Date.now(), line: String(line) };
    job.log.push(entry);
    if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
    this.emit(`log:${job.id}`, entry);
  }

  setStep(job, step) {
    job.step = step;
    this.appendLog(job, `=== ${step} ===`);
    this.emit('jobs');
  }

  fail(job, message) {
    job.status = 'failed';
    job.error = message;
    job.finishedAt = Date.now();
    this.appendLog(job, `FAILED: ${message}`);
    this.emit('jobs');
  }

  async runSetPhp(job) {
    job.status = 'running';
    job.startedAt = Date.now();
    this.emit('jobs');
    const onLine = (l) => this.appendLog(job, l);
    const cfg = this.config;
    try {
      this.setStep(job, 'resolve');
      if (!job.repoPath) {
        const repoName = lookupRepo(job.slug)?.repo || null;
        job.repoPath =
          detectRepo(job.slug, cfg.projectsRoot, repoName) || defaultRepoPath(job.slug, cfg.projectsRoot, repoName);
      } else {
        job.repoPath = resolvePath(job.repoPath);
      }
      if (!repoExists(job.repoPath)) {
        return this.fail(job, `Repo not set up locally at ${job.repoPath}.`);
      }
      const v = String(job.opts.phpVersion || '').trim();
      if (!/^\d+\.\d+$/.test(v)) return this.fail(job, `Invalid PHP version: "${v}".`);

      this.setStep(job, `set-php ${v}`);
      this.appendLog(job, `Setting DDEV PHP to ${v} and restarting…`);
      const r = await ddevSetPhp(job.repoPath, v, onLine);
      if (r.code !== 0) return this.fail(job, 'Failed to set PHP version / restart (see log above).');

      job.url = await ddevUrl(job.repoPath, job.slug);
      job.status = 'ready';
      job.finishedAt = Date.now();
      this.appendLog(job, `READY: PHP set to ${v} — ${job.url || ''}`);
      this.emit('jobs');
    } catch (e) {
      this.fail(job, e?.message || String(e));
    }
  }

  async runRefreshDb(job) {
    job.status = 'running';
    job.startedAt = Date.now();
    this.emit('jobs');
    const onLine = (l) => this.appendLog(job, l);
    const cfg = this.config;
    try {
      this.setStep(job, 'resolve');
      if (!job.repoPath) {
        const repoName = lookupRepo(job.slug)?.repo || null;
        job.repoPath =
          detectRepo(job.slug, cfg.projectsRoot, repoName) || defaultRepoPath(job.slug, cfg.projectsRoot, repoName);
      } else {
        job.repoPath = resolvePath(job.repoPath);
      }
      if (!repoExists(job.repoPath)) {
        return this.fail(job, `Repo not set up locally at ${job.repoPath}. Set the site up before refreshing its DB.`);
      }
      this.appendLog(job, `Refreshing DB for ${job.repoPath} from the latest production dump…`);

      this.setStep(job, 'refresh-db');
      const r = await ddevRefreshDb(job.repoPath, onLine);
      if (r.code !== 0) return this.fail(job, 'DB refresh failed (see log above).');

      job.url = await ddevUrl(job.repoPath, job.slug);
      job.status = 'ready';
      job.finishedAt = Date.now();
      this.appendLog(job, `READY: DB refreshed — ${job.url || ''}`);
      this.emit('jobs');
    } catch (e) {
      this.fail(job, e?.message || String(e));
    }
  }

  async runSite(job) {
    job.status = 'running';
    job.startedAt = Date.now();
    this.emit('jobs');
    const onLine = (l) => this.appendLog(job, l);
    const cfg = this.config;

    try {
      // 1. Resolve / clone the repo (consult repo-map.json for name + git URL).
      this.setStep(job, 'repo');
      const mapped = lookupRepo(job.slug);
      const repoName = mapped?.repo || null;
      if (!job.opts.gitUrl && mapped?.sshUrl) job.opts.gitUrl = mapped.sshUrl;
      if (!job.repoPath) {
        job.repoPath =
          detectRepo(job.slug, cfg.projectsRoot, repoName) || defaultRepoPath(job.slug, cfg.projectsRoot, repoName);
      } else {
        job.repoPath = resolvePath(job.repoPath);
      }
      // Auto-clone a missing repo when we know its git URL.
      if (!repoExists(job.repoPath) && job.opts.gitUrl) job.opts.clone = true;
      if (!repoExists(job.repoPath)) {
        if (job.opts.clone && job.opts.gitUrl) {
          const { code } = await cloneRepo(job.opts.gitUrl, job.repoPath, onLine);
          if (code !== 0) return this.fail(job, 'git clone failed.');
        } else {
          return this.fail(
            job,
            `Repo not found at ${job.repoPath}. Clone it first or provide a git URL with "clone" enabled.`
          );
        }
      }
      this.appendLog(job, `Using repo: ${job.repoPath}`);

      // 2. Scaffold .ddev/ if the repo doesn't already ship one.
      this.setStep(job, 'scaffold');
      if (hasScaffold(job.repoPath)) {
        this.appendLog(job, 'Existing .ddev/ scaffold detected — using it as-is.');
      } else {
        const { fileCount } = generate(job.repoPath, {
          projectName: job.slug,
          wpengineEnv: job.slug,
          remoteDomain: job.opts.remoteDomain,
          wpVersion: job.opts.wpVersion,
          phpVersion: job.opts.phpVersion,
          mysqlVersion: job.opts.mysqlVersion,
          mediaMode: job.opts.mediaMode,
        });
        this.appendLog(job, `Generated .ddev/ scaffold (${fileCount} files, media=${job.opts.mediaMode}).`);
      }

      // 3. Verify SSH gateway access for this install (fail fast vs. hanging).
      this.setStep(job, 'ssh-check');
      const sshOk = await checkSsh(job.slug, cfg, onLine);
      if (!sshOk) {
        return this.fail(
          job,
          `Cannot SSH to ${job.slug}.ssh.wpengine.net. Confirm your key is added in the ` +
            `WP Engine portal (User Portal -> SSH Keys) and the install name is correct.`
        );
      }

      // 4. Optional fresh DB export on the remote.
      if (job.opts.freshDb) {
        this.setStep(job, 'fresh-db');
        await freshDbExport(job.slug, cfg, onLine);
      }

      // 5. ddev start — runs the whole hook chain (core, config, db, plugins, build).
      this.setStep(job, 'ddev-start');
      // Tell config-ssh which key to register (defaults to ~/.ssh/wpengine_ed25519.pub).
      const env = { WPENGINE_SSH_PUBLIC_KEY: resolvePath(cfg.sshPubKey) };
      // ddev start streams the whole hook chain; re-runs are idempotent via --initialize-only.
      const started = await ddevStart(job.repoPath, onLine, env);
      if (started.code !== 0) return this.fail(job, 'ddev start failed (see log above).');

      // 6. Resolve URL + mark ready.
      this.setStep(job, 'finalize');
      job.url = await ddevUrl(job.repoPath, job.slug);
      job.status = 'ready';
      job.finishedAt = Date.now();
      this.appendLog(job, `READY: ${job.url || '(url unknown)'}`);
      this.emit('jobs');

      // 7. Persist the profile so a future machine can re-bootstrap.
      try {
        upsertSite({
          slug: job.slug,
          remoteDomain: job.opts.remoteDomain,
          repoGitUrl: job.opts.gitUrl || undefined,
          wpVersion: job.opts.wpVersion,
          phpVersion: job.opts.phpVersion,
          mediaMode: job.opts.mediaMode,
        });
      } catch {
        /* profile persistence is best-effort */
      }
    } catch (e) {
      this.fail(job, e?.message || String(e));
    }
  }
}
