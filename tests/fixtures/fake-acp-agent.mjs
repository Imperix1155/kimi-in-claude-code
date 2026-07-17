// Scripted stand-in for a real ACP agent process, driven by a scenario name
// in argv[2]. Speaks just enough JSONL ACP for tests/acp-client.test.mjs;
// echoes what it observed back inside the session/prompt result so tests can
// assert on the client's answers.
import process from "node:process";
import readline from "node:readline";

const scenario = process.argv[2] ?? "basic";
const rl = readline.createInterface({ input: process.stdin });
let nextAgentRequestId = 1000;
let sessionCount = 0;
let promptCount = 0;
let heldPromptId = null;
const waiters = new Map();
const observed = {};

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function agentRequest(method, params, onResponse) {
  const id = nextAgentRequestId;
  nextAgentRequestId += 1;
  waiters.set(id, onResponse);
  send({ id, method, params });
}

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  const message = JSON.parse(line);

  // Response to one of our agent->client requests.
  if (message.id !== undefined && message.method === undefined) {
    const waiter = waiters.get(message.id);
    if (waiter) {
      waiters.delete(message.id);
      waiter(message);
    }
    return;
  }

  // Client->agent notification: session/cancel resolves a held turn. A
  // cancel arriving BEFORE the prompt is remembered and applied to the next
  // prompt immediately (mirrors real agents: no interleaving hangs forever).
  if (message.id === undefined && message.method === "session/cancel") {
    if (scenario === "cancellable") {
      if (heldPromptId !== null) {
        const promptId = heldPromptId;
        heldPromptId = null;
        send({ id: promptId, result: { stopReason: "cancelled" } });
      } else {
        observed.pendingCancel = true;
      }
    }
    return;
  }

  if (message.method === "initialize") {
    if (scenario === "init-error") {
      send({ id: message.id, error: { code: -32602, message: "unsupported protocol version" } });
      return;
    }
    if (scenario === "hang-init") {
      // Never answer: exercises the broker-startup-timeout teardown path.
      return;
    }
    send({ id: message.id, result: { protocolVersion: 1 } });
    return;
  }

  if (message.method === "session/load") {
    observed.wasLoaded = true;
    send({ id: message.id, result: {} });
    return;
  }

  if (message.method === "session/set_model") {
    observed.modelId = message.params?.modelId ?? null;
    send({ id: message.id, result: {} });
    return;
  }

  if (message.method === "session/new") {
    if (scenario === "auth-error") {
      send({ id: message.id, error: { code: -32000, message: "Authentication required" } });
      return;
    }
    if (scenario === "null-line") {
      // Valid JSON, invalid envelope — must not crash the client host.
      process.stdout.write("null\n");
      return;
    }
    if (scenario === "two-sessions") {
      sessionCount += 1;
      send({ id: message.id, result: { sessionId: `sess-${sessionCount}` } });
      return;
    }
    send({ id: message.id, result: { sessionId: "sess-1" } });
    return;
  }

  if (message.method === "session/prompt") {
    if (scenario === "permission-standard" || scenario === "permission-no-reject-kind") {
      const options = scenario === "permission-standard"
        ? [{ optionId: "ok", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }]
        : [{ optionId: "ok", kind: "allow_once" }];
      agentRequest("session/request_permission", { sessionId: message.params.sessionId ?? "sess-1", options }, (response) => {
        observed.permissionResponse = response;
        const outcome = response.result?.outcome?.optionId ?? response.result?.outcome?.outcome ?? "unknown";
        send({ method: "session/update", params: { sessionId: message.params.sessionId ?? "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `done perm:${outcome}` } } } });
        send({ id: message.id, result: { stopReason: "end_turn", observed } });
      });
      return;
    }

    if (scenario === "unknown-request") {
      agentRequest("custom/not-a-real-method", {}, (response) => {
        observed.unknownResponse = response;
        send({ id: message.id, result: { stopReason: "end_turn", observed } });
      });
      return;
    }

    if (scenario === "crash-mid-turn") {
      process.exit(3);
    }

    if (scenario === "refusal") {
      send({ id: message.id, result: { stopReason: "refusal" } });
      return;
    }

    if (scenario === "slow-prompt" || scenario === "slow-prompt-3s") {
      const delay = scenario === "slow-prompt-3s" ? 3000 : 500;
      setTimeout(() => {
        send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "slow done" } } } });
        send({ id: message.id, result: { stopReason: "end_turn" } });
      }, delay);
      return;
    }

    if (scenario === "resume-check") {
      const text = observed.wasLoaded ? "resumed-session" : "fresh-session";
      send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (scenario === "model-check") {
      const text = `model:${observed.modelId ?? "default"}`;
      send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (scenario === "review-json") {
      const review = {
        verdict: "needs-attention",
        summary: "Ship blocker: planted divide-by-zero found.",
        findings: [{
          severity: "high",
          title: "Planted divide-by-zero",
          body: "compute() divides by a divisor that can be zero.",
          file: "src/buggy.mjs",
          line_start: 2,
          line_end: 3,
          confidence: 0.9,
          recommendation: "Guard the divisor before dividing."
        }],
        next_steps: ["Add a zero-divisor guard."]
      };
      // Fenced on purpose: exercises tolerant JSON extraction.
      const text = "Here is my review:\n```json\n" + JSON.stringify(review, null, 2) + "\n```";
      send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (scenario === "review-empty") {
      // Turn ends with NO message at all — must be a failed review, not a
      // silent success (live-caught: empty stderr laundered the parse error).
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (scenario === "review-bad-json") {
      send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I could not produce structured output, sorry." } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (scenario === "review-write-attempt") {
      // Mid-review write attempt: the client's answer decides the review's
      // reported summary, so tests can assert the reject FIRED end to end.
      const options = [{ optionId: "ok", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }];
      agentRequest(
        "session/request_permission",
        { sessionId: message.params.sessionId, toolCall: { toolCallId: "w1", title: "Write review-notes.txt", kind: "edit" }, options },
        (response) => {
          observed.permissionResponse = response;
          const outcome = response.result?.outcome?.optionId ?? response.result?.outcome?.outcome ?? "unknown";
          const review = {
            verdict: "needs-attention",
            summary: `perm-outcome:${outcome}`,
            findings: [],
            next_steps: ["Investigate the write attempt."]
          };
          send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(review) } } } });
          send({ id: message.id, result: { stopReason: "end_turn", observed } });
        }
      );
      return;
    }

    if (scenario === "review-invalid-schema") {
      // Valid JSON, invalid shape: verdict outside the schema enum.
      const bogus = { verdict: "ship-it", summary: "Looks fine to me.", findings: [], next_steps: [] };
      send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(bogus) } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (scenario === "counter") {
      promptCount += 1;
      send({ id: message.id, result: { stopReason: "end_turn", promptCount, agentPid: process.pid } });
      return;
    }

    if (scenario === "cancellable") {
      if (observed.pendingCancel) {
        observed.pendingCancel = false;
        send({ id: message.id, result: { stopReason: "cancelled" } });
        return;
      }
      heldPromptId = message.id;
      return;
    }

    if (scenario === "two-sessions") {
      // Turn A (sess-1) is held open; turn B (sess-2) arriving ends A first,
      // then keeps streaming — exercising non-LIFO capture teardown.
      const chunk = (sessionId, text) => send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      if (message.params.sessionId === "sess-1") {
        chunk("sess-1", "A1");
        heldPromptId = message.id;
        return;
      }
      chunk("sess-2", "B1");
      send({ id: heldPromptId, result: { stopReason: "end_turn" } });
      chunk("sess-2", "B2");
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (scenario === "message-ids") {
      const chunk = (messageId, text) => send({ method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } } } });
      chunk("m1", "first ");
      chunk("m1", "part");
      chunk("m2", "final answer");
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (scenario === "turn-capture") {
      const update = (u) => send({ method: "session/update", params: { sessionId: "sess-1", update: u } });
      update({ sessionUpdate: "plan", entries: [
        { content: "read the config", status: "in_progress", priority: "high" },
        { content: "edit the files", status: "pending", priority: "medium" }
      ] });
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read config", kind: "read", status: "in_progress" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
      update({ sessionUpdate: "tool_call", toolCallId: "t2", title: "Edit files", kind: "edit", status: "pending", locations: [{ path: "/tmp/x.mjs" }] });
      update({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed", locations: [{ path: "/tmp/x.mjs" }, { path: "/tmp/y.mjs" }] });
      update({ sessionUpdate: "tool_call_update", toolCallId: "ghost", status: "failed" });
      // Failed edit: its locations must NOT count as touched files.
      update({ sessionUpdate: "tool_call", toolCallId: "t3", title: "Rejected edit", kind: "edit", status: "in_progress", locations: [{ path: "/tmp/rejected.mjs" }] });
      update({ sessionUpdate: "tool_call_update", toolCallId: "t3", status: "failed" });
      // Completed edit reporting only diff content, no locations.
      update({ sessionUpdate: "tool_call", toolCallId: "t4", title: "Diff-only edit", kind: "edit", status: "in_progress" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "t4", status: "completed", content: [{ type: "diff", path: "/tmp/z.mjs", oldText: "a", newText: "b" }] });
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking hard" } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello, " } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world." } });
      update({ sessionUpdate: "plan", entries: [
        { content: "read the config", status: "completed", priority: "high" },
        { content: "edit the files", status: "completed", priority: "medium" }
      ] });
      update({ sessionUpdate: "future_unknown_kind", payload: 1 });
      update({ sessionUpdate: "available_commands_update", availableCommands: [] });
      // Different session: must be routed to the previous handler, not captured.
      send({ method: "session/update", params: { sessionId: "sess-OTHER", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "leak" } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    send({ method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } } } });
    send({ id: message.id, result: { stopReason: "end_turn" } });
    return;
  }

  send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
});
