// Scripted stand-in for a real ACP agent process, driven by a scenario name
// in argv[2]. Speaks just enough JSONL ACP for tests/acp-client.test.mjs;
// echoes what it observed back inside the session/prompt result so tests can
// assert on the client's answers.
import process from "node:process";
import readline from "node:readline";

const scenario = process.argv[2] ?? "basic";
const rl = readline.createInterface({ input: process.stdin });
let nextAgentRequestId = 1000;
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

  if (message.method === "initialize") {
    if (scenario === "init-error") {
      send({ id: message.id, error: { code: -32602, message: "unsupported protocol version" } });
      return;
    }
    send({ id: message.id, result: { protocolVersion: 1 } });
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
    send({ id: message.id, result: { sessionId: "sess-1" } });
    return;
  }

  if (message.method === "session/prompt") {
    if (scenario === "permission-standard" || scenario === "permission-no-reject-kind") {
      const options = scenario === "permission-standard"
        ? [{ optionId: "ok", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }]
        : [{ optionId: "ok", kind: "allow_once" }];
      agentRequest("session/request_permission", { sessionId: "sess-1", options }, (response) => {
        observed.permissionResponse = response;
        send({ method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
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

    send({ method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } } } });
    send({ id: message.id, result: { stopReason: "end_turn" } });
    return;
  }

  send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
});
