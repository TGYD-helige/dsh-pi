# Compatibility matrix

Status meanings:

- **supported** — the Pi-visible behavior maps through the official Pi runtime and has a DSH counterpart.
- **partial** — useful behavior maps, but at least one caller-visible semantic differs.
- **unsupported** — the host refuses or reports the gap; it does not pretend the operation succeeded.

The executable source of truth is [`src/capabilities.ts`](../src/capabilities.ts). Tests ensure every API/event used by the current Pi fixture workspace has an entry in that matrix.

## Supported upstream versions

| Component | Supported | Built and tested against | Evidence |
|---|---|---|---|
| Pi coding agent (`@earendil-works/pi-coding-agent`) | `>=1.5.0 <2.0.0` | `1.5.0` | `package.json` pin, `pnpm-lock.yaml`, `pnpm check` |
| DeepSeek Harness (`@deepseek-ai/dsh`) | `0.1.5-rc.2` | `0.1.5-rc.2` | `@deepseek-ai/dsh-*` peers at `^0.1.5-rc.2`; CI installs `@deepseek-ai/dsh@0.1.5-rc.2` |
| Node.js | `>=22.19.0` | `22.19.0` in CI | `package.json#engines`, workflow `node-version` |
| pnpm | `10.x` | `10.28.2` in CI | `pnpm/action-setup` and the release workflow |

The declaration lives in [`src/support.ts`](../src/support.ts); `src/__tests__/support.test.ts` fails when `package.json`, this table, or the README disagree with it. `pnpm compat:upstream` checks the published state against the same declaration.

## Pi 1.x contract

Measured 2026-11-06 against `@earendil-works/pi-coding-agent@1.5.0` (registry `latest`) and the previously pinned `0.80.10`. The host now builds against the `1.x` contract. These changes are why `0.80.x` is out of range rather than silently accepted:

1. `ExtensionRunner.emitBeforeAgentStart` changed from `(prompt, images, systemPrompt, systemPromptOptions)` to `(trigger, systemPromptOptions)` and renders the event's system prompt from normalized options. A `0.80.x` call shape fails immediately with `Cannot read properties of undefined (reading 'customPrompt')`. The host now passes a `messageType: 'user'` trigger and an explicitly forced empty prompt, so DSH keeps owning the system prompt.
2. `ExtensionActions` gained a required `getSettings`, and `ExtensionContextActions` gained a required `getScopedModels`. The host answers them from an in-memory Pi settings manager and an empty model scope list, because DSH owns model routing.
3. `ExtensionToolContext` (tool execution context) gained `tools` and `executeTool`; tools now run against `createToolContext(callId, signal)` instead of a bare `createContext()`.
4. `ToolInfo` reports `exposure`, `namespace`, and `annotations`; adapted tool catalog entries now pass them through, defaulting to `direct` exposure.
5. `turn_end` became a boundary event (`entries`, `continue`, `context`, `outcome`, entry ids) and `agent_settled` gained `aborted`. The host reports boundaries without offering Pi-owned entries, which keeps item 3 of the event table below accurate.
6. `RunnerEmitEvent` is narrower than `ExtensionEvent`. Events the host projects itself (`turn_end`, `agent_settled`) are forwarded through a widened call; see the event rows below for what that costs.
7. A DSH profile can hoist or override Pi to a version the host was not built for, and `0.80.10` in that position still imports, still registers tools, and still lists them. The host therefore compares the loaded `VERSION` against the declared range (`src/support.ts`) at load time and throws `Unsupported @earendil-works/pi-coding-agent <version>: this host requires >=1.5.0 <2.0.0` before any extension runs.

The declared range is checked at load, not only at publish time: `pnpm smoke:install --pi-version 0.80.10` is the regression case that proves the refusal still fires.

Still outside the package `exports` map: `src/runtime.ts` imports `dist/core/extensions/loader.js` by path because the loader is not exported. This is unchanged from `0.80.x` and is covered by `pnpm check` plus `pnpm smoke:install` on every compatibility run.

## ExtensionAPI methods

| Area | Status | Notes |
|---|---|---|
| `registerTool` | partial | Execution, TypeBox validation, strict schema projection (including mutually exclusive literal unions and numeric bounds `minimum`/`maximum`/`exclusiveMinimum`/`minItems`; `$schema` draft markers are dropped), argument preparation, cancellation, sanitized errors, ordered updates, images, concurrency, active sets, and lifecycle-time registration/replacement. Successful text is bounded to 50KB/2000 lines, oversized details are omitted, and images are checked against DSH attachment limits before decoding. Overlapping unions, validation keywords outside DSH's enforced subset, and other unrepresentable schemas fail closed. Pi TUI renderers and DSH live update cards do not. |
| `registerCommand` | partial | Handlers, sanitized unexpected failures, and `ctx.ui.notify` text map to DSH command responses. Pi completions and interactive dialogs do not. |
| flags | supported | `registerFlag` / `getFlag` defaults plus configured overrides use Pi's store. |
| active tools/catalog | partial | Active names are filtered and adapted Pi registrations reconcile into DSH. Catalog entries pass through Pi's `exposure`, `namespace`, and `annotations` (default `direct` exposure). Catalog APIs expose Pi extension tools/commands only, not DSH-native tools, commands, skills, or templates. |
| `sendUserMessage` | supported | Text/images become identified DSH plugin messages; images use the attachment service. |
| `sendMessage` | partial | Non-waking idle injection, trigger-turn, follow-up, steering, and native next-turn delivery map. Attachment persistence is drained at lifecycle boundaries and delivery is suppressed after disposal begins; durable Pi custom entries, `display`, and custom renderer details do not map. |
| `exec` | supported | Uses Pi's own child-process implementation and options. |
| `appendEntry`, session name, labels | partial | Available in the embedded in-memory Pi session; not written into DSH's durable event vocabulary. |
| model selection | partial | Provider/model ids update DSH agent options, but only an installed DSH adapter makes that route real. |
| thinking level | partial | Pi-side state only. |
| provider registration | unsupported | A Pi `ProviderConfig` is not a DSH `LlmAdapter`; install/configure `@deepseek-ai/dsh-llm-pi-ai` instead. |
| shortcuts and Pi renderers | unsupported | DSH has no equivalent keyboard registry, and replayable DSH views cannot run Pi TUI components. |
| extension EventBus | supported | Supplied directly by Pi's official loader. |

