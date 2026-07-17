# Kimi Companion Plugin — Build Plan

A Claude Code plugin that delegates reviews and tasks to the Kimi Code CLI, modeled on OpenAI's `codex-plugin-cc` (Apache-2.0, ~5.1k lines, installed locally at `~/.claude/plugins/cache/openai-codex-plugin-cc/codex/1.0.4`).

Status: **M1 proven live** (2026-07-15). Feasibility is closed; what remains is ordinary build work.

---

## 1. Evidence base (verified 2026-07-15, this machine)

- `kimi` v1.48.0 installed at `~/.local/bin/kimi`; `kimi acp` runs a standard **Agent Client Protocol v1** server (JSON-RPC 2.0, newline-delimited, over stdio).
- Full loop proven by `spike/acp-spike.mjs`: `initialize` → `session/new` → `session/prompt` → streamed response → `stopReason: end_turn` → **SPIKE-GREEN**.
- Auth: `session/new` returns error `-32000 Authentication required` when logged out; fixed by user running `kimi login` in a terminal.
- Session capabilities advertised: `loadSession: true`, `sessionCapabilities: { list, resume }` — the persistent-thread/resume model the broker architecture needs exists. Exact resume semantics unverified (M2 item).
- Models are selectable per session: `kimi-for-coding` and `kimi-for-coding-highspeed`, each with a `,thinking` variant. Default: `kimi-for-coding,thinking`.
- Streaming separates reasoning from answer: `agent_thought_chunk` vs `agent_message_chunk` — maps directly to the codex plugin's `reasoningSummary` / `lastAgentMessage` capture.
- Only one session mode (`default`) exists — **no native read-only sandbox** (unlike Codex's `sandbox: "read-only"`). Enforcement lives client-side: our handler answers `session/request_permission` (reject for reviews, allow for tasks).
- No native review RPC (Codex has one). `/kimi:review` is prompt-driven review.
- Sessions emit an `available_commands_update` notification up front — ignore in mapping.

## 2. Architecture

Same shape as the codex plugin — a thin Claude Code scaffold over a protocol-adapter engine:

```
Claude Code slash command
  → node scripts/kimi-companion.mjs <subcommand>
    → broker (singleton, keeps one `kimi acp` process alive across calls)
      → acp-client.mjs (JSON-RPC over stdio)
        → kimi acp
```

Key difference from codex: ACP is **bidirectional**. The agent sends `session/request_permission` (and `fs/*` if we advertise the capability — we don't) that the client MUST answer or the turn hangs.

## 3. Repo layout

```
kimi-plugin/                       (new git repo; fork lineage: codex-plugin-cc, keep NOTICE)
├── .claude-plugin/plugin.json
├── hooks/hooks.json
├── schemas/review-output.schema.json
├── commands/    review.md  task.md  status.md  result.md  cancel.md  setup.md  rescue.md
├── agents/      kimi-rescue.md
├── skills/      kimi-cli-runtime/  kimi-result-handling/   (k2-prompting deferred, see §6)
├── prompts/     review.md  stop-review-gate.md
└── scripts/
    ├── kimi-companion.mjs         (CLI entry: setup/review/task/status/result/cancel)
    ├── acp-broker.mjs             (singleton broker process)
    └── lib/
        ├── acp-client.mjs         ← REWRITE (seeded from spike/acp-spike.mjs)
        ├── kimi.mjs               ← REWRITE (notification mapping + turn capture)
        ├── broker-lifecycle.mjs, render.mjs, process.mjs          ← ADAPT
        ├── fs.mjs, args.mjs, workspace.mjs, prompts.mjs,
        │   state.mjs, git.mjs, job-control.mjs, tracked-jobs.mjs,
        │   broker-endpoint.mjs                                    ← COPY
        └── acp-protocol.d.ts      (types, from published ACP spec)
```

## 4. File-by-file

### Bucket 1 — copy verbatim (~1,400 ln)

| Source file | Role |
|---|---|
| `lib/fs.mjs`, `lib/args.mjs`, `lib/workspace.mjs`, `lib/prompts.mjs` | generic utilities |
| `lib/state.mjs`, `lib/tracked-jobs.mjs`, `lib/job-control.mjs` | on-disk job/state bookkeeping, protocol-agnostic |
| `lib/git.mjs` | diff scoping, base-ref detection |
| `lib/broker-endpoint.mjs`, `hooks/hooks.json`, `schemas/review-output.schema.json` | rename env vars `CODEX_COMPANION_*` → `KIMI_COMPANION_*` |

### Bucket 2 — adapt (~1,600 ln)

| Source file | Change |
|---|---|
| `commands/*.md` (7) | keep orchestration logic (wait/background flow, AskUserQuestion pattern, size estimation); swap names + companion invocations; drop the native/adversarial review distinction (both are prompt-driven for Kimi) |
| `agents/codex-rescue.md` | retarget → `kimi-rescue.md` |
| `lib/render.mjs` | reusable structure; event labels come from ACP update kinds |
| `lib/broker-lifecycle.mjs`, `app-server-broker.mjs` | same singleton pattern; spawn target `kimi acp` |
| `codex-companion.mjs` | subcommand skeleton survives; calls rewritten client layer; add `--model` flag (`highspeed` / `thinking` variants) |
| `lib/process.mjs` | probe `kimi --version` + `kimi acp --help` |

### Bucket 3 — rewrite (~1,450 ln, expected to shrink)

| File | Work |
|---|---|
| `acp-client.mjs` | seed from the proven spike; add request/response correlation (spike has it), notification dispatch, **agent→client request handling** (`session/request_permission` answered per policy passed by caller), reconnect/exit handling modeled on `app-server.mjs` |
| `kimi.mjs` | turn-capture accumulator (port `TurnCaptureState` pattern); map `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `plan` → progress reporting + final result assembly |

## 5. Milestones — each with a verify gate

| # | Deliverable | Verify gate |
|---|---|---|
| **M1** | ACP handshake + prompt round-trip | ✅ DONE — `node spike/acp-spike.mjs` prints `SPIKE-GREEN` |
| **M2** | Broker + job control: background `task` subcommand, `/status`, `/result`, `/cancel`; verify session **resume** semantics against the live binary | start a background task, kill the calling shell, `status` then `result` from a fresh shell returns the answer; second concurrent call gets busy signal (`BROKER_BUSY` equivalent); resume continues a thread with context intact |
| **M3** | `/kimi:review` prompt-driven review + permission-reject policy; optional Stop-hook review gate | review of a seeded buggy diff finds the planted bug; during review, an attempted write by Kimi is rejected by our permission handler (assert the reject path fired, not just absence of writes); output validates against `review-output.schema.json` |
| **M4** | `/kimi:task` write-enabled delegation, rescue agent, skills, polish | delegated task edits a scratch repo file and reports the diff; `/kimi:setup` correctly reports each of: not installed / installed-but-logged-out / ready |

Build order is strict: each milestone's gate must print green before the next starts.

## 6. Design decisions

**Locked:**
- Fork the codex plugin rather than starting clean (~60% line survival, battle-tested job control; Apache-2.0 with NOTICE preserved).
- **Agent-profile abstraction from M2 onward** (added 2026-07-16): everything agent-specific — spawn command/args, auth probe + login instructions, model IDs, permission-option quirks — lives in one config object (`lib/agent-profile.mjs`), never inline in the engine. Kimi is the first profile and the branded release, but this makes the core a general ACP companion: retargeting to any native-ACP agent (Grok Build and OpenCode both ship ACP servers, verified 2026-07-16) is a new profile + testing, not a fork. Costs nothing now; buys the whole portability story.
- Do not advertise `fs` client capabilities — Kimi uses its own local tools; keeps our client surface minimal.
- Review mode = auto-reject all permission requests. Task mode = auto-approve (equivalent to Kimi's YOLO; acceptable because Claude Code's own permission layer still gates the outer session).
- `k2-prompting` skill deferred past M4 — the codex `gpt-5-4-prompting` skill is model-specific and doesn't port; ship v1 without it.

**Open (decide during build):**
- Whether `/kimi:review` defaults to `highspeed` model (cheap/fast) with `thinking` for an adversarial variant.
- Resume vs `session/load` for thread continuation — pick whichever the live binary honors (M2).

## 7. Risks

| Risk | Standing |
|---|---|
| Read-only guarantee is ours, not Kimi's | Mitigated by permission-reject policy; M3 gate asserts the reject path actually fires |
| Resume semantics unverified | M2 gate item; fallback is stateless one-shot sessions (loses `/result` continuity, plugin still works) |
| Kimi CLI is young (v1.x) — ACP surface may shift | Pin known-good version in `/kimi:setup` probe; spike script doubles as a 30-second regression check after any `kimi` upgrade |
| Turn-hang if an unhandled agent→client request arrives | acp-client answers unknown requests with JSON-RPC `-32601` (spike already does) and logs them |

## 8. Positioning — README material for the open-source release

The plugin is fully open source. These are the honest "why use this" points for the eventual README, grounded in community sentiment and benchmarks (researched 2026-07-16). Kimi is NOT pitched as a better reviewer than Claude/Codex — it's a **complementary third engine with a different shape**:

- **Whole-repo context.** K3 has a 1M-token context (K2.6: 256K); community consensus is Kimi is the model of choice for full-codebase and book-length-document work. Enables single-pass whole-repo review that chunked reviewers miss cross-file breakage on.
- **Marathon endurance.** Trained for long-horizon autonomy: 200–300 sequential tool calls without drift; Moonshot's K2.6 showcase was a 13-hour unattended run (1,000+ tool calls, 4,000+ lines modified). Ideal for delegated background grind — "investigate X across the entire codebase and don't stop until done."
- **Agentic research dominance.** BrowseComp: K2 Thinking 60.2 vs GPT-5 54.9 vs Claude 24.1; K2.6 at 83.2%. Best-in-class for research-heavy diagnosis tasks.
- **Open-weight ethos.** Kimi models are open-weight (Modified MIT) — pairs naturally with a fully open-source bridge; usable against self-hosted deployments in principle (ACP server required).
- **Cost tier.** Coding plans from $19/mo; a cheap first-pass review tier that preserves expensive Claude/Codex quota for findings that survive.
- **Third-lab diversity.** In multi-engine verification loops, agreement between models from three different labs is stronger evidence than two; disagreement is more informative.

Honest limits (state these in the README too — credibility beats hype): pure coding quality benchmarks below GPT-5.x frontier (SWE-bench 71.3 vs 74.9; K2.7-Code lost 11/12 cells to GPT-5.5); verbose output style vs Claude. Sources: aitooldiscovery.com/guides/kimi-ai-reddit, enovaigroup.com (K2 Thinking benchmarks), blog.kilo.ai (K2.6), venturebeat.com (K2 Thinking open-source leader), arxiv.org/pdf/2507.20534 (K2 technical report).

## 9. Portability roadmap (added 2026-07-16 — post-v1, not in M1–M4 scope)

Three-layer view of the codebase determines what ports where:

1. **Engine** (broker, acp-client, job control, agent profiles) — plain Node, harness-agnostic, ~80% of the code.
2. **Harness skin** — the Claude Code scaffold (commands/hooks/skills) is one skin over the engine. Other harnesses have their own skin formats: Codex plugins (marketplace, hooks, skills, external-agent configs — OpenAI's April-2026 plugin system), OpenCode plugins.
3. **The universal skin: an MCP server wrapper.** Every major harness speaks MCP (Claude Code, ChatGPT/Codex, OpenCode, Grok Build). Wrapping the engine's subcommands (`task`/`review`/`status`/`result`/`cancel`) as MCP tools makes delegation-to-any-ACP-agent available in every MCP-capable harness with zero per-harness scaffold work. Trade-off: loses harness-native niceties (slash commands, stop-review-gate hook, AskUserQuestion flows) — core delegation only.

Sequence: v1 = Claude Code plugin, Kimi profile (M1–M4). v1.x = additional agent profiles (Grok Build, OpenCode — both ship native ACP servers). v2 = MCP server skin (~1–2 days; subcommands map ≈1:1 to tools). Native skins for other harnesses only on demand.

Out of scope permanently: model-routing harnesses like Hermes Agent solve multi-LLM at a different layer (routing raw models inside one agent) and don't need this bridge; our niche is agent-to-agent delegation across subscription products.

## 10. References

- Codex plugin source: `~/.claude/plugins/cache/openai-codex-plugin-cc/codex/1.0.4` (github `openai/codex-plugin-cc`, commit `807e03a`)
- ACP spec: https://agentclientprotocol.com (Zed/JetBrains-backed standard)
- Kimi Code CLI: https://github.com/MoonshotAI/kimi-code
- Live spike + transcript: `spike/acp-spike.mjs` (this repo)
