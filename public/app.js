// Dashboard logic. Vanilla JS, no build step.
const $ = (sel) => document.querySelector(sel);
const state = {
  config: {},
  sites: [],
  installs: [],
  selected: new Map(), // name -> per-site options
  jobs: [],
  repoOrg: 'blueshoon',
};

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

// ---------- Config ----------
async function loadConfig() {
  const { config, sites } = await api('/api/config');
  state.config = config;
  state.sites = sites || [];
  state.repoOrg = config.githubOrg || 'blueshoon';
  $('#cfg-projectsRoot').value = config.projectsRoot || '';
  $('#cfg-sshPubKey').value = config.sshPubKey || '';
  $('#cfg-wpeCredsPath').value = config.wpeCredsPath || '';
  $('#cfg-concurrency').value = config.concurrency || 3;
  $('#cfg-defaultWpVersion').value = config.defaultWpVersion || '';
}

async function saveConfig() {
  const body = {
    projectsRoot: $('#cfg-projectsRoot').value.trim(),
    sshPubKey: $('#cfg-sshPubKey').value.trim(),
    wpeCredsPath: $('#cfg-wpeCredsPath').value.trim(),
    concurrency: Number($('#cfg-concurrency').value) || 3,
    defaultWpVersion: $('#cfg-defaultWpVersion').value.trim(),
  };
  await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  Object.assign(state.config, body);
  $('#config-saved').textContent = 'Saved ✓';
  setTimeout(() => ($('#config-saved').textContent = ''), 2000);
}

// ---------- Preflight ----------
async function runPreflight() {
  const el = $('#preflight');
  try {
    const r = await api('/api/preflight');
    el.classList.remove('hidden');
    if (r.ok) {
      el.className = 'banner ok';
      el.innerHTML = `✓ Ready — ${r.lines.map(escapeHtml).join(' · ')}`;
    } else {
      el.className = 'banner warn';
      el.innerHTML = `⚠ Fix these before setting up sites:<ul>${r.problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`;
    }
  } catch (e) {
    el.classList.remove('hidden');
    el.className = 'banner warn';
    el.textContent = 'Preflight failed: ' + e.message;
  }
}

// ---------- Installs ----------
async function loadInstalls(refresh) {
  const box = $('#installs');
  box.innerHTML = '<p class="muted">Loading installs…</p>';
  try {
    const { installs } = await api('/api/installs' + (refresh ? '?refresh=1' : ''));
    state.installs = installs;
    renderInstalls();
  } catch (e) {
    box.innerHTML = `<p class="banner warn">Could not load installs: ${escapeHtml(e.message)}</p>`;
  }
}

function renderInstalls() {
  const box = $('#installs');
  const term = $('#filter-text').value.toLowerCase();
  const filtered = state.installs.filter((i) => {
    if (term && !(`${i.name} ${i.primaryDomain || ''}`.toLowerCase().includes(term))) return false;
    return true;
  });

  // Group by account.
  const groups = {};
  for (const i of filtered) (groups[i.accountName] ||= []).push(i);

  if (!filtered.length) {
    box.innerHTML = '<p class="muted">No installs match the filter.</p>';
    return;
  }

  box.innerHTML = Object.entries(groups)
    .map(
      ([acct, items]) => `
      <div class="acct-group">
        <div class="acct-head"><span>${escapeHtml(acct)}</span><span class="muted">${items.length} installs</span></div>
        ${items.map(renderRow).join('')}
      </div>`
    )
    .join('');

  box.querySelectorAll('.install-row').forEach((row) => {
    const name = row.dataset.name;
    row.querySelector('.sel').addEventListener('change', (e) => toggleSelect(name, e.target.checked, row));
    row.querySelector('.save-repo').addEventListener('click', () => saveRepoMapping(name, row));
    const refresh = row.querySelector('.refresh-db');
    if (refresh) refresh.addEventListener('click', () => refreshDb(name, refresh));
    const fix = row.querySelector('.fix-php');
    if (fix) fix.addEventListener('click', () => fixPhp(name, fix));
  });
  updateSetupButton();
}

function phpTag(i) {
  if (!i.phpVersion) return '';
  if (i.phpMismatch) {
    return `<span class="tag tag-warn" title="Local DDEV is PHP ${attr(i.localPhp)} but production is ${attr(i.phpVersion)} — click Fix PHP">php ${escapeHtml(i.localPhp)} ≠ ${escapeHtml(i.phpVersion)}</span>`;
  }
  return `<span class="tag" title="Production PHP version">php ${escapeHtml(i.phpVersion)}</span>`;
}