## ExtensionContext

| Area | Status | Notes |
|---|---|---|
| `ui` | partial | Command `notify` text maps; dialogs and Pi TUI controls use the no-op UI context. |
| `mode` | partial | Reports the embedded Pi mode rather than a DSH client identity. |
| `hasUI`, `cwd` | supported | Correctly reports no Pi dialog UI and uses the DSH agent working directory. |
| `sessionManager` | partial | In-memory Pi state only; DSH durable history is not projected. |
| `modelRegistry` | partial | Pi provider registrations are recorded, but DSH adapters, catalog, and auth are unavailable. |
| `model` | unsupported | No selected Pi model object is synthesized. |
| idle, wait-for-idle, trust, signal, abort, pending messages | supported | Mapped to DSH agent status/settlement, explicit trust config, invocation cancellation, and inbox state. |
| `shutdown` | partial | Cancels the current DSH agent operation without exiting the process. |
| context usage, compact, effective system prompt | unsupported | No faithful projection is wired. |
| command context session controls and reload | unsupported | Pi tree/session mutation and plugin reload do not map to DSH ownership, so calls fail explicitly; prompt options expose cwd only. |

## Events

| Event group | Status | Notes |
|---|---|---|
| `session_start` | supported | Per-agent and awaited before the first DSH step; re-emitted after `session_shutdown` on DSH resume/clear/compact. |
| `session_shutdown` | partial | Emitted with the transition reason before each DSH resume/clear/compact restart and drained during teardown; teardown itself is reported with Pi reason `quit`. |
| `input` | partial | `continue`, `handled`, and text/image transform run once for the initial claimed DSH message batch. Text is newline-joined, images are preserved, and a transform replaces the batch with one new DSH message identity. |
| `agent_start`, `turn_start` | supported | Mapped from DSH turn/step boundaries. |
| `agent_settled` | partial | Emitted after `agent_end` at a committed DSH turn end when the inbox has no pending messages, with `aborted` derived from the DSH turn reason; Pi and DSH queue semantics still differ. |
| `agent_end`, `turn_end` | partial | The committed DSH `turn/end` closes the final Pi step and agent run on success, error, or cancellation. Each DSH step gets a paired Pi turn boundary and text history maps; exact Pi provider usage, image replay, and reconstructed `toolResults` do not yet. Pi `1.x` boundary fields (`entries`, `continue`, `context`, entry ids) are reported empty because DSH owns the durable session and the host does not apply entries a handler returns. `agent_before_settle` is not emitted at all. |
| tool result and execution start/end | supported | Runs around every adapted tool call, including failures and cancellation. |
| tool call | partial | Blocking works; DSH freezes arguments, so Pi handlers cannot reliably mutate input in place. |
| tool execution update | partial | Pi handlers see and finish each `onUpdate` before the terminal event; DSH has no matching tool-owned streaming callback. |
| `before_agent_start` | partial | Handler runs once per agent run, but system-prompt replacement and returned custom messages are not applied yet. |
| `project_trust` | partial | Config is the authoritative trust decision; interactive trust handlers are not run. |
| `resources_discover` | partial | Handlers run, but returned Pi skill/prompt/theme paths are not mounted into DSH registries. |
| session switch/fork/tree/compaction events | unsupported | DSH owns different durable operations and veto contracts. |
| context/message mutation events | unsupported | DSH reconstructs model-visible history from durable events; mutable Pi arrays cannot safely replace it. |
| provider request/header/response events | unsupported | These belong inside a DSH LLM adapter. |
| model/thinking selection and `user_bash` | unsupported | No faithful event boundary is wired yet. |

## Current fixture evidence

The read-only inventory on `/Users/weaxs/Desktop/Workspace/pi` found 17 `packages/pi-*` packages, 11 used API methods, and 18 used events. Representative built-entry smoke tests loaded:

- `pi-image-gen`: `image_generate`, `/image-gen`
- `pi-video-gen`: all four Pi tools load and mount — `video_generate`'s numeric duration bounds pass through to the model-facing schema, `/video-gen`
- `pi-goal`: `/goal`
- `pi-memory`: four tools, including its TypeBox literal-union schemas, `/memory`
- `pi-task-scheduler`: six tools, including its TypeBox literal-union schemas, `/cron`
- `pi-channels`: `notify` with literal-union actions, `/channel`

Two built fixtures fail before the compatibility layer runs:

- `pi-browser-use/dist/index.js` references missing `./analyze-screenshot.js`
- `pi-computer-use/dist/index.js` references missing `./config.js`

Those are stale/incomplete fixture build artifacts. This repository does not rewrite or rebuild the source workspace to hide such failures.

## Next implementation order

1. Map DSH system-prompt assembly to Pi `before_agent_start` and `context` without breaking durable reconstruction.
2. Add a declared DSH projection/event package for durable Pi custom entries and session metadata.
3. Reconstruct full Pi assistant/tool messages from DSH session events for `agent_end` and `turn_end`.
4. Add explicit adapters for DSH provider/request events rather than translating `registerProvider` implicitly.
5. Add optional UI packages for commands/render intents; keep Pi TUI component execution out of the host.
