# AGENTS.md — Kimi in Claude Code

## Purpose

A Claude Code plugin that delegates code reviews and tasks to the Kimi Code CLI via its ACP server (`kimi acp`), modeled on OpenAI's `codex-plugin-cc`. Public repo: github.com/Imperix1155/kimi-in-claude-code (Apache-2.0).

## Local Contracts

- [`docs/PLAN.md`](./docs/PLAN.md) is the authoritative build plan — architecture, file-by-file buckets, milestone verify gates, locked design decisions, risks, positioning, portability roadmap. Re-read before any build work; update when a milestone lands or a decision flips.
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) is the work tracker (KMP-1…19 as checkboxes; the owner decided against a Linear board). Check items off when their verify criterion passes; discovered work gets a new `KMP-##` line under the owning epic — never tracked only in chat.
- Milestone order is strict: a milestone's verify gate must print green before the next starts (gates in PLAN §5).
- The reference implementation is the locally installed codex plugin at `~/.claude/plugins/cache/openai-codex-plugin-cc/codex/1.0.4` (Apache-2.0) — copy freely; its attribution is preserved in [`NOTICE`](./NOTICE).
- Keep [`README.md`](./README.md) status honest: it says pre-release until v1 actually ships.

## Work Guidance

- The read-only guarantee for reviews is enforced by OUR permission handler (auto-reject `session/request_permission`), not by Kimi — never assume a Kimi-side sandbox exists.
- ACP is bidirectional: every agent→client request must be answered or the turn hangs. Unknown requests get JSON-RPC `-32601`.

## Verification

- `node spike/acp-spike.mjs` must print `SPIKE-GREEN` — proves the live ACP loop (requires `kimi login`; logged-out state fails at `session/new` with `-32000`). Also the regression check after any `kimi` CLI upgrade.
- Deterministic suites against the scripted fake agent (no login needed), each printing its `*-GREEN` sentinel: `node tests/acp-client.test.mjs`, `node tests/kimi.test.mjs`, `node tests/acp-broker.test.mjs`, `node tests/kimi-companion.test.mjs` (this one drives the real CLI as child processes and ends with its own leak sweep). Run all four after any change to `scripts/lib/*.mjs`, `scripts/acp-broker.mjs`, or `scripts/kimi-companion.mjs`. The broker/companion suites spawn real detached processes — after them, `pgrep -f "fake-acp-agent|acp-broker.mjs serve"` must match nothing.
- Test seam: `KIMI_COMPANION_AGENT_SPAWN` (JSON `{command, args}`) swaps the spawned agent for the scripted fake in every profile resolution; `CLAUDE_PLUGIN_DATA` isolates job/broker state per test workspace.

## Child DOX Index

- `docs/PLAN.md`, `docs/ROADMAP.md` — see Local Contracts.
- `spike/acp-spike.mjs` — M1 feasibility spike, verified 2026-07-15 (kimi v1.48.0).
- `README.md`, `LICENSE`, `NOTICE` — public-facing.
- `.claude-plugin/`, `commands/`, `agents/`, `skills/`, `prompts/`, `hooks/`, `schemas/`, `scripts/` — plugin skeleton forked verbatim from codex-plugin-cc 1.0.4 (KMP-1, 2026-07-16). Env vars renamed KMP-2; `scripts/lib/agent-profile.mjs` (KMP-3) and `scripts/lib/acp-client.mjs` (KMP-4) are ours; remaining codex-named files pending their epic items.
- `tests/` — plain-node assertion suites + `fixtures/fake-acp-agent.mjs` (scenario-driven scripted ACP agent). No test framework by design; each suite prints a `*-GREEN` sentinel.