function repoBadge(i) {
  if (i.repoExists) {
    return i.hasScaffold
      ? '<span class="tag repo-yes">cloned ✓ · .ddev ✓</span>'
      : '<span class="tag repo-yes">cloned ✓ · will scaffold</span>';
  }
  if (i.repo && i.gitUrl) return '<span class="tag repo-clone">will clone</span>';
  return '<span class="tag repo-no">no repo mapped</span>';
}

function renderRow(i) {
  const profile = state.sites.find((s) => s.slug === i.name) || {};
  const wp = profile.wpVersion || state.config.defaultWpVersion || '';
  const media = profile.mediaMode || 'proxy';
  return `
    <div class="install-row" data-name="${attr(i.name)}">
      <input type="checkbox" class="sel" />
      <div class="install-main">
        <div class="install-title">
          <span class="name">${escapeHtml(i.name)}</span>
          <span class="tag ${i.environment}">${escapeHtml(i.environment || '?')}</span>
          ${phpTag(i)}
          <span class="badge-slot">${repoBadge(i)}</span>
          ${i.repoExists ? '<button class="ghost small refresh-db" title="Re-pull and re-import the latest production database">↻ Refresh DB</button>' : ''}
          ${i.phpMismatch ? `<button class="ghost small fix-php" title="Set DDEV PHP to ${attr(i.phpVersion)} and restart">⚙ Fix PHP → ${escapeHtml(i.phpVersion)}</button>` : ''}
        </div>
        <div class="domain">${escapeHtml(i.primaryDomain || i.remoteDomain)} → <code>${escapeHtml(i.name)}.ddev.site</code></div>
        <div class="repo-line">
          <span class="muted">github.com/${escapeHtml(state.repoOrg)}/</span>
          <input class="o-repo-name" type="text" placeholder="repo name" value="${attr(i.repo || '')}" />
          <button class="ghost small save-repo" title="Save mapping to repo-map.json">Save mapping</button>
        </div>
        <div class="install-opts">
          <label>Local path<input class="o-repo" type="text" value="${attr(i.repoPath || '')}" /></label>
          <label>WP version<input class="o-wp" type="text" value="${attr(wp)}" /></label>
          <label>Media<select class="o-media">
            <option value="proxy"${media === 'proxy' ? ' selected' : ''}>proxy</option>
            <option value="download"${media === 'download' ? ' selected' : ''}>download</option>
          </select></label>
        </div>
      </div>
    </div>`;
}

async function saveRepoMapping(name, row) {
  const repo = row.querySelector('.o-repo-name').value.trim();
  const btn = row.querySelector('.save-repo');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const { install } = await api('/api/repomap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: name, repo }),
    });
    if (install) {
      const idx = state.installs.findIndex((x) => x.name === name);
      if (idx !== -1) state.installs[idx] = install;
      row.querySelector('.badge-slot').innerHTML = repoBadge(install);
      row.querySelector('.o-repo').value = install.repoPath || '';
    }
    btn.textContent = 'Saved ✓';
  } catch (e) {
    btn.textContent = 'Error';
    alert('Could not save mapping: ' + e.message);
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = 'Save mapping'; }, 1500);
}

function toggleSelect(name, on, row) {
  if (on) {
    state.selected.set(name, row);
    row.classList.add('selected');
  } else {
    state.selected.delete(name);
    row.classList.remove('selected');
  }
  updateSetupButton();
}

function updateSetupButton() {
  const n = state.selected.size;
  $('#sel-count').textContent = n;
  $('#btn-setup').disabled = n === 0;
}

function collectSelectedSites() {
  const freshDb = $('#opt-freshdb').checked;
  const sites = [];
  for (const [name, row] of state.selected) {
    const install = state.installs.find((i) => i.name === name);
    sites.push({
      slug: name,
      remoteDomain: install.primaryDomain || install.remoteDomain,
      repoPath: row.querySelector('.o-repo').value.trim(),
      wpVersion: row.querySelector('.o-wp').value.trim(),
      mediaMode: row.querySelector('.o-media').value,
      phpVersion: install.phpVersion || undefined,
      freshDb,
      gitUrl: install.gitUrl || undefined,
      clone: !!install.gitUrl && !install.repoExists,
    });
  }
  return sites;
}

async function setupSelected() {
  const sites = collectSelectedSites();
  await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sites }) });
}

async function refreshDb(name, btn) {
  const install = state.installs.find((i) => i.name === name);
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Queued…';
  try {
    await api('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sites: [{ slug: name, repoPath: install.repoPath, remoteDomain: install.primaryDomain || install.remoteDomain, kind: 'refresh-db' }],
      }),
    });
  } catch (e) {
    alert('Could not queue DB refresh: ' + e.message);
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 1500);
}

async function fixPhp(name, btn) {
  const install = state.installs.find((i) => i.name === name);
  if (!confirm(`Set ${name} to PHP ${install.phpVersion} (matching production) and restart?`)) return;
  btn.disabled = true;
  btn.textContent = 'Queued…';
  try {
    await api('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sites: [{ slug: name, repoPath: install.repoPath, phpVersion: install.phpVersion, kind: 'set-php' }],
      }),
    });
  } catch (e) {
    alert('Could not queue PHP fix: ' + e.message);
    btn.disabled = false;
    btn.textContent = `⚙ Fix PHP → ${install.phpVersion}`;
  }
}

async function setupAllFromProfile() {
  if (!state.sites.length) {
    alert('No saved site profiles yet (sites.json). Set up a few sites first to build the profile.');
    return;
  }
  if (!confirm(`Queue ${state.sites.length} sites from the saved profile?`)) return;
  const sites = state.sites.map((s) => ({
    slug: s.slug,
    remoteDomain: s.remoteDomain,
    wpVersion: s.wpVersion,
    phpVersion: s.phpVersion,
    mediaMode: s.mediaMode || 'proxy',
    gitUrl: s.repoGitUrl,
    clone: !!s.repoGitUrl,
  }));
  await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sites }) });
}

// ---------- Queue ----------
function renderQueue() {
  const box = $('#queue');
  const jobs = state.jobs;
  if (!jobs.length) {
    box.innerHTML = '<p class="muted">No jobs yet.</p>';
    $('#queue-summary').textContent = '';
    return;
  }
  const counts = jobs.reduce((a, j) => ((a[j.status] = (a[j.status] || 0) + 1), a), {});
  $('#queue-summary').textContent = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ');
  box.innerHTML = jobs
    .slice()
    .reverse()
    .map(
      (j) => `
      <div class="job" data-id="${j.id}">
        <div class="job-top">
          <span class="slug">${escapeHtml(j.slug)}${j.kind === 'refresh-db' ? ' <span class="tag">DB refresh</span>' : j.kind === 'set-php' ? ' <span class="tag">PHP fix</span>' : ''}</span>
          <span class="status ${j.status}">${j.status === 'running' ? '<span class="spin"></span> ' : ''}${j.status}</span>
        </div>
        <div class="step">${j.status === 'failed' ? escapeHtml(j.error || '') : 'step: ' + escapeHtml(j.step || '')}</div>
        <div class="job-actions">
          <button class="ghost small act-log">View log</button>
          ${j.status === 'ready' && j.url ? `<button class="ghost small act-open">Open site ↗</button>` : ''}
        </div>
      </div>`
    )
    .join('');
  box.querySelectorAll('.job').forEach((el) => {
    const id = el.dataset.id;
    const job = jobs.find((j) => j.id === id);
    el.querySelector('.act-log').addEventListener('click', () => openLog(id, job.slug));
    const open = el.querySelector('.act-open');
    if (open) open.addEventListener('click', () => api(`/api/jobs/${id}/launch`, { method: 'POST' }));
  });
}

// ---------- Log drawer ----------
let logSource = null;
function openLog(id, slug) {
  closeLog();
  $('#log-title').textContent = `Log — ${slug}`;
  const body = $('#log-body');
  body.innerHTML = '';
  $('#log-drawer').classList.remove('hidden');
  logSource = new EventSource(`/api/jobs/${id}/stream`);
  logSource.onmessage = (e) => {
    const { line } = JSON.parse(e.data);
    const div = document.createElement('div');
    div.textContent = line;
    if (line.startsWith('===')) div.className = 'l-step';
    else if (line.startsWith('FAILED')) div.className = 'l-fail';
    else if (line.startsWith('READY')) div.className = 'l-ready';
    else if (line.startsWith('WARN')) div.className = 'l-warn';
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
  };
}
function closeLog() {
  if (logSource) { logSource.close(); logSource = null; }
  $('#log-drawer').classList.add('hidden');
}

// ---------- Live job events ----------
function subscribeEvents() {
  const src = new EventSource('/api/events');
  src.onmessage = (e) => {
    const { jobs } = JSON.parse(e.data);
    state.jobs = jobs;
    renderQueue();
  };
  src.onerror = () => {}; // EventSource auto-reconnects
}

// ---------- helpers ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function attr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

// ---------- wire up ----------
$('#btn-refresh').addEventListener('click', () => loadInstalls(true));
$('#btn-setup').addEventListener('click', setupSelected);
$('#btn-setup-all').addEventListener('click', setupAllFromProfile);
$('#btn-save-config').addEventListener('click', saveConfig);
$('#filter-text').addEventListener('input', renderInstalls);
$('#log-close').addEventListener('click', closeLog);

(async function init() {
  await loadConfig();
  runPreflight();
  subscribeEvents();
  await loadInstalls(false);
})();
