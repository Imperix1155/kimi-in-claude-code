# AGENTS.md — Kimi in Claude Code

## Purpose

A Claude Code plugin that delegates code reviews and tasks to the Kimi Code CLI via its ACP server (`kimi acp`), modeled on OpenAI's `codex-plugin-cc`. Public repo: github.com/Imperix1155/kimi-in-claude-code (Apache-2.0).

**Repo layout (as of KMP-15):** this repo is its own plugin marketplace. `.claude-plugin/marketplace.json` (root) is the catalog `imperix`; the plugin itself lives under [`plugin/`](./plugin) (`source: "./plugin"`), with its manifest at `plugin/.claude-plugin/plugin.json`. Everything the plugin ships — `commands/`, `agents/`, `skills/`, `hooks/`, `prompts/`, `schemas/`, `scripts/`, `tests/` — is under `plugin/`. `spike/`, `docs/`, and the public-facing root files stay at the repo root.

## Local Contracts

- [`docs/PLAN.md`](./docs/PLAN.md) is the authoritative build plan — architecture, file-by-file buckets, milestone verify gates, locked design decisions, risks, positioning, portability roadmap. Re-read before any build work; update when a milestone lands or a decision flips.
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) is the work tracker (KMP-1…21 as checkboxes; the owner decided against a Linear board). Check items off when their verify criterion passes; discovered work gets a new `KMP-##` line under the owning epic — never tracked only in chat.
- Milestone order is strict: a milestone's verify gate must print green before the next starts (gates in PLAN §5).
- The reference implementation is the locally installed codex plugin at `~/.claude/plugins/cache/openai-codex-plugin-cc/codex/1.0.4` (Apache-2.0) — copy freely; its attribution is preserved in [`NOTICE`](./NOTICE).
- Keep [`README.md`](./README.md) status honest: it says pre-release until v1 actually ships.

## Work Guidance

- The read-only guarantee for reviews is enforced by OUR permission handler (auto-reject `session/request_permission`), not by Kimi — never assume a Kimi-side sandbox exists.
- ACP is bidirectional: every agent→client request must be answered or the turn hangs. Unknown requests get JSON-RPC `-32601`.

## Verification

- `node spike/acp-spike.mjs` must print `SPIKE-GREEN` — proves the live ACP loop (requires `kimi login`; logged-out state fails at `session/new` with `-32000`). Also the regression check after any `kimi` CLI upgrade. (Spike stays at the repo root.)
- Deterministic suites under `plugin/tests/`, against the scripted fake agent (no login needed), each printing its `*-GREEN` sentinel: `node plugin/tests/acp-client.test.mjs`, `node plugin/tests/kimi.test.mjs`, `node plugin/tests/acp-broker.test.mjs`, `node plugin/tests/kimi-companion.test.mjs`, `node plugin/tests/hooks.test.mjs`, `node plugin/tests/render.test.mjs`, `node plugin/tests/plugin-surface.test.mjs`. The companion/hooks suites drive real CLI/hook child processes and end with their own leak sweeps. Run all seven after any change under `plugin/scripts/` or the hook scripts. After them, the suites' own leak sweeps count only TEST processes (fake agents, and brokers with a test-workspace cwd or the `--agent-spawn` flag) — real installed-plugin brokers on the machine are ignored.
- Test seam: `KIMI_COMPANION_AGENT_SPAWN` (JSON `{command, args}`) swaps the spawned agent for the scripted fake in every profile resolution; `CLAUDE_PLUGIN_DATA` isolates job/broker state per test workspace.

## Child DOX Index

- `.claude-plugin/marketplace.json` (root) — the `imperix` marketplace catalog; lists the `kimi` plugin at `source: "./plugin"` (KMP-15). Held off `main` until KMP-16's review clears.
- `docs/PLAN.md`, `docs/ROADMAP.md` — see Local Contracts.
- `spike/acp-spike.mjs` — M1 feasibility spike, verified 2026-07-15 (kimi v1.48.0). Repo root.
- `README.md`, `LICENSE`, `NOTICE` — public-facing, repo root.
- `plugin/` — the installable plugin. `plugin/.claude-plugin/plugin.json` manifest; `commands/`, `agents/`, `skills/`, `prompts/`, `hooks/`, `schemas/`, `scripts/` are the shipped surface; `scripts/lib/*.mjs` is the engine (agent-profile, acp-client, kimi, broker, job control). All Kimi-native as of Epic 2/3 — no codex-named files remain.
- `plugin/tests/` — plain-node assertion suites + `fixtures/fake-acp-agent.mjs` (scenario-driven scripted ACP agent). No test framework by design; each suite prints a `*-GREEN` sentinel. Ships inside the plugin (inert; not referenced by any manifest).
