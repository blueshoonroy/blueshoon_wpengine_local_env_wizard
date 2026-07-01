// Detect an existing .ddev/ WP Engine scaffold, or generate one from templates.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './store.js';

const TEMPLATE_DIR = path.join(ROOT, 'templates', 'ddev');

// Wizard-managed .ddev files that are pure logic — no per-project/rendered values
// and no runtime state — so they're safe to overwrite on an existing scaffold to
// heal drift (e.g. an `update-db` that predates a bug fix). Deliberately EXCLUDED:
//   - config.yaml           (rendered per project; the user may `ddev config`)
//   - homeadditions/wp-config.php  (may be hand-customized per repo)
//   - homeadditions/.ssh/wpengine.pub, known_hosts (runtime state from config-ssh)
// providers/wpengine.yaml is re-synced separately, mode-aware (see syncManaged).
const MANAGED_PATHS = [
  'commands',
  'web-entrypoint.d',
  'nginx_full',
  'homeadditions/.bashrc.d',
  'homeadditions/wp-cli.yaml',
  'homeadditions/.ssh/config',
  'homeadditions/.ssh/.gitignore',
];

/** True if the repo already has a WP Engine DDEV provider committed. */
export function hasScaffold(repoPath) {
  return fs.existsSync(path.join(repoPath, '.ddev', 'providers', 'wpengine.yaml'));
}

/** Read the php_version from a project's .ddev/config.yaml (or null). */
export function readLocalPhpVersion(repoPath) {
  try {
    const cfg = fs.readFileSync(path.join(repoPath, '.ddev', 'config.yaml'), 'utf8');
    const m = cfg.match(/^php_version:\s*["']?([0-9.]+)["']?/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function copyTree(srcDir, destDir, onFile) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dest, onFile);
    } else {
      // config.yaml is rendered from its .tmpl separately; skip the template here.
      if (entry.name === 'config.yaml.tmpl') continue;
      fs.copyFileSync(src, dest);
      if (onFile) onFile(dest);
    }
  }
}

function renderConfig(opts) {
  const tmpl = fs.readFileSync(path.join(TEMPLATE_DIR, 'config.yaml.tmpl'), 'utf8');
  return tmpl
    .replaceAll('__PROJECT_NAME__', opts.projectName)
    .replaceAll('__WPENGINE_ENV__', opts.wpengineEnv)
    .replaceAll('__REMOTE_DOMAIN__', opts.remoteDomain)
    .replaceAll('__WORDPRESS_VERSION__', opts.wpVersion)
    .replaceAll('__PHP_VERSION__', opts.phpVersion)
    .replaceAll('__MYSQL_VERSION__', opts.mysqlVersion);
}

/** The provider yaml for a given media mode (download appends an uploads rsync). */
function providerYaml(mediaMode) {
  return mediaMode === 'download'
    ? downloadModeProvider()
    : fs.readFileSync(path.join(TEMPLATE_DIR, 'providers', 'wpengine.yaml'), 'utf8');
}

/** Mark command scripts + entrypoints executable (matters on macOS/Linux). */
function makeExecutable(ddevDir) {
  const execGlobs = [
    path.join(ddevDir, 'commands', 'host'),
    path.join(ddevDir, 'commands', 'web'),
    path.join(ddevDir, 'web-entrypoint.d'),
  ];
  for (const dir of execGlobs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      try {
        fs.chmodSync(path.join(dir, name), 0o755);
      } catch {
        /* ignore on platforms without chmod semantics */
      }
    }
  }
}

/** Copy a single template-relative path (file or dir) into .ddev, overwriting. */
function copyRel(rel, ddevDir, written) {
  const src = path.join(TEMPLATE_DIR, rel);
  if (!fs.existsSync(src)) return;
  const dest = path.join(ddevDir, rel);
  if (fs.statSync(src).isDirectory()) {
    copyTree(src, dest, (f) => written.push(f));
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    written.push(dest);
  }
}

// Provider variant that also rsyncs the uploads/ directory down (offline media).
function downloadModeProvider() {
  const base = fs.readFileSync(path.join(TEMPLATE_DIR, 'providers', 'wpengine.yaml'), 'utf8');
  const uploadsBlock = [
    '',
    '    uploads_path="/home/wpe-user/sites/${WPENGINE_ENV}/wp-content/uploads/"',
    '    uploads_src="${ssh_config}:${uploads_path}"',
    '    uploads_dest="/var/www/html/wp-content/uploads"',
    '    mkdir -p "$uploads_dest"',
    '    rsync -azP "$uploads_src" "$uploads_dest"',
  ].join('\n');
  // Append the uploads rsync to the end of files_pull_command's script block,
  // right after the plugins rsync line.
  return base.replace(
    /(rsync -azP --exclude 'wordfence' "\$plugins_src" "\$plugins_dest")/,
    `$1\n${uploadsBlock}`
  );
}

/**
 * Generate .ddev/ in repoPath from the templates.
 * opts: { projectName, wpengineEnv, remoteDomain, wpVersion, phpVersion,
 *         mysqlVersion, mediaMode: 'proxy'|'download' }
 */
export function generate(repoPath, opts) {
  const ddevDir = path.join(repoPath, '.ddev');
  const written = [];
  copyTree(TEMPLATE_DIR, ddevDir, (f) => written.push(f));

  // Render config.yaml from the template.
  fs.writeFileSync(path.join(ddevDir, 'config.yaml'), renderConfig(opts));

  // In download mode, swap in a provider that also pulls uploads.
  if (opts.mediaMode === 'download') {
    fs.writeFileSync(path.join(ddevDir, 'providers', 'wpengine.yaml'), providerYaml('download'));
  }

  makeExecutable(ddevDir);
  return { ddevDir, fileCount: written.length };
}

/**
 * Re-sync the wizard-managed .ddev files from the templates onto an EXISTING
 * scaffold, healing drift when the wizard ships a fix but a project's deployed
 * copy is stale (the classic case: an old `update-db` that runs `ddev pull`'s
 * built-in import, which mangles the DB name on Windows).
 *
 * Overwrites only MANAGED_PATHS plus the provider; leaves config.yaml,
 * wp-config.php and the runtime SSH state untouched. copyTree never deletes, so
 * project-specific extra commands (pma, install-ray, …) are preserved. The
 * provider is re-synced mode-aware — a download-mode project keeps its uploads
 * rsync. Returns { fileCount }.
 */
export function syncManaged(repoPath) {
  const ddevDir = path.join(repoPath, '.ddev');
  const written = [];
  for (const rel of MANAGED_PATHS) copyRel(rel, ddevDir, written);

  // Provider: preserve the project's current media mode (detected from the
  // deployed file — the download variant contains an `uploads_dest` rsync).
  const providerPath = path.join(ddevDir, 'providers', 'wpengine.yaml');
  let mediaMode = 'proxy';
  try {
    if (fs.readFileSync(providerPath, 'utf8').includes('uploads_dest')) mediaMode = 'download';
  } catch {
    /* no existing provider — default to proxy */
  }
  fs.mkdirSync(path.dirname(providerPath), { recursive: true });
  fs.writeFileSync(providerPath, providerYaml(mediaMode));
  written.push(providerPath);

  makeExecutable(ddevDir);
  return { fileCount: written.length, mediaMode };
}
