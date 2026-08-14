# DSH Pi Host — Agent Guidelines

## Project

`dsh-pi-host` runs trusted, unmodified Pi extensions inside DeepSeek Harness (DSH). It is a compatibility host, not a source converter: Pi's official loader and `ExtensionRunner` own Pi behavior, while this package adapts observable tools, commands, messages, attachments, and lifecycle events into agent-scoped DSH capabilities.

The project targets Node.js 22+, Pi `0.80.x`, and DSH `0.1.0-rc.6`. DSH is still a developer preview, so keep its peer range narrow unless compatibility has been verified.

## Required Skills

Use both skill sets for all development and review work in this repository. Install them in the active agent harness before starting; if installation is unavailable, follow the rules below directly.

### ponytail — minimal-code discipline

Source: <https://github.com/DietrichGebert/ponytail>

Apply ponytail after reading the affected flow:

1. Skip speculative work.
2. Reuse an existing seam or helper.
3. Prefer the standard library or native platform.
4. Prefer an installed dependency over a new one.
5. Only then write the smallest complete change.

Do not simplify away trust-boundary validation, cancellation, data-loss prevention, error sanitization, output bounds, or a regression check. Avoid unrelated refactors, speculative abstractions, and new dependencies for one-call problems.

Install:

- Claude Code: `/plugin marketplace add DietrichGebert/ponytail`, then `/plugin install ponytail@ponytail`.
- Codex: `codex plugin marketplace add DietrichGebert/ponytail`, install Ponytail from `/plugins`, then review and trust its hooks under `/hooks`.

### mattpocock/skills — engineering workflow

Source: <https://github.com/mattpocock/skills>

Use the matching skill when the task calls for it:

- `diagnosing-bugs`: reproduce and isolate the root cause before fixing a bug.
- `tdd`: make behavior changes in a red-green-refactor loop.
- `codebase-design`: design or change module boundaries and public interfaces.
- `research`: answer uncertain technical questions from primary sources.
- `code-review`: review the fixed-point diff on both Standards and Spec axes.
- `resolving-merge-conflicts`: resolve an active merge or rebase by intent.
- `to-spec` / `to-tickets`: shape non-trivial or multi-stage work before implementation.

Install for Codex and other agents with `npx skills@latest add mattpocock/skills`; include `setup-matt-pocock-skills`, then run `/setup-matt-pocock-skills` once for this repository. Claude Code may instead install the managed `mattpocock-skills` plugin. Do not commit installer-generated skill files unless the team explicitly adopts them as repository-local tooling.

## Source Map

- `src/index.ts`: DSH plugin composition and Pi-to-DSH lifecycle reconciliation.
- `src/runtime.ts`: Pi loader, runner, context, and per-extension runtime.
- `src/dsh-adapter.ts`: tool result, error, cancellation, update, and attachment adaptation.
- `src/schema.ts`: fail-closed TypeBox/JSON Schema projection into DSH's supported subset.
- `src/resolver.ts`: explicit package and local-path resolution.
- `src/capabilities.ts`: machine-readable compatibility claims.
- `src/compatibility.ts` and `scripts/compat.ts`: read-only Pi workspace inventory.
- `src/__tests__/`: unit, adapter, lifecycle, resolver, and optional workspace-fixture tests.
- `README.md` and `docs/compatibility.md`: user-facing support matrix and design rationale.

## Compatibility Rules

- Treat `../pi` and `PI_FIXTURE_WORKSPACE` as read-only fixtures. Never modify, build into, or clean the Pi workspace from this repository's tests or scripts.
- Load only explicitly configured extensions. Never auto-discover project-local Pi code.
- Keep `allowLocalPaths` and `projectTrusted` separate. Local paths authorize trusted Node.js code loading; project trust authorizes project-local Pi settings and policies.
- Adapt observable behavior through Pi's public loader and runner. Do not reimplement Pi internals or parse extension source as a substitute for execution.
- Fail closed when DSH cannot preserve a Pi schema or contract. In non-strict mode, skip and report the unsupported capability; never silently widen or pretend support.
- Preserve cancellation and lifecycle ordering across the bridge. Teardown must drain required work and must not remount registrations.
- Bound all model-visible text and persisted details. Reject oversized images before decoding, and never expose raw exceptions, stack traces, response bodies, credentials, or user content.
- Keep `src/capabilities.ts`, `README.md`, and `docs/compatibility.md` aligned whenever support status changes.
- Preserve public exports, bundle configuration, settings, and compatibility behavior unless a breaking change is explicit.

## Code and Tests

- TypeScript is strict ESM with NodeNext resolution. Keep `.js` suffixes on relative imports.
- Follow the local style; do not add formatting or lint tooling unless requested.
- Put tests in `src/__tests__/` and use Vitest with `describe`, `it`, and `expect`.
- For behavior changes, add the smallest regression test at the public seam. Prefer fixture extensions under `src/__tests__/fixtures/` when lifecycle behavior is involved.
- Tests must not invoke paid provider work or depend on secrets.
- Keep external Pi workspace tests optional behind `PI_FIXTURE_WORKSPACE`.

## Verification

Run the narrowest relevant test first, then the repository gate:

```sh
pnpm vitest run src/__tests__/<name>.test.ts
pnpm check
```

For compatibility inventory or representative Pi smoke tests:

```sh
PI_FIXTURE_WORKSPACE=/absolute/path/to/pi pnpm test
pnpm compat /absolute/path/to/pi
```

Before handoff, inspect `git diff HEAD` and keep unrelated user changes untouched.
