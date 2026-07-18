// Broker tests: a real detached acp-broker.mjs process serving the scripted
// fake agent. Run: node plugin/tests/acp-broker.test.mjs  (prints ACP-BROKER-TESTS-GREEN)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AcpClient, BROKER_BUSY_RPC_CODE } from "../scripts/lib/acp-client.mjs";
import {
  ensureBrokerSession,
  loadBrokerSession,
  sendBrokerShutdown,
  waitForBrokerEndpoint
} from "../scripts/lib/broker-lifecycle.mjs";
import { newSession, runPromptTurn } from "../scripts/lib/kimi.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

// The whole suite dies loudly rather than hanging a CI-less gate.
const deadman = setTimeout(() => {
  console.error("BROKER-TESTS TIMEOUT after 60s");
  process.exit(2);
}, 60_000);
deadman.unref?.();

function agentSpawnArgs(scenario) {
  return ["--agent-spawn", JSON.stringify({ command: process.execPath, args: [FIXTURE, scenario] })];
}

// Shutdown is acked before the listener finishes closing; poll until the
// endpoint actually stops accepting connections.
async function waitForEndpointDeath(endpoint, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const alive = await waitForBrokerEndpoint(endpoint, 100);
    if (!alive) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

// Each scenario gets its own workspace dir (broker state is per-cwd) and a
// broker that is always shut down, pass or fail.
async function withBroker(scenario, fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-test-"));
  const session = await ensureBrokerSession(cwd, { extraBrokerArgs: agentSpawnArgs(scenario) });
  assert.ok(session?.endpoint, `broker failed to start for scenario ${scenario}`);
  try {
    await fn(session, cwd);
  } finally {
    await sendBrokerShutdown(session.endpoint).catch(() => {});
  }
}

// 1. Full path through the broker: handshake answered locally with the real
// agent's info, session/new + captured prompt turn, notifications relayed.
await withBroker("basic", async (session, cwd) => {
  const client = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  assert.equal(client.transport, "broker");
  assert.equal(client.agentInfo.protocolVersion, 1);
  const s = await newSession(client, cwd);
  const result = await runPromptTurn(client, { sessionId: s.sessionId, prompt: "ping" });
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.agentMessage, "pong");
  await client.close();
});

// 2. Busy signaling: while one socket's turn is in flight, another socket's
// request gets BROKER_BUSY_RPC_CODE; after the turn it succeeds.
await withBroker("slow-prompt", async (session, cwd) => {
  const clientA = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  const clientB = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  await clientA.request("session/new", { cwd, mcpServers: [] });

  const turn = clientA.request("session/prompt", { sessionId: "sess-1", prompt: [{ type: "text", text: "x" }] });
  await new Promise((resolve) => setTimeout(resolve, 100));

  let busy = null;
  try {
    await clientB.request("session/new", { cwd, mcpServers: [] });
  } catch (error) {
    busy = error;
  }
  assert.ok(busy, "expected a busy error while the turn was in flight");
  assert.equal(busy.code, BROKER_BUSY_RPC_CODE);

  const result = await turn;
  assert.equal(result.stopReason, "end_turn");

  const after = await clientB.request("session/new", { cwd, mcpServers: [] });
  assert.ok(after.sessionId);
  await clientA.close();
  await clientB.close();
});

// 3. One shared agent process across separate client connections: the
// counter (and pid) persist after the first client disconnects.
await withBroker("counter", async (session, cwd) => {
  const clientA = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  await clientA.request("session/new", { cwd, mcpServers: [] });
  const first = await clientA.request("session/prompt", { sessionId: "sess-1", prompt: [{ type: "text", text: "x" }] });
  assert.equal(first.promptCount, 1);
  await clientA.close();

  const clientB = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  const second = await clientB.request("session/prompt", { sessionId: "sess-1", prompt: [{ type: "text", text: "x" }] });
  assert.equal(second.promptCount, 2);
  assert.equal(second.agentPid, first.agentPid);
  await clientB.close();
});

// 4. Permission policy lives broker-side: allow via broker/session_policy is
// honored, the permission event is relayed to the active client, and an
// unset session falls back to fail-safe reject.
await withBroker("permission-standard", async (session, cwd) => {
  const events = [];
  const client = await AcpClient.connect(cwd, {
    brokerEndpoint: session.endpoint,
    onPermissionRequest: (event) => events.push(event)
  });
  const s = await newSession(client, cwd, { permissionDecision: "allow" });
  const result = await client.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "x" }] });
  assert.equal(result.observed.permissionResponse.result.outcome.optionId, "ok");
  assert.equal(events.length, 1);
  assert.equal(events[0].decision, "allow");
  await client.close();
});
await withBroker("permission-standard", async (session, cwd) => {
  const client = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  const s = await newSession(client, cwd);
  const result = await client.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "x" }] });
  assert.equal(result.observed.permissionResponse.result.outcome.optionId, "no");
  await client.close();
});

