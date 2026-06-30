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

## 🐕 Rello! Scooby's Retup Rinstructions

Rello rgang! Scooby-Dooby-Doo rhere to relp rou ret up the rizard — rocal DDEV
ropies of rour WP Engine rites (rdatabase, rplugins, rthemes, the rhole Scooby
Snack). The rizard runs **on the rhost** (not in a rcontainer), rbecause it rmust
rcontrol `ddev`, Docker, rour SSH keys, and rour rproject rfolders rdirectly.

> Scooby rsays: the rcommands in the rgrey rboxes are *real* — ropy-paste 'em
> rexactly. Runly Scooby's rtalking is rfull of Rs. Reah!

### 🦴 Rrequirements (get these first, or... ruh-roh!)

- **RNode.js 18+** — runs the rizard. (`node -v`)
- **RDDEV + RDocker Desktop** — does the rocker ragic. (`ddev version`, and rmake rsure Docker is **running**!)
- **GitHub CLI (`gh`), rauthenticated** — rclones rclient repos rover HTTPS, so rou *don't* rneed a GitHub SSH key. (`gh auth status` → rif ruh-roh, run `gh auth login`)
- **R WP Engine SSH key** at `~/.ssh/wpengine_ed25519(.pub)`, radded in the WP Engine Ruser Rortal. This runly rpulls rsite rfiles (DB, rplugins, rthemes).
- **R WP Engine API rcredentials** — Ruser Rortal → **API Access**.

> Ruh-roh: the GitHub key and the WP Engine key are **two different keys**! Don't rmix 'em up. 🐶

### 🐾 Rstep 1 — Rclone the rizard

```bash
git clone https://github.com/blueshoonroy/blueshoon_wpengine_local_env_wizard.git
cd blueshoon_wpengine_local_env_wizard
```

No `npm install` rneeded — the rizard has **rero rdependencies** (runly Node built-ins). Rummy!

### 🐾 Rstep 2 — Radd rour rcredentials

```bash
cp .wpe-api.example .wpe-api    # then edit: WPE_API_USER / WPE_API_PASSWORD
```

This rfile is **gitignored**, so rour rsecrets ray rsafe. Reah!

### 🐾 Rstep 3 — Rconfigure

```bash
cp config.example.json config.json
```

Redit `config.json` rif rour rsetup differs — `projectsRoot` (rwhere repos rlive),
`sshPubKey` (rour WP Engine rpublic key), and `concurrency` (**3** is rgreat; WP
Engine rallows runly 5 SSH rconnections).

### 🐾 Rstep 4 — Rstart it!

```bash
npm start                       # opens http://127.0.0.1:7878
```

**Rscooby-dooby-doo!**

### 🐾 Rstep 5 — Rmake a rocal rite

1. The rdashboard rshows revery **rproduction** rite from WP Engine (rwith a rpreflight rcheck of ddev/Docker/SSH).
2. Rfind rour rite in the rfilter rbox. Rmake rsure the **GitHub rrepo rname** rlooks rright — rif not, rtype it and rit **Save mapping** (rit rsaves for the *rwhole rteam* in `repo-map.json`!).
3. Rcheck the rites rou rwant, then rit **Set up selected**. Rit rclones rmissing repos rautomatically.
4. Rwatch the rqueue rstream the rogs. Rwhen it rsays **READY**, rit **Open site** — rta-da! 🦴

### 🐶 Ruh-roh! Rroubleshooting

- **`php 8.2 ≠ 8.4` rbadge?** Rit **⚙ Fix PHP** — rit rmatches rocal PHP to rproduction. (Rold rites rneed PHP 7.4 or their rplugins go *rfatal* and the rpage goes rwhite.)
- **Rimages?** They rproxy from rproduction rautomatically — no rdownload rneeded. (Ror rpick the per-rite **download** rmedia rmode for roffline rwork.)
- **Rwant rfresh rdata?** Rit **↻ Refresh DB** on a rite — rit rpulls the *ratest* rproduction rdatabase.
- **Rblank rbody, runly rheader & rfooter?** The rplugins rprobably rdidn't rpull — re-run rsetup, or run `ddev pull wpengine --skip-db --skip-import -y` in the rite rfolder.
- **Rpulled rnew rode?** Rstop the rserver (`Ctrl+C`) and `npm start` ragain — the API routes rload at rstartup.

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
