# Kimi in Claude Code

Use [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) from inside [Claude Code](https://claude.com/claude-code) — delegate code reviews and long-running tasks to Kimi (K2.x / K3) over the open [Agent Client Protocol](https://agentclientprotocol.com), the same way OpenAI's Codex plugin bridges to Codex.

> **Status: pre-release — in active development.** Nothing installable yet. The core bridge is proven ([`spike/acp-spike.mjs`](spike/acp-spike.mjs) — a live ACP handshake + prompt round-trip against `kimi acp`), and the build is tracked in [`docs/ROADMAP.md`](docs/ROADMAP.md). Watch/star if you want it when it lands.

## Why bridge Kimi into Claude Code?

Not because Kimi is a better coder than Claude — it isn't, and this README won't pretend otherwise. Because it's a **complementary engine with a different shape**:

- **Whole-repo context** — K3's 1M-token window (K2.6: 256K) enables single-pass full-codebase review; chunked reviewers miss cross-file breakage.
- **Marathon endurance** — trained for long-horizon autonomy (200–300 sequential tool calls without drifting); ideal for delegated background grind.
- **Agentic research** — best-in-class on long multi-step research benchmarks (BrowseComp); strong for research-heavy diagnosis.
- **Third-lab diversity** — in multi-engine review/verification loops, agreement across three labs is stronger evidence than two.
- **Cost tier** — Kimi coding plans start cheap; run broad first-pass reviews on Kimi, spend premium Claude/Codex quota on findings that survive.
- **Open-weight ethos** — Kimi models are open-weight (Modified MIT); this bridge is fully open source to match.

**Honest limits:** Kimi's pure coding-quality benchmarks trail the GPT-5.x/Claude frontier, and its output style is verbose. Use it for the strengths above, not as a drop-in replacement for your primary agent.

## How it works

```
Claude Code slash command (/kimi:review, /kimi:task, …)
  → companion CLI (Node)
    → broker: one long-lived `kimi acp` process shared across calls
      → JSON-RPC over stdio (Agent Client Protocol)
```

Because the engine speaks **standard ACP** — not a vendor-private dialect — the agent backend is a pluggable profile. Kimi is the first; any ACP-speaking agent (Grok Build, OpenCode, …) is a profile away. See [`docs/PLAN.md`](docs/PLAN.md) §9 for the portability roadmap, including a planned MCP-server skin so any MCP-capable harness can use the bridge.

## Project documents

- [`docs/PLAN.md`](docs/PLAN.md) — architecture, file-by-file build plan, milestone verify-gates, design decisions, risks
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — the work tracker (KMP-1…19)
- [`spike/acp-spike.mjs`](spike/acp-spike.mjs) — the feasibility proof; also a 30-second regression check after any `kimi` CLI upgrade (`node spike/acp-spike.mjs` → `SPIKE-GREEN`; requires `kimi login` first)

## License

[Apache-2.0](LICENSE). Portions will be derived from OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0) — see [NOTICE](NOTICE).

## Acknowledgments

- OpenAI's Codex plugin for Claude Code — the architectural template
- Moonshot AI's Kimi Code CLI — the engine on the other side of the bridge
- The Agent Client Protocol (Zed & contributors) — the open standard that makes the bridge generic
