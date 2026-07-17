// ACP (Agent Client Protocol v1) client: JSON-RPC 2.0 over newline-delimited
// stdio. Promoted from spike/acp-spike.mjs; lifecycle modeled on the codex
// plugin's app-server.mjs. All agent-specific values come from the profile
// (agent-profile.mjs) — nothing in here may name a concrete agent.
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { getAgentProfile } from "./agent-profile.mjs";
import { terminateProcessTree } from "./process.mjs";

// Long-lived broker processes accumulate agent stderr; keep only the tail.
const STDERR_CAP = 64 * 1024;

// Rejections preserve the structured JSON-RPC error shape ({ code, message,
// data }) — agent-profile.isAuthRequiredError depends on .code surviving.
export class AcpError extends Error {
  constructor(message, { code, data, method } = {}) {
    super(message);
    this.name = "AcpError";
    if (code !== undefined) {
      this.code = code;
    }
    if (data !== undefined) {
      this.data = data;
    }
    if (method !== undefined) {
      this.method = method;
    }
  }
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

class AcpClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.profile = options.profile ?? getAgentProfile();
    // "reject" is the fail-safe default: review mode's read-only guarantee
    // is enforced by this policy. Task flows opt in to "allow" explicitly.
    // Per-session decisions (setSessionPermissionDecision) override this so
    // a shared long-lived client can host review and task sessions at once.
    this.permissionDecision = options.permissionDecision === "allow" ? "allow" : "reject";
    this.sessionPermissionDecisions = new Map();
    this.onPermissionRequest = options.onPermissionRequest ?? null;
    this.notificationHandler = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    this.exitResolved = false;
    this.agentInfo = null;
    this.transport = "unknown";

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  setPermissionDecision(decision) {
    this.permissionDecision = decision === "allow" ? "allow" : "reject";
  }

  setSessionPermissionDecision(sessionId, decision) {
    if (sessionId == null) {
      return;
    }
    this.sessionPermissionDecisions.set(sessionId, decision === "allow" ? "allow" : "reject");
  }

  request(method, params) {
    if (this.closed || this.exitResolved) {
      return Promise.reject(new AcpError(`${this.profile.displayName} ACP client is closed.`, { method }));
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.sendMessage({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(new AcpError(`Failed to parse ACP JSONL from ${this.profile.displayName}: ${error.message}`, { data: { line } }));
      return;
    }

    // Valid JSON is not necessarily a valid envelope ("null", "[]", "42"
    // all parse) — never let agent output throw in this handler.
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      this.handleExit(new AcpError(`Received non-object ACP message from ${this.profile.displayName}.`, { data: { line } }));
      return;
    }

    const hasId = message.id !== undefined;
    const isRequest = hasId && typeof message.method === "string" && message.method.length > 0;

    // Agent -> client REQUEST (id + method): must be answered or the turn
    // hangs (AGENTS.md work guidance).
    if (isRequest) {
      this.handleAgentRequest(message);
      return;
    }

    if (hasId && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (Object.hasOwn(message, "error")) {
        const error = message.error ?? {};
        pending.reject(new AcpError(error.message ?? `${pending.method} failed.`, {
          code: error.code,
          data: error.data,
          method: pending.method
        }));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (hasId) {
      return;
    }

    if (typeof message.method === "string" && this.notificationHandler) {
      // A throwing observer must not take down the transport.
      try {
        this.notificationHandler(message);
      } catch {}
    }
  }

  handleAgentRequest(message) {
    if (message.method === "session/request_permission") {
      // The decision is looked up from the request's OWN sessionId so a
      // policy change for one session can never leak into another's turn;
      // unknown sessions get the fail-safe default.
      const decision = this.sessionPermissionDecisions.get(message.params?.sessionId) ?? this.permissionDecision;
      const option = this.profile.pickPermissionOption(message.params?.options, decision);
      // No acceptable option (fail-closed reject path) -> cancel the request.
      const outcome = option
        ? { outcome: "selected", optionId: option.optionId }
        : { outcome: "cancelled" };
      this.sendMessage({ id: message.id, result: { outcome } });
      try {
        this.onPermissionRequest?.({ params: message.params, decision, outcome });
      } catch {}
      return;
    }

    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported agent request: ${message.method}`)
    });
  }

  // Responses still buffered when the process exits are dropped — their
  // pending requests are rejected here first, so nothing strands.
  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new AcpError(`${this.profile.displayName} ACP connection closed.`));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedAcpClient extends AcpClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    this.proc = spawn(this.profile.spawn.command, this.profile.spawn.args, {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_CAP);
    });

    // A late async write failure (EPIPE etc.) means the agent is gone: treat
    // it as fatal so pending requests reject instead of hanging the turn.
    this.proc.stdin.on("error", (error) => {
      this.handleExit(new AcpError(`${this.profile.displayName} agent stdin write failed: ${error.message}`, { data: { cause: error.code } }));
    });

    this.proc.on("error", (error) => {
      this.handleExit(new AcpError(`Failed to launch ${this.profile.displayName} agent: ${error.message}`, { data: { cause: error.code } }));
    });

    this.proc.on("exit", (code, signal) => {
      const detail =
        code === 0
          ? null
          : new AcpError(
            `${this.profile.displayName} agent exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).`,
            { data: { stderr: this.stderr } }
          );
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    // ACP handshake is a single request; there is no "initialized"
    // notification (verified live in the spike).
    this.agentInfo = await this.request("initialize", {
      protocolVersion: this.profile.protocolVersion,
      clientCapabilities: this.profile.clientCapabilities
    });
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      setTimeout(() => {
        if (this.proc && this.proc.exitCode === null) {
          // On Windows with shell: true the direct child is cmd.exe; kill the
          // whole tree so the agent process goes with it (taskkill /F is
          // already forceful, so no separate escalation there).
          if (process.platform === "win32") {
            try {
              terminateProcessTree(this.proc.pid);
            } catch {
              // Best-effort cleanup inside an unref'd timer.
            }
          } else {
            this.proc.kill("SIGTERM");
          }
        }
      }, 50).unref?.();
      if (process.platform !== "win32") {
        // Escalate if the agent ignores SIGTERM, so close() cannot hang a
        // broker restart forever.
        setTimeout(() => {
          if (this.proc && this.proc.exitCode === null) {
            try {
              this.proc.kill("SIGKILL");
            } catch {}
          }
        }, 2000).unref?.();
      }
    }

    await this.exitPromise;
  }

  // stdin backpressure is intentionally unhandled: outbound traffic is small
  // (prompts + permission answers), matching the codex reference client.
  sendMessage(message) {
    const stdin = this.proc?.stdin;
    if (!stdin || !stdin.writable) {
      throw new AcpError(`${this.profile.displayName} agent stdin is not available.`);
    }
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }
}

export class AcpClient {
  // Broker transport lands with KMP-6; until then connect() always spawns a
  // dedicated agent process per the profile.
  static async connect(cwd, options = {}) {
    const client = new SpawnedAcpClient(cwd, options);
    try {
      await client.initialize();
    } catch (error) {
      // A failed handshake must not orphan the spawned agent process.
      await client.close().catch(() => {});
      throw error;
    }
    return client;
  }
}
