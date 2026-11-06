# Upstream compatibility gate

This repository depends on two moving upstreams: `@earendil-works/pi-coding-agent` (the Pi
runtime the host embeds) and `@deepseek-ai/dsh` (the harness the host plugs into). Both are
prerelease-heavy, and both have already shipped contract changes that break this host without a
type error appearing in our own code.

The gate exists so a new upstream release is discovered by CI, not by a user following the README.

## What is declared, and where

[`src/support.ts`](../src/support.ts) is the single machine-readable declaration:

| Field | Meaning |
|---|---|
| `pinned` | the exact version this repository builds, tests, and publishes against |
| `range` | the range a user may reasonably expect to work |
| `newest` | the newest release line inside `range` that has been verified |

`package.json`, `README.md`, `docs/compatibility.md`, and this gate all have to agree with that
file. `src/__tests__/support.test.ts` fails when they drift, so a version bump cannot land with
stale documentation.

## The three checks

```sh
pnpm compat:upstream   # registry and declaration drift, read-only, no install
pnpm smoke:install     # clean-room install of this version, then list mounted Pi tools
pnpm check             # unit, adapter, lifecycle, resolver, and support-declaration tests
```

`pnpm compat:upstream` distinguishes two different findings, and exits non-zero only for the
first:

- **drift** — this repository and the published package disagree, or `package.json` disagrees with
  `src/support.ts`, or a newer release exists inside the declared range. Someone must act.
- **notice** — upstream published a release outside the declared range (a new major line). That is
  an evaluation decision, not an automatic bump.

`pnpm smoke:install` performs the README install path in a clean room — fresh npm cache, fresh
pnpm store, fresh `DSH_HOME` — then loads the installed bundle and lists the Pi extension tools it
mounts. It never contacts a model provider, so it is safe to run on a schedule. Pass
`--pi-version <version|latest>` to override the profile's Pi resolution before listing tools;
that is how a break in a not-yet-adopted upstream line is detected early.

`scripts/compat/Dockerfile` wraps the same script for a fully disposable environment:

```sh
docker build -f scripts/compat/Dockerfile -t dsh-pi-compat .
docker run --rm dsh-pi-compat --host-spec latest
```

## How a new upstream release is detected

`.github/workflows/upstream-compat.yml` runs on a daily schedule, on `workflow_dispatch`, and on
`repository_dispatch` of type `upstream-release`. It runs:

1. `pnpm check` and `pnpm compat:upstream` — declaration and registry drift.
2. `pnpm smoke:install` — the pinned version still installs and mounts a Pi tool.
3. `pnpm smoke:install --pi-version latest` — the newest upstream Pi still loads the host and a
   real published Pi extension.

Step 3 is the early warning: it passes while the pin matches upstream and turns red as soon as a
newer upstream release breaks the host, so the failure record exists before anyone bumps the pin.

The host also refuses an out-of-range Pi at load time, so a profile that hoists or overrides Pi
fails with a named version instead of mounting tools and breaking later. The gate and that guard
cover the same failure from two directions: the gate proves a candidate version works, and the
guard proves an unsupported one is rejected.

Known limits of this automation, stated so nobody assumes more coverage than exists:

- GitHub only evaluates `schedule` triggers on the default branch, so the scheduled runs start
  after this workflow is merged. Until then the gate is `workflow_dispatch`-only.
- The paid end-to-end model check lives in `.github/workflows/dsh-smoke.yml` and stays
  `pull_request`-triggered. It needs provider credentials and spends money, so it is not part of
  the daily schedule. A PR that changes the Pi pin runs it automatically.
- `repository_dispatch` requires an external watcher to send the event. Nothing in this repository
  publishes it; the schedule is the reliable trigger today.

## When a gate run fails

1. Read which step failed. `compat:upstream` names the package, the observed version, and the
   declared value.
2. If a newer release inside `range` exists: read that release's changelog, run
   `pnpm smoke:install --pi-version <version>`, and bump `pinned`/`newest` in `src/support.ts`
   together with `package.json` and the two documentation tables.
3. If the failure is in step 3 only (upstream outside `range`): decide whether to adopt the new
   line. Adopting means repeating the contract migration described in
   [`docs/compatibility.md`](./compatibility.md#pi-1x-contract), not editing a version string.
4. If a step fails for environment reasons (registry outage, missing tool), rerun it. Do not widen
   the declared range to make a red gate green.

## Release checklist

A release is only complete when the default install resolves to the published version. The
registry's `latest` tag is not moved by `npm publish` for prereleases, so it must be promoted
deliberately.

1. Bump `version` in `package.json`; update `src/support.ts` if an upstream pin changed.
2. `pnpm check` and `pnpm compat:upstream`. Fix drift before tagging.
3. Push a tag that exactly matches the version (`v0.1.0-rc.4`). `release.yml` re-runs the checks,
   validates the tag, and publishes with `next` for prereleases and `latest` for stable versions.
4. Promote the default install:

   ```sh
   npm dist-tag add dsh-pi-host@<version> latest   # `next` for a prerelease
   npm view dsh-pi-host dist-tags
   ```

   `npm-tag.yml` performs the same promotion from a workflow dispatch.
5. `pnpm compat:upstream` must report no drift. It compares the repository version against the
   `latest`/`next` tag it expects, so a forgotten promotion fails the gate instead of silently
   shipping the previous release to new users.
6. Update the README install command to the published version. `src/__tests__/support.test.ts`
   keeps the manifest and the documentation tables consistent; the install command is checked by
   `pnpm smoke:install`, which installs exactly that version.

## Publishing is not automated by this gate

The gate reads the registry. It never publishes, promotes a tag, or writes to a DSH profile outside
its own temporary directory. `npm publish` and `npm dist-tag add` remain release-owner actions.