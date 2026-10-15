# ADR 0001 — Decentralised releases on ngit, approved by the owner's signature

- **Status:** Proposed (draft started 2026-10-15; nothing here is built yet)
- **Owner:** Chiefmonkey (`npub1a3um269aaf3u5cy37kuykrrrnsg2pyv7za06pxjduv25lq5sdujs2qmdj6`)
- **Supersedes, once accepted:** the GitHub-only release path in v1.3.x
  (`refresh-data.yml` → PR → `release.yml` → `deploy-flock-map.yml`)

## Context

Flock Map is a public-interest map of licence-plate reader (ALPR) cameras. It
should keep working if any single company, host or account disappears.

Today (v1.3.2) every moving part runs on GitHub:

| Part | Where it runs now |
| --- | --- |
| Source of truth for code and data | GitHub `ChiefmonkeyArt/flock-map` |
| Weekly data refresh | GitHub Actions (`refresh-data.yml`) |
| Owner approval | Pressing **Merge** on a GitHub pull request |
| Tag + deploy | GitHub Actions (`release.yml` → `deploy-flock-map.yml`) over a restricted SSH key |
| Napplet publication | Owner signs kind 35129 + 30617 by hand, now and then |

What is already independent of GitHub:

- **The data.** It comes straight from OpenStreetMap (ODbL), the same source
  DeFlock reads. It does not depend on DeFlock or on GitHub. Several
  independent Overpass servers can answer the query, and the full planet file
  can be mirrored by anyone.
- **The live site.** It is served from the owner's VPS, not GitHub Pages.

Facts this decision relies on:

- GitHub Actions is free for public repositories, and the announced fee for
  self-hosted runners was postponed ([GitHub](https://github.com/resources/insights/2026-pricing-changes-for-github-actions)).
  Cost is therefore not the driver; resilience and independence are.
- ngit hosts repositories on GRASP servers (a Nostr relay plus a git server).
  A repo can list several, and the signed state on Nostr says which commit is
  authoritative ([ngit docs](https://ngit.dev/repositories)).
- ngit v3 (8 Sept 2026) added ngit-ci for self-hosted checks, plus signed
  release records that can point to Blossom files ([Nostr Compass #39](https://nostrcompass.org/en/newsletters/2026-09-09-newsletter/)).

## Decision

Move the release path to ngit and the owner's own VPS. Keep GitHub as a
read-only mirror. The owner's Nostr signature replaces the GitHub Merge button
as the only gate to the live site.

### 1. Identities

| Key | Who holds it | What it may do |
| --- | --- | --- |
| Owner `npub1a3um…` | Plebeian Signer (browser extension) | The only maintainer in the repo announcement. Signs repo state (kind 30618), so only the owner can move `main` or tags. Signs the napplet event (kind 35129). |
| Refresh bot (new npub) | VPS only: root-owned, mode 0600, never in git | Signs data-refresh pull requests (NIP-34 PR events) and status comments. **Not** a maintainer, so it cannot move `main`. |

No owner key ever touches the VPS, GitHub or any repo.

### 2. Hosting

- Announce the repo with `ngit` under the owner's npub, listing **at least 3
  GRASP servers** (for example relay.ngit.dev, gitnostr.com,
  git.shakespeare.diy) plus `wss://chiefmonkey.art/relay`.
- Keep `https://github.com/ChiefmonkeyArt/flock-map.git` as an additional clone
  URL, so it becomes a mirror rather than the source.
- Later, optionally run `ngit-grasp` on chiefmonkey.art as one more server.

### 3. Weekly refresh runs on the VPS

- A systemd timer (Mondays) on the VPS runs the existing
  `tools/refresh-osm.mjs`, with the same safety checks: refuse fewer than
  50,000 cameras or a drop of more than 25%.
- It rebuilds, runs the tests, commits to a branch, and publishes the change as
  an ngit pull request signed by the refresh bot.
- It runs as an unprivileged service user. It can write only its working copy,
  and has network access only to Overpass, the GRASP servers and the relay.

### 4. Approval means signing

- An approval page at `chiefmonkey.art/flock-map/approve/` shows the pending
  refresh: data date, camera counts, the changes, and the commit hash.
- **Approve** asks Plebeian Signer for one batch of signatures:
  1. a repo-state event (kind 30618) moving `refs/heads/main` and adding tag
     `vX.Y.Z` at that exact commit;
  2. a NIP-34 "merged" status on the bot's pull request;
  3. the refreshed napplet event (kind 35129).

  That folds the napplet re-signing into the weekly approval, so it never goes
  stale again.
- The page publishes the signed events to the repo's relays and GRASP servers.

### 5. The VPS deploys only what the owner signed

A small root-owned watcher on the VPS subscribes to the repo's state events and
acts only when **all** of these hold:

1. the event is kind 30618 and validly signed by the owner pubkey (hard-coded,
   not read from the network);
2. it is newer than the last one acted on (no replays);
3. its tag `vX.Y.Z` matches the commit for `main`;
4. the VPS fetches that commit from a GRASP server and verifies the object
   hash;
5. a fresh `tools/build.mjs --check` on that commit reproduces the committed
   files byte-for-byte. The VPS never trusts pre-built output, not even its own
   bot's.

It then installs `index.html`, `cams.js`, `manifest.json` and `VERSION` through
the **existing** pinned root installer (same whitelist, atomic switch,
rollback). After that, it pushes the commit and tag to the GitHub mirror.

The end state stays VPS == tag == main, where "main" now means the
owner-signed ngit state.

### 6. Copies for others

Each approved release also uploads `cams.js`, `napplet/index.html` and the
source data to at least two Blossom servers, and the napplet event lists them.
Anyone can mirror or self-host the map from those hashes.

## Security notes

- **Compromised refresh bot or VPS user:** it can propose pull requests, but
  cannot move `main` or deploy, because both require the owner's signature
  over a specific commit.
- **Compromised GRASP server:** it cannot change the code. Hashes are checked
  against the owner-signed state, and other servers hold the same objects.
- **Compromised GitHub:** it becomes irrelevant to deployment, being a mirror
  only.
- **Malicious OpenStreetMap edits:** the existing count guards stay, and a
  human approves every release. Camera fields are already stripped of
  control characters, and the page metadata is validated before the build.
- **New root code:** the watcher is new root-level code. It needs a one-time
  bootstrap approved by the owner, the same as the current installer.

## Phases

| Phase | What | Needs from the owner |
| --- | --- | --- |
| 0 | This ADR reviewed and accepted | Read and say yes |
| 1 | Announce the repo on ngit (3+ GRASP servers + own relay, GitHub as mirror) | One signature |
| 2 | Refresh bot key + VPS timer posting ngit pull requests (GitHub weekly job kept as backup) | Approve the one-time VPS setup |
| 3 | Approval page + VPS watcher + Blossom copies | Approve the one-time VPS setup, then sign the first real approval |
| 4 | Switch off the GitHub weekly and release jobs; GitHub is mirror-only | Say yes |

Until phase 4, the current GitHub path keeps working unchanged.

## Alternatives considered

- **Stay on GitHub only.** Simple, but one company can halt updates or remove
  the repo.
- **Run ngit-ci instead of a custom timer.** ngit-ci reacts to Nostr events, not
  schedules. We may adopt it later to run the tests on pull requests; the
  weekly trigger stays a timer either way.
- **Make the bot a co-maintainer.** It would deploy without the owner, which
  removes the human approval the owner requires. Rejected.
- **Approve with a NIP-46 bunker instead of the browser.** Possible later, but
  the owner signs with Plebeian Signer in the browser (NIP-07) today.

## Open questions

1. Which GRASP servers to list. Proposal: relay.ngit.dev, gitnostr.com,
   git.shakespeare.diy, plus chiefmonkey.art later.
2. Which Blossom servers, in addition to blossom.primal.net.
3. Should the refresh bot get a public profile, such as "Flock Map refresh
   bot", so people can recognise its pull requests?
4. Should the approval page also live on Blossom as an nsite, so the owner can
   approve even if the VPS website is down?
