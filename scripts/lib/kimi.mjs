// Turn-capture accumulator: maps ACP session/update notifications into
// progress reporting and final result assembly. Ported from the codex
// plugin's TurnCaptureState pattern (lib/codex.mjs), much reduced: ACP has
// no subagent threads and turn completion is the session/prompt RESPONSE,
// not a notification, so no inferred-completion machinery is needed.
// Agent-specific values stay in agent-profile.mjs; this file owns only the
// ACP notification vocabulary.

const EDITING_TOOL_KINDS = new Set(["edit", "delete", "move"]);

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

// Same reporter contract as the codex plugin: a string for plain updates or
// { message, phase } when a phase applies.
function emitProgress(onProgress, message, phase = null) {
  if (!onProgress || !message) {
    return;
  }
  try {
    if (phase) {
      onProgress({ message, phase });
    } else {
      onProgress(message);
    }
  } catch {}
}

function phaseForToolKind(kind) {
  if (EDITING_TOOL_KINDS.has(kind)) {
    return "editing";
  }
  if (kind === "execute") {
    return "running";
  }
  return "investigating";
}

// Content arrives as an ACP ContentBlock ({ type: "text", text }) or an
// array of them; non-text blocks are ignored for text assembly.
function extractTextContent(content) {
  if (content == null) {
    return "";
  }
  if (Array.isArray(content)) {
    return content.map((block) => extractTextContent(block)).join("");
  }
  if (typeof content === "object" && content.type === "text" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

export function createTurnCapture(sessionId, options = {}) {
  return {
    sessionId,
    // Chunks group into segments by ACP messageId (chunks without one
    // continue the current segment) so distinct messages in a turn are not
    // mashed into a single string.
    messageSegments: [],
    thoughtParts: [],
    toolCalls: new Map(),
    planEntries: [],
    unknownUpdateKinds: new Set(),
    onProgress: options.onProgress ?? null
  };
}

function appendMessageChunk(state, update) {
  const text = extractTextContent(update.content);
  if (!text) {
    return;
  }
  const messageId = update.messageId ?? null;
  let segment = state.messageSegments.at(-1);
  if (!segment || (messageId !== null && segment.messageId !== null && segment.messageId !== messageId)) {
    segment = { messageId, parts: [] };
    state.messageSegments.push(segment);
  }
  if (segment.messageId === null && messageId !== null) {
    segment.messageId = messageId;
  }
  segment.parts.push(text);
}

// Applies one notification to the capture state. Returns true when the
// notification belonged to this capture's session (even if the update kind
// is unmapped); false means "not ours" so callers can route it elsewhere.
export function applySessionUpdate(state, notification) {
  if (notification?.method !== "session/update") {
    return false;
  }
  const params = notification.params ?? {};
  if (params.sessionId !== state.sessionId) {
    return false;
  }
  const update = params.update;
  if (!update || typeof update !== "object") {
    return true;
  }

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      appendMessageChunk(state, update);
      return true;
    }
    case "agent_thought_chunk": {
      const text = extractTextContent(update.content);
      if (text) {
        state.thoughtParts.push(text);
      }
      return true;
    }
    case "tool_call": {
      const toolCallId = update.toolCallId ?? `tool-${state.toolCalls.size}`;
      const entry = {
        toolCallId,
        title: update.title ?? "",
        kind: update.kind ?? "other",
        status: update.status ?? "pending",
        locations: update.locations ?? [],
        content: update.content ?? []
      };
      state.toolCalls.set(toolCallId, entry);
      emitProgress(
        state.onProgress,
        `Tool started: ${shorten(entry.title) || entry.kind}`,
        phaseForToolKind(entry.kind)
      );
      return true;
    }
    case "tool_call_update": {
      const toolCallId = update.toolCallId;
      if (toolCallId == null) {
        return true;
      }
      let entry = state.toolCalls.get(toolCallId);
      if (!entry) {
        // Update for a call whose start we never saw — record a skeleton so
        // its outcome still shows up in the result.
        entry = { toolCallId, title: "", kind: "other", status: "pending", locations: [], content: [] };
        state.toolCalls.set(toolCallId, entry);
      }
      for (const key of ["status", "title", "kind", "locations", "content", "rawInput", "rawOutput"]) {
        if (update[key] !== undefined && update[key] !== null) {
          entry[key] = update[key];
        }
      }
      if (update.status === "completed" || update.status === "failed") {
        emitProgress(
          state.onProgress,
          `Tool ${shorten(entry.title) || entry.kind} ${update.status}.`,
          update.status === "failed" ? "failed" : phaseForToolKind(entry.kind)
        );
      }
      return true;
    }
    case "plan": {
      state.planEntries = Array.isArray(update.entries) ? update.entries : [];
      const total = state.planEntries.length;
      const completed = state.planEntries.filter((entry) => entry?.status === "completed").length;
      emitProgress(state.onProgress, `Plan: ${completed}/${total} steps completed.`, "planning");
      return true;
    }
    // Known kinds we deliberately ignore (PLAN §1).
    case "available_commands_update":
    case "current_mode_update":
      return true;
    default:
      if (typeof update.sessionUpdate === "string") {
        state.unknownUpdateKinds.add(update.sessionUpdate);
      }
      return true;
  }
}

