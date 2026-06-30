# WPEngine Local Env Wizard

A local dashboard that discovers your WP Engine installs, matches each to its
cloned repo, and spins up local **DDEV** WordPress environments **in parallel** —
turning a multi-hour, 15-site machine setup into a queue you start and walk away from.

## How it works (and why it's not the backup API)

The WP Engine *backup* API can't hand you a downloadable file — a completed
backup is delivered only as an emailed link. So instead this tool reuses the
proven mechanism already running in `playboycom/.ddev/`:

- **Database, plugins, and themes are pulled over SSH + rsync** via a DDEV
  provider (`<env>@<env>.ssh.wpengine.net:/home/wpe-user/sites/<env>/wp-content/`).
  Themes are pulled too because a site's active theme is often a premium theme
  that lives only on WP Engine, not in the git repo.
- **The DB is regenerated fresh from the live database** (`wp db export`) before
  pulling — WP Engine's static `wp-content/mysql.sql` snapshot can be badly stale.
- **The real table prefix is detected from the live `wp-config`** (WP Engine often
  uses a custom prefix like `wp_ab12cd_`, sometimes with a leftover `wp_` install
  in the same DB), so WordPress reads the correct tables.
- On Windows the DB is imported with `ddev import-db` rather than `ddev pull`'s
  built-in import, which mangles the database name (`Unknown command '\l'`).
- **The local PHP version matches the install's** (`php_version` from the API), so
  older sites (e.g. PHP 7.4) don't fatal on plugins that aren't PHP-8-compatible.
- **Plugins are always pulled** on `ddev start` (incremental rsync), so the local
  copy tracks production — including plugin updates.
- **`ddev start` orchestrates everything** through hooks: download WP core →
  write `wp-config.php` → pull + import DB → `wp search-replace` the live domain
  to the local `.ddev.site` URL → pull plugins → optional npm build.
- **Media (`/wp-content/uploads/`) is proxied from the live site** by nginx, so
  you don't download gigabytes of uploads (per-site `download` mode is available
  for offline work).

The wizard generalizes that `.ddev/` scaffold and drives it across many sites at
once. For a repo that already ships its own `.ddev/`, the wizard uses it as-is.

## Prerequisites

- **Node.js 18+** (already on your machine for npm builds) — runs the wizard.
- **DDEV** + **Docker Desktop** — the wizard drives `ddev` on the host.
- A **WP Engine SSH-gateway key** at `~/.ssh/wpengine_ed25519(.pub)`, registered
  in the WP Engine User Portal. See https://wpengine.com/support/ssh-gateway/.
- The **`gh` CLI**, authenticated (`gh auth login`) — used to clone client repos
  (over its HTTPS token, so no GitHub SSH key is required) and to regenerate the
  repo map. The WP Engine SSH key above is only for pulling the DB/plugins.
- **WP Engine API credentials** (User Portal → API Access).

The wizard runs **on the host** (not inside a container) because it must control
`ddev`, Docker, your SSH keys, and your project folders directly.

## Setup

```bash
cp .wpe-api.example .wpe-api          # fill in WPE_API_USER / WPE_API_PASSWORD
cp config.example.json config.json    # adjust projectsRoot, sshPubKey, concurrency
npm start                              # opens http://127.0.0.1:7878
```

No `npm install` needed — the wizard has **zero dependencies** (Node built-ins only).

## Using it

1. The dashboard runs a **preflight** check (ddev, Docker, SSH key) and lists
   every install from the WP Engine API, grouped by account, with each one's
   local-repo status (`repo ✓`, `will scaffold`, `no repo`).
2. **Select the sites** you want, tweak per-site options (repo path, WP version,
   media mode), optionally tick **Fresh DB export** to `wp db export` on the
   remote first, then **Set up selected**.
3. Jobs run in a **queue capped at `concurrency`** (default 3 — WP Engine allows
   only 5 SSH connections per user). Watch live per-site logs; click **Open site**
   when a job reaches `ready`.

### New-machine bootstrap

Every successful setup is recorded (secret-free) in `sites.json`. On a new
machine: clone this repo, drop in `.wpe-api` + your SSH key, then click
**Set up all from profile** — the wizard clones any missing repos (from the
stored git URLs) and brings up every env unattended. Keep `sites.json` committed.

### Repo mapping (`repo-map.json`)

WP Engine install slugs (`absolutemed`, `absolutemeddev`, …) don't match GitHub
repo names (`absolutemedical`), so the wizard ships a committed **`repo-map.json`**
mapping each install slug → `{ repo, sshUrl }` under your org. It's used to locate
the local clone (`<projectsRoot>/<repo>`) and to **auto-clone** a missing repo.

- It's **committed** so every developer inherits the matches — no per-person setup.
- Each install row shows its mapped repo in an editable field; fix a wrong/missing
  match inline and click **Save mapping** to persist it back to `repo-map.json`
  (commit the change to share it).
- Low-confidence guesses and unmatched installs live in the file's `review` section.
- **Regenerate** after adding clients (preserves your verified `installs` entries):

  ```bash
  node tools/build-repo-map.mjs            # needs the `gh` CLI authed to the org
  node tools/build-repo-map.mjs --overwrite   # rebuild from scratch
  ```

### Ongoing use

Re-running a site is safe and idempotent (the scaffold's `--initialize-only`
guards skip finished steps). Re-queue a site to refresh it.

## Configuration (`config.json`)

| Key | Meaning |
| --- | --- |
| `wpeCredsPath` | Path to the `.wpe-api` credentials file |
| `sshPubKey` | WP Engine SSH-gateway public key (`~` is expanded) |
| `projectsRoot` | Where client repos are (or get cloned) |
| `concurrency` | Max sites set up at once (≤5) |
| `defaultWpVersion` | WordPress version when not detectable |
| `phpVersion` / `mysqlVersion` | DDEV defaults for generated scaffolds |

## Layout

```
bin/wizard.js        entry — starts the server, opens the browser
src/                 server, wpengine API, repo map, scaffold, ddev wrappers, job queue, store
templates/ddev/      generalized playboycom DDEV scaffold (the thing that gets generated)
public/              dashboard SPA
tools/               build-repo-map.mjs — regenerate repo-map.json from gh + the API
repo-map.json        committed install-slug -> GitHub-repo mapping
```