// 5. Cross-socket cancel: a second connection's session/cancel notification
// reaches the agent while the broker is busy, resolving the held turn.
await withBroker("cancellable", async (session, cwd) => {
  const clientA = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  await clientA.request("session/new", { cwd, mcpServers: [] });
  const turn = runPromptTurn(clientA, { sessionId: "sess-1", prompt: "long task" });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const clientB = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  clientB.notify("session/cancel", { sessionId: "sess-1" });

  const result = await turn;
  assert.equal(result.stopReason, "cancelled");
  assert.equal(result.status, 1);
  await clientA.close();
  await clientB.close();
});

// 6. Lifecycle: state file recorded; shutdown kills the endpoint; a second
// ensureBrokerSession then respawns a fresh broker.
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-test-"));
  const session = await ensureBrokerSession(cwd, { extraBrokerArgs: agentSpawnArgs("basic") });
  assert.ok(session?.endpoint);
  assert.equal(loadBrokerSession(cwd)?.endpoint, session.endpoint);

  await sendBrokerShutdown(session.endpoint);
  assert.equal(await waitForEndpointDeath(session.endpoint), true);

  const respawned = await ensureBrokerSession(cwd, { extraBrokerArgs: agentSpawnArgs("basic") });
  assert.ok(respawned?.endpoint);
  assert.notEqual(respawned.endpoint, session.endpoint);
  const client = await AcpClient.connect(cwd, { reuseExistingBroker: true });
  assert.equal(client.transport, "broker");
  await client.close();
  await sendBrokerShutdown(respawned.endpoint).catch(() => {});
}

// 7. Session-policy hijack refused: a second live socket cannot change a
// session it does not own, and the owner's reject stance still holds.
await withBroker("permission-standard", async (session, cwd) => {
  const clientA = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  const s = await newSession(clientA, cwd, { permissionDecision: "reject" });

  const clientB = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  let refused = null;
  try {
    await clientB.setSessionPermissionDecision(s.sessionId, "allow");
  } catch (error) {
    refused = error;
  }
  assert.ok(refused, "expected the hijack attempt to be refused");
  assert.match(refused.message, /another active client/);

  const result = await clientA.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "x" }] });
  assert.equal(result.observed.permissionResponse.result.outcome.optionId, "no");
  await clientA.close();
  await clientB.close();
});

// 8. Active socket dies mid-turn: the broker stays busy until the agent
// finishes (no ownership corruption, no leak to the next socket), then
// serves other clients normally.
await withBroker("slow-prompt", async (session, cwd) => {
  const clientA = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  await clientA.request("session/new", { cwd, mcpServers: [] });
  clientA.request("session/prompt", { sessionId: "sess-1", prompt: [{ type: "text", text: "x" }] }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 100));
  clientA.socket.destroy();

  const clientB = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  let busy = null;
  try {
    await clientB.request("session/new", { cwd, mcpServers: [] });
  } catch (error) {
    busy = error;
  }
  assert.ok(busy, "expected busy while the dead client's turn still runs");
  assert.equal(busy.code, BROKER_BUSY_RPC_CODE);

  // After the abandoned turn completes, ownership released cleanly.
  await new Promise((resolve) => setTimeout(resolve, 600));
  const after = await clientB.request("session/new", { cwd, mcpServers: [] });
  assert.ok(after.sessionId);
  await clientB.close();
});

// 9. Pipelined lines across interleaved chunks are parsed exactly once each
// (regression for the async-data-handler buffer corruption).
await withBroker("basic", async (session) => {
  const net = await import("node:net");
  const { parseBrokerEndpoint } = await import("../scripts/lib/broker-endpoint.mjs");
  const target = parseBrokerEndpoint(session.endpoint);
  const raw = net.createConnection({ path: target.path });
  raw.setEncoding("utf8");
  await new Promise((resolve, reject) => {
    raw.on("connect", resolve);
    raw.on("error", reject);
  });

  const replies = [];
  let buf = "";
  raw.on("data", (chunk) => {
    buf += chunk;
    let idx = buf.indexOf("\n");
    while (idx !== -1) {
      replies.push(JSON.parse(buf.slice(0, idx)));
      buf = buf.slice(idx + 1);
      idx = buf.indexOf("\n");
    }
  });

  // Two requests in one chunk, a third immediately after while the first is
  // still being proxied.
  raw.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/", mcpServers: [] } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/", mcpServers: [] } })}\n`);
  raw.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} })}\n`);

  const start = Date.now();
  while (replies.length < 3 && Date.now() - start < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(replies.length, 3);
  assert.deepEqual(new Set(replies.map((reply) => reply.id)), new Set([1, 2, 3]));
  assert.ok(replies.every((reply) => reply.result && !reply.error));
  raw.end();
});

