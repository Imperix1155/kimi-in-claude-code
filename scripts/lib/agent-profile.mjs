// Agent-profile registry: everything agent-specific — spawn command/args,
// auth probe + login instructions, model IDs, permission-option quirks —
// lives here, never inline in the engine (PLAN §6 locked decision).
// Values verified live against kimi v1.48.0 on 2026-07-15 (spike/acp-spike.mjs).
import process from "node:process";

// Overrides the spawn target for every resolved profile: a custom agent
// binary path, or the scripted fake agent in tests. JSON {command, args}.
export const AGENT_SPAWN_ENV = "KIMI_COMPANION_AGENT_SPAWN";

export const kimiProfile = {
  id: "kimi",
  displayName: "Kimi",

  // How the broker launches the ACP server process.
  spawn: { command: "kimi", args: ["acp"] },

  // ACP initialize params. fs capabilities stay false by design: Kimi uses
  // its own local tools, and not advertising fs keeps our client surface
  // minimal (PLAN §6).
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },

  // Install probe, consumed via process.mjs binaryAvailable(). The setup
  // command compares against knownGoodVersion and warns on drift (PLAN §7:
  // the ACP surface of a v1.x CLI may shift).
  probe: { command: "kimi", args: ["--version"], knownGoodVersion: "1.48.0" },

  // Logged-out state surfaces as an error on session/new, not at spawn or
  // initialize. Both code and message must match before we blame auth —
  // -32000 is a generic server-error code.
  auth: {
    errorCode: -32000,
    errorPattern: /authentication required/i,
    loginInstructions: "Run `kimi login` in a terminal, then retry."
  },

  models: {
    default: "kimi-for-coding,thinking",
    catalog: [
      "kimi-for-coding",
      "kimi-for-coding,thinking",
      "kimi-for-coding-highspeed",
      "kimi-for-coding-highspeed,thinking"
    ],
    // Values the planned --model flag accepts (PLAN §4 bucket 2) resolve
    // here, so the engine never learns agent-specific model names.
    aliases: {
      highspeed: "kimi-for-coding-highspeed,thinking"
    }
  },

  // Exact catalog id or alias -> model id; null means unknown (caller
  // should error with the catalog). Empty/absent -> the default model.
  resolveModel(nameOrAlias) {
    if (nameOrAlias == null || nameOrAlias === "") {
      return this.models.default;
    }
    if (this.models.catalog.includes(nameOrAlias)) {
      return nameOrAlias;
    }
    return this.models.aliases[nameOrAlias] ?? null;
  },

  // Map an allow/reject decision onto the agent's offered permission options.
  // Reject FAILS CLOSED: if no reject-kind option exists among valid options,
  // return null and let the caller answer { outcome: "cancelled" } — never
  // satisfy a reject decision with a non-reject option, because review mode's
  // read-only guarantee is enforced entirely by this path.
  pickPermissionOption(options, decision) {
    const list = (Array.isArray(options) ? options : []).filter(
      (option) => option && typeof option === "object" && typeof option.optionId === "string"
    );
    const preferredKinds = decision === "allow"
      ? ["allow_once", "allow_always"]
      : ["reject_once", "reject_always"];
    for (const kind of preferredKinds) {
      const match = list.find((option) => option.kind === kind);
      if (match) {
        return match;
      }
    }
    return decision === "allow" ? (list[0] ?? null) : null;
  }
};

// Expects the structured JSON-RPC error object ({ code, message }) from the
// wire. The acp-client must preserve that shape on rejection — do NOT wrap
// it in an Error string the way spike/acp-spike.mjs does, or detection breaks.
export function isAuthRequiredError(profile, error) {
  if (!error) {
    return false;
  }
  const message = String(error.message ?? "");
  return error.code === profile.auth.errorCode && profile.auth.errorPattern.test(message);
}

const PROFILES = new Map([[kimiProfile.id, kimiProfile]]);

export const DEFAULT_PROFILE_ID = kimiProfile.id;

export function getAgentProfile(id = DEFAULT_PROFILE_ID) {
  const profile = PROFILES.get(id);
  if (!profile) {
    throw new Error(`Unknown agent profile "${id}". Known profiles: ${[...PROFILES.keys()].join(", ")}`);
  }
  const override = process.env[AGENT_SPAWN_ENV];
  if (override) {
    let spawn;
    try {
      spawn = JSON.parse(override);
    } catch {
      throw new Error(`Invalid ${AGENT_SPAWN_ENV}: must be JSON like {"command":"...","args":[...]}.`);
    }
    if (typeof spawn?.command !== "string" || !Array.isArray(spawn.args)) {
      throw new Error(`Invalid ${AGENT_SPAWN_ENV}: must be JSON like {"command":"...","args":[...]}.`);
    }
    return { ...profile, spawn };
  }
  return profile;
}
