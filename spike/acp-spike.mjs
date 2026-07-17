// M1 spike: raw ACP handshake with `kimi acp`
// initialize -> session/new -> session/prompt, logging everything.
import { spawn } from "node:child_process";
import readline from "node:readline";

const proc = spawn("kimi", ["acp"], { stdio: ["pipe", "pipe", "pipe"] });
proc.stdout.setEncoding("utf8");
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (d) => process.stderr.write(`[stderr] ${d}`));

const rl = readline.createInterface({ input: proc.stdout });
let nextId = 1;
const pending = new Map();

function send(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  console.log(`>>> ${JSON.stringify(msg)}`);
  proc.stdin.write(JSON.stringify(msg) + "\n");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function respond(id, result) {
  const msg = { jsonrpc: "2.0", id, result };
  console.log(`>>> (reply) ${JSON.stringify(msg)}`);
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log(`<<< (unparseable) ${line}`);
    return;
  }
  console.log(`<<< ${JSON.stringify(msg)}`);
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    }
    return;
  }
  // Agent -> client REQUEST (has id + method): must answer or the turn hangs.
  if (msg.id !== undefined && msg.method) {
    if (msg.method === "session/request_permission") {
      // read-only stance: reject anything that asks
      const opts = msg.params?.options ?? [];
      const reject = opts.find((o) => o.kind === "reject_once") ?? opts[opts.length - 1];
      respond(msg.id, { outcome: { outcome: "selected", optionId: reject?.optionId } });
    } else {
      // fs/read_text_file etc. — decline in spike
      const reply = { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported in spike" } };
      console.log(`>>> (reply) ${JSON.stringify(reply)}`);
      proc.stdin.write(JSON.stringify(reply) + "\n");
    }
  }
  // otherwise: notification (session/update) — already logged above
});

const timeout = setTimeout(() => {
  console.log("!!! TIMEOUT after 120s");
  proc.kill();
  process.exit(2);
}, 120_000);

try {
  const init = await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  console.log(`--- initialize OK: agent caps = ${JSON.stringify(init)}`);

  const session = await send("session/new", {
    cwd: process.cwd(),
    mcpServers: [],
  });
  console.log(`--- session/new OK: ${JSON.stringify(session)}`);

  const result = await send("session/prompt", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Reply with exactly the word: PONG" }],
  });
  console.log(`--- session/prompt OK: stopReason = ${JSON.stringify(result)}`);
  console.log("=== SPIKE-GREEN ===");
} catch (err) {
  console.log(`=== SPIKE-FAILED: ${err.message} ===`);
} finally {
  clearTimeout(timeout);
  proc.kill();
  process.exit(0);
}
