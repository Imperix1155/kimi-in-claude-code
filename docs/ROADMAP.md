# Kimi Companion Plugin — Roadmap / Work Tracker

**This file IS the issue tracker** (decision 2026-07-16: no Linear board — overkill for a 19-item, single-contributor project). Check items off as they land; add newly discovered work as new KMP items under the right epic. Detail lives in [PLAN.md](./PLAN.md) — each item cites the PLAN section that defines it. Milestone gates (PLAN §5) are strict: no epic starts until the prior epic's gate prints green.

---

## Epic 0 — Project setup (small)

- [x] **KMP-1** ~~Init git repo~~ ✅ 2026-07-16 (public: github.com/Imperix1155/kimi-in-claude-code, Apache-2.0 + NOTICE, docs + spike committed). ~~Fork/copy codex plugin skeleton~~ ✅ 2026-07-16 (34 files from codex-plugin-cc 1.0.4, byte-identical, verified by count + `diff -r`; excluded per PLAN §3/§6: `.in_use/`, CHANGELOG, duplicate LICENSE/NOTICE, `gpt-5-4-prompting` skill). _(PLAN §3, §6)_
- [x] **KMP-2** Rename pass ✅ 2026-07-16: plugin.json manifest → kimi 0.1.0; `CODEX_COMPANION_*` → `KIMI_COMPANION_*` (5 occurrences, 4 script files; verified 0 old refs outside docs); Bucket-1 verbatim copies in place via KMP-1. Executed by Codex (delegated), verified by driver. _(PLAN §4)_

## Epic 1 — Engine core (= milestone M2, the big one)

- [x] **KMP-3** `lib/agent-profile.mjs` ✅ 2026-07-16 — agent-profile abstraction; Kimi as first profile (spawn, init caps, probe + 1.48.0 version pin, auth detection, model catalog/aliases + resolveModel, fail-closed pickPermissionOption). Verified by assertion gate (31 assertions); Codex adversarial review applied: fail-open reject fallback fixed (High), model aliases + version pin added; structured-error contract pinned on KMP-4. _(PLAN §6 locked decisions)_
- [ ] **KMP-4** `lib/acp-client.mjs` — promote spike to real client: request/response correlation, notification dispatch, agent→client request handling, exit/reconnect. **Contract:** rejected requests must surface the structured JSON-RPC error object (`{ code, message }`), not a string-wrapped Error like the spike — `agent-profile.isAuthRequiredError` depends on it (Codex review finding, 2026-07-16). _(PLAN §4 bucket 3)_
- [ ] **KMP-5** `lib/kimi.mjs` — turn-capture accumulator + ACP notification mapping. _(PLAN §4 bucket 3)_
- [ ] **KMP-6** Broker: singleton `kimi acp` process shared across calls; busy signaling. _(PLAN §2, §4 bucket 2)_
- [ ] **KMP-7** Background jobs: `task` subcommand + `/status` `/result` `/cancel`; verify session-resume semantics live (fallback: stateless sessions). _(PLAN §5 M2, §7 risk 2)_
- [ ] **GATE M2**: background task survives shell death; result recoverable from fresh shell; concurrent call gets busy; resume keeps context. _(PLAN §5)_

## Epic 2 — Review (= milestone M3)

- [ ] **KMP-8** `/kimi:review` — prompt-driven review command (wait/background flow ported from codex plugin). _(PLAN §4 bucket 2)_
- [ ] **KMP-9** Permission-reject enforcement for reviews + test that ASSERTS the reject path fires. _(PLAN §5 M3, §7 risk 1)_
- [ ] **KMP-10** Review output → `review-output.schema.json` validation; optional Stop-hook review gate. _(PLAN §5 M3)_
- [ ] **GATE M3**: seeded-bug review finds the bug; write attempt rejected (assert fired); schema validates. _(PLAN §5)_

## Epic 3 — Task delegation + polish (= milestone M4)

- [ ] **KMP-11** `/kimi:task` write-enabled delegation (auto-approve permission policy). _(PLAN §6)_
- [ ] **KMP-12** `/kimi:setup` — probes: not installed / logged out / ready. _(PLAN §5 M4)_
- [ ] **KMP-13** Rescue agent + runtime/result-handling skills. _(PLAN §3)_
- [ ] **GATE M4**: delegated task edits scratch repo + reports diff; setup reports all three states correctly. _(PLAN §5)_

## Epic 4 — Open-source release

- [ ] **KMP-14** README from PLAN §8 positioning (strengths AND honest limits). _(PLAN §8)_
- [ ] **KMP-15** Publish repo (GitHub, public); marketplace listing so it installs via Claude Code plugin marketplace.
- [ ] **KMP-16** Review pass before publish (review-loop: fallow + /code-review + Codex adversarial). _(house rule)_

## Epic 5 — Post-v1 portability (backlog, no gate)

- [ ] **KMP-17** Grok Build agent profile. _(PLAN §6, §9)_
- [ ] **KMP-18** OpenCode agent profile. _(PLAN §9)_
- [ ] **KMP-19** v2: MCP-server skin over the engine (delegation from any MCP-capable harness). _(PLAN §9)_

---

## Tracking rules

- Owner decided 2026-07-16: **no Linear board** for this project — this file is the tracker. (Context if ever revisited: workspace already at the Free plan's 2-team cap; a Project inside the idle "Imperix" team was the free fallback.)
- Per work item: check the box when its verify criterion passes, note the date. Discovered work (bugs, review findings, follow-ups) gets a new `KMP-##` line under the owning epic — never tracked only in chat.
- Epic complete = all its boxes checked AND its gate line checked with the gate's command output confirming green.