// 10. Malformed request shapes get -32600 and do NOT occupy the broker.
await withBroker("basic", async (session, cwd) => {
  const net = await import("node:net");
  const { parseBrokerEndpoint } = await import("../scripts/lib/broker-endpoint.mjs");
  const target = parseBrokerEndpoint(session.endpoint);
  const raw = net.createConnection({ path: target.path });
  raw.setEncoding("utf8");
  await new Promise((resolve, reject) => {
    raw.on("connect", resolve);
    raw.on("error", reject);
  });
  const reply = await new Promise((resolve) => {
    raw.once("data", (chunk) => resolve(JSON.parse(chunk.split("\n")[0])));
    raw.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9 })}\n`);
  });
  assert.equal(reply.error.code, -32600);
  raw.end();

  const client = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  const s = await client.request("session/new", { cwd, mcpServers: [] });
  assert.ok(s.sessionId, "broker must not be stuck busy after a malformed request");
  await client.close();
});

// 11. Shutdown clears the state record, and reuseExistingBroker refuses a
// stale endpoint (falls back to a direct spawn) instead of failing.
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-test-"));
  const session = await ensureBrokerSession(cwd, { extraBrokerArgs: agentSpawnArgs("basic") });
  assert.ok(session?.endpoint);
  await sendBrokerShutdown(session.endpoint);
  assert.equal(await waitForEndpointDeath(session.endpoint), true);
  assert.equal(loadBrokerSession(cwd), null, "broker shutdown must clear its own state record");

  // Plant a stale record pointing at the dead endpoint: connect must probe,
  // refuse it, and fall back to a direct fake-agent spawn.
  const { saveBrokerSession } = await import("../scripts/lib/broker-lifecycle.mjs");
  saveBrokerSession(cwd, session);
  const { kimiProfile } = await import("../scripts/lib/agent-profile.mjs");
  const client = await AcpClient.connect(cwd, {
    reuseExistingBroker: true,
    profile: { ...kimiProfile, id: "fake", displayName: "FakeAgent", spawn: { command: process.execPath, args: [FIXTURE, "basic"] } }
  });
  assert.equal(client.transport, "direct");
  await client.close();
}

// 12. Startup-timeout teardown kills the detached broker AND its hung agent.
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-test-"));
  const session = await ensureBrokerSession(cwd, {
    extraBrokerArgs: agentSpawnArgs("hang-init"),
    timeoutMs: 700
  });
  assert.equal(session, null, "a broker whose agent hangs at initialize must not be reported ready");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const { execSync } = await import("node:child_process");
  let leftover = "";
  try {
    leftover = execSync("pgrep -f hang-init || true", { encoding: "utf8" }).trim();
  } catch {}
  assert.equal(leftover, "", `hung broker/agent processes leaked: ${leftover}`);
}

// 13. Concurrent ensureBrokerSession: exactly one broker survives in state
// and is usable; the loser is torn down.
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-test-"));
  const [a, b] = await Promise.all([
    ensureBrokerSession(cwd, { extraBrokerArgs: agentSpawnArgs("basic") }),
    ensureBrokerSession(cwd, { extraBrokerArgs: agentSpawnArgs("basic") })
  ]);
  const recorded = loadBrokerSession(cwd);
  assert.ok(recorded?.endpoint, "one broker must be recorded");
  const survivors = [a, b].filter((s) => s?.endpoint);
  assert.ok(survivors.some((s) => s.endpoint === recorded.endpoint), "a returned session must match the recorded one");
  const client = await AcpClient.connect(cwd, { brokerEndpoint: recorded.endpoint });
  const s = await client.request("session/new", { cwd, mcpServers: [] });
  assert.ok(s.sessionId);
  await client.close();
  // The non-recorded endpoint (if any distinct one was returned) must be dead.
  for (const candidate of survivors) {
    if (candidate.endpoint !== recorded.endpoint) {
      assert.equal(await waitForEndpointDeath(candidate.endpoint), true, "losing broker must be torn down");
    }
  }
  await sendBrokerShutdown(recorded.endpoint).catch(() => {});
}

console.log("ACP-BROKER-TESTS-GREEN");
process.exit(0);
