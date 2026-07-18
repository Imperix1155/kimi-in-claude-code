# Kimi in Claude Code

Use [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) from inside [Claude Code](https://claude.com/claude-code) — delegate code reviews and long-running tasks to Kimi (K2.x / K3) over the open [Agent Client Protocol](https://agentclientprotocol.com), the same way OpenAI's Codex plugin bridges to Codex.

> **Status: v0.1.0 — feature-complete, pre-1.0.** All commands work end-to-end against a live `kimi acp` and are covered by an automated test suite. Installable from this repo as its own plugin marketplace (see [Install](#install)). Pre-1.0 while the surface settles; expect updates via `/plugin marketplace update`.

## Why bridge Kimi into Claude Code?

Not because Kimi is a better coder than Claude — it isn't, and this README won't pretend otherwise. Because it's a **complementary engine with a different shape**:

- **Whole-repo context** — K3's 1M-token window (K2.6: 256K) enables single-pass full-codebase review; chunked reviewers miss cross-file breakage. Reach for it with `--model k3`.
- **Marathon endurance** — trained for long-horizon autonomy (200–300 sequential tool calls without drifting); ideal for delegated background grind — "investigate X across the whole codebase and don't stop until it's done."
- **Agentic research** — best-in-class on long multi-step research benchmarks (BrowseComp); strong for research-heavy diagnosis.
- **Third-lab diversity** — in multi-engine review/verification loops, agreement across three labs is stronger evidence than two; disagreement is more informative.
- **Cost tier** — Kimi coding plans start cheap; run broad first-pass reviews on Kimi, spend premium Claude/Codex quota on findings that survive.
- **Open-weight ethos** — Kimi models are open-weight (Modified MIT); this bridge is fully open source to match.

**Honest limits:** Kimi's pure coding-quality benchmarks trail the GPT-5.x/Claude frontier (SWE-bench ~71 vs ~75), and its output style is verbose. Use it for the strengths above, not as a drop-in replacement for your primary agent.

## Requirements

- **[Claude Code](https://claude.com/claude-code)** — the host.
- **[Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)** on your `PATH`, logged in (`kimi login`). The bridge talks to its `kimi acp` server.
- **Node.js** (18+) — the companion runtime.

Run `/kimi:setup` any time to check all three; it reports one of `ready`, `logged-out`, or `not-installed` and tells you the next step.

## Commands

| Command | What it does |
|---|---|
| `/kimi:setup` | Check that Kimi is installed, logged in, and ACP-ready. `--enable-review-gate` / `--disable-review-gate` toggles the optional stop-time review. |
| `/kimi:review` | Adversarial review of your working tree or branch diff. **Read-only** — enforced by the plugin, not trusted to Kimi. `[--wait\|--background] [--base <ref>] [--scope auto\|working-tree\|branch] [--model <id\|highspeed\|k3>] [focus…]` |
| `/kimi:task` | Delegate a coding or research task. **Write-enabled by default** (auto-approves Kimi's edits within your repo); `--read-only` for investigation-only. `[--background] [--read-only] [--resume\|--fresh] [--model …] [prompt…]` |
| `/kimi:rescue` | Proactively hand a substantial debugging or implementation task to Kimi via a forwarding subagent. Same task engine, agent-driven. |
| `/kimi:status` | Active and recent Kimi jobs for this repo. `[job-id] [--wait] [--all]` |
| `/kimi:result` | The stored final output of a finished job. `[job-id]` |
| `/kimi:cancel` | Cancel an active background job. `[job-id]` |

**Models:** default is Kimi's thinking model (quality tier); `--model highspeed` is the fast/cheap tier; `--model k3` is the 1M-context tier for whole-repo work.

**Background jobs survive.** A `--background` task keeps running if the shell that launched it dies; recover the result from a fresh session with `/kimi:result`. `/kimi:status` shows progress; `/kimi:cancel` stops it.

## Example

```
/kimi:setup                                  # → ready
/kimi:review --wait                          # adversarial review of your uncommitted changes
/kimi:task --background investigate the flaky auth test and fix it
/kimi:status                                 # watch it run
/kimi:result                                 # read the outcome once it finishes
```

## How it works

```
Claude Code slash command (/kimi:review, /kimi:task, …)
  → companion CLI (Node)
    → broker: one long-lived `kimi acp` process shared across calls
      → JSON-RPC over stdio (Agent Client Protocol)
```

The read-only guarantee for reviews is enforced **client-side** by the plugin's permission handler (it rejects every write Kimi requests during a review), because Kimi has no native read-only sandbox. Task mode auto-approves instead — and Claude Code's own permission layer still gates the outer session either way.

Because the engine speaks **standard ACP** — not a vendor-private dialect — the agent backend is a pluggable profile. Kimi is the first; any ACP-speaking agent (Grok Build, OpenCode, …) is a profile away. See [`docs/PLAN.md`](docs/PLAN.md) §9 for the portability roadmap, including a planned MCP-server skin so any MCP-capable harness can use the bridge.

## Install

This repository is its own Claude Code plugin marketplace (`imperix`). From inside Claude Code:

```
/plugin marketplace add Imperix1155/kimi-in-claude-code
/plugin install kimi@imperix
/kimi:setup
```

`/kimi:setup` confirms Kimi is installed, logged in, and ACP-ready. Update later with `/plugin marketplace update`.

Prefer to verify the bridge before installing? `node spike/acp-spike.mjs` prints `SPIKE-GREEN` against your live `kimi acp` (requires `kimi login`) — also the 30-second regression check after any `kimi` CLI upgrade.

## Project documents

- [`docs/PLAN.md`](docs/PLAN.md) — architecture, file-by-file build plan, milestone verify-gates, design decisions, risks
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — the work tracker (KMP-1…21)
- [`spike/acp-spike.mjs`](spike/acp-spike.mjs) — the feasibility proof and post-upgrade regression check
- `plugin/` — the installable plugin (manifest, commands, agents, skills, scripts); `plugin/tests/` holds the plain-Node suites (`node plugin/tests/<name>.test.mjs`, each prints a `*-GREEN` sentinel)

## License

[Apache-2.0](LICENSE). Portions are derived from OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0) — see [NOTICE](NOTICE).

## Acknowledgments

- OpenAI's Codex plugin for Claude Code — the architectural template
- Moonshot AI's Kimi Code CLI — the engine on the other side of the bridge
- The Agent Client Protocol (Zed & contributors) — the open standard that makes the bridge generic