// Best-effort: only COMPLETED edit-kind calls count (a rejected edit touched
// nothing), with diff-content blocks as the path source when locations are
// absent. Consumers wanting ground truth should diff the worktree.
function collectTouchedFiles(state) {
  const paths = new Set();
  for (const call of state.toolCalls.values()) {
    if (!EDITING_TOOL_KINDS.has(call.kind) || call.status !== "completed") {
      continue;
    }
    for (const location of call.locations ?? []) {
      if (location?.path) {
        paths.add(location.path);
      }
    }
    for (const block of Array.isArray(call.content) ? call.content : []) {
      if (block?.type === "diff" && block.path) {
        paths.add(block.path);
      }
    }
  }
  return [...paths];
}

export function buildTurnResult(state, promptResponse) {
  const stopReason = promptResponse?.stopReason ?? null;
  const messages = state.messageSegments.map((segment) => segment.parts.join(""));
  return {
    status: stopReason === "end_turn" ? 0 : 1,
    stopReason,
    agentMessage: messages.join("\n\n"),
    lastAgentMessage: messages.at(-1) ?? "",
    reasoning: state.thoughtParts.join(""),
    toolCalls: [...state.toolCalls.values()],
    touchedFiles: collectTouchedFiles(state),
    plan: state.planEntries,
    unknownUpdateKinds: [...state.unknownUpdateKinds]
  };
}

// Creates a session and binds its permission policy in one step so no turn
// can run on it before the policy is set.
export async function newSession(client, cwd, options = {}) {
  const session = await client.request("session/new", {
    cwd,
    mcpServers: options.mcpServers ?? []
  });
  if (options.permissionDecision) {
    client.setSessionPermissionDecision(session.sessionId, options.permissionDecision);
  }
  return session;
}

// Per-client capture registry. A single dispatcher handler routes each
// notification to the active capture for its sessionId (base handler gets
// the rest), so overlapping turns on DIFFERENT sessions can't corrupt each
// other — a plain save-and-restore of client.notificationHandler only
// survives strict LIFO nesting. Two concurrent captures on the SAME session
// are refused loudly (ACP serializes turns within a session anyway).
const clientCaptures = new WeakMap();

function installCapture(client, state) {
  let entry = clientCaptures.get(client);
  if (!entry) {
    entry = { base: client.notificationHandler ?? null, captures: new Map() };
    clientCaptures.set(client, entry);
    client.setNotificationHandler((message) => {
      const capture = entry.captures.get(message?.params?.sessionId);
      if (capture && applySessionUpdate(capture, message)) {
        return;
      }
      if (entry.base) {
        entry.base(message);
      }
    });
  }
  if (entry.captures.has(state.sessionId)) {
    throw new Error(`A turn capture is already active for session ${state.sessionId}.`);
  }
  entry.captures.set(state.sessionId, state);
}

function removeCapture(client, state) {
  const entry = clientCaptures.get(client);
  if (!entry) {
    return;
  }
  if (entry.captures.get(state.sessionId) === state) {
    entry.captures.delete(state.sessionId);
  }
  if (entry.captures.size === 0) {
    clientCaptures.delete(client);
    client.setNotificationHandler(entry.base ?? null);
  }
}

// Runs one prompt turn with capture. Notifications for sessions without an
// active capture go to the handler that was installed before the first
// capture; the base handler is restored once the last capture ends. Callers
// must not call setNotificationHandler while any capture is active.
export async function runPromptTurn(client, options = {}) {
  const { sessionId, prompt, onProgress } = options;
  if (!sessionId) {
    throw new Error("runPromptTurn requires a sessionId.");
  }
  const promptBlocks = typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt;
  if (!Array.isArray(promptBlocks) || promptBlocks.length === 0) {
    throw new Error("runPromptTurn requires a non-empty prompt.");
  }

  const state = createTurnCapture(sessionId, { onProgress });
  installCapture(client, state);

  try {
    emitProgress(onProgress, `Turn started (session ${sessionId}).`, "starting");
    const response = await client.request("session/prompt", { sessionId, prompt: promptBlocks });
    emitProgress(
      onProgress,
      response.stopReason === "end_turn" ? "Turn completed." : `Turn stopped (${response.stopReason}).`,
      "finalizing"
    );
    return buildTurnResult(state, response);
  } finally {
    removeCapture(client, state);
  }
}
