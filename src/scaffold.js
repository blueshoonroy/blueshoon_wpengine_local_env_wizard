// Detect an existing .ddev/ WP Engine scaffold, or generate one from templates.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './store.js';

const TEMPLATE_DIR = path.join(ROOT, 'templates', 'ddev');

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
    fs.writeFileSync(path.join(ddevDir, 'providers', 'wpengine.yaml'), downloadModeProvider());
  }

  // Make command scripts + entrypoints executable (no-op on Windows, but
  // matters once the repo is used on macOS/Linux too).
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
  return { ddevDir, fileCount: written.length };
}
