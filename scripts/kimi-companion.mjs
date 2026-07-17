#!/usr/bin/env node

// Companion CLI: the plugin's slash commands shell out to this. Adapted from
// codex-companion.mjs; task/status/result/cancel are live (KMP-7), while
// setup (KMP-12) and review (KMP-8) land with their own work items.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import {
  cancelKimiSession,
  DEFAULT_CONTINUE_PROMPT,
  getKimiAvailability,
  isBrokerBusyError,
  runKimiTurn
} from "./lib/kimi.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { generateJobId, listJobs, upsertJob, writeJobFile } from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
// Keep this marker text identical to the one the stop-review-gate hook
// embeds in its prompt; task metadata keys off it.
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/kimi-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--prompt-file <path>] [prompt]",
      "  node scripts/kimi-companion.mjs status [job-id] [--all] [--wait] [--json]",
      "  node scripts/kimi-companion.mjs result [job-id] [--json]",
      "  node scripts/kimi-companion.mjs cancel [job-id] [--json]",
      "",
      "A single quoted prompt argument is re-tokenized (slash-command calling",
      "convention); pass exact text via --prompt-file or piped stdin.",
      "Not yet available: setup (KMP-12), review (KMP-8)."
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

function ensureKimiAvailable(cwd) {
  const availability = getKimiAvailability(cwd);
  if (!availability.available) {
    throw new Error("Kimi Code CLI is not installed or not on PATH. Install it (https://github.com/MoonshotAI/kimi-code), then rerun /kimi:setup.");
  }
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

// job.threadId stores the ACP sessionId (field name kept so the shared job
// bookkeeping and renderers work unchanged).
function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

function resolveLatestTrackedTaskSession(workspaceRoot, options = {}) {
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && isActiveJobStatus(job.status));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /kimi:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  return trackedTask ? trackedTask.threadId : null;
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureKimiAvailable(request.cwd);

  // Resolved at ENQUEUE time (handleTask) and carried in the request: a
  // delayed background worker resolving "latest" at execution time could
  // resume a session that finished after the user launched this job.
  const resumeSessionId = request.resumeSessionId ?? null;

  if (!request.prompt && !resumeSessionId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  let result;
  try {
    result = await runKimiTurn(workspaceRoot, {
      prompt: request.prompt,
      defaultPrompt: resumeSessionId ? DEFAULT_CONTINUE_PROMPT : "",
      write: request.write,
      resumeSessionId,
      onProgress: request.onProgress
    });
  } catch (error) {
    if (isBrokerBusyError(error)) {
      throw new Error("The shared Kimi runtime is busy with another turn. Check /kimi:status, wait for it to finish, or /kimi:cancel <job-id> to stop it.");
    }
    throw error;
  }

  const taskMetadata = buildTaskRunMetadata(request);
  const rawOutput = result.agentMessage ?? "";
  const failureMessage = result.stderr ?? "";
  const rendered = renderTaskResult(
    { rawOutput, failureMessage },
    { title: taskMetadata.title, jobId: request.jobId ?? null, write: Boolean(request.write) }
  );
  const payload = {
    status: result.status,
    stopReason: result.stopReason,
    sessionId: result.sessionId,
    rawOutput,
    lastAgentMessage: result.lastAgentMessage,
    touchedFiles: result.touchedFiles,
    reasoning: result.reasoning
  };

  return {
    exitStatus: result.status,
    cancelled: result.stopReason === "cancelled",
    threadId: result.sessionId,
    turnId: null,
    payload,
    rendered,
    summary: firstMeaningfulLine(result.lastAgentMessage || rawOutput, `${taskMetadata.title} finished (${result.stopReason ?? "no stop reason"}).`),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Kimi Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Kimi Resume" : "Kimi Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /kimi:status ${payload.jobId} for progress.\n`;
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createJobRecord({
    id: generateJobId("task"),
    kind: "task",
    kindLabel: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const child = spawn(process.execPath, [SCRIPT_PATH, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  // The record must exist BEFORE the worker spawns: a fast worker that
  // finds no stored job exits silently and the job stays queued forever.
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  const child = spawnDetachedTaskWorker(cwd, job.id);
  // Index-only pid patch: the worker rewrites its own job file at startup,
  // and a full-record write here could clobber that.
  upsertJob(job.workspaceRoot, { id: job.id, pid: child.pid ?? null });

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "prompt-file", "model", "effort"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  if (options.model) {
    throw new Error("--model is not wired yet; it lands with the review command work (KMP-8).");
  }
  if (options.effort) {
    throw new Error("Kimi has no reasoning-effort parameter. Thinking is part of the model variant.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast });
  const job = buildTaskJob(workspaceRoot, taskMetadata, write);

  let resumeSessionId = null;
  if (resumeLast) {
    resumeSessionId = resolveLatestTrackedTaskSession(workspaceRoot, { excludeJobId: job.id });
    if (!resumeSessionId) {
      throw new Error("No previous Kimi task session was found for this repository.");
    }
  }

  const request = { cwd, prompt, write, resumeLast, resumeSessionId, jobId: job.id };

  if (options.background) {
    ensureKimiAvailable(cwd);
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(
    job,
    (progress) => executeTaskRun({ ...request, onProgress: progress }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    { ...storedJob, workspaceRoot },
    { logFile: storedJob.logFile ?? null }
  );
  await runTrackedJob(
    { ...storedJob, workspaceRoot, logFile },
    () => executeTaskRun({ ...request, onProgress: progress }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = { job, storedJob };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const sessionId = existing.threadId ?? job.threadId ?? null;

  const cancel = await cancelKimiSession(cwd, { sessionId });
  appendLogLine(
    job.logFile,
    cancel.attempted
      ? `Requested turn cancel for session ${sessionId}.`
      : `Turn cancel not sent: ${cancel.detail}`
  );

  const kill = terminateProcessTree(job.pid ?? Number.NaN);

  // Second attempt AFTER the worker kill: the first can be a no-op when the
  // broker state was not saved yet, and a turn the dead worker left running
  // would otherwise keep the shared runtime busy with no recourse (the job
  // is about to be marked cancelled, so /kimi:cancel could not retry it).
  const postKillCancel = await cancelKimiSession(cwd, { sessionId });
  if (postKillCancel.attempted) {
    appendLogLine(job.logFile, `Post-kill turn cancel sent for session ${sessionId}.`);
  }

  // Never report a cancel that provably did nothing: no ACP cancel went out
  // and no process was signalled means the task is still running untouched.
  if (!cancel.attempted && !postKillCancel.attempted && !kill.delivered) {
    throw new Error(`Could not cancel ${job.id}: no reachable worker process or shared runtime (${cancel.detail}). Check /kimi:status ${job.id} and retry.`);
  }
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    cancelAttempted: cancel.attempted,
    cancelDetail: cancel.detail
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "setup":
      throw new Error("`setup` is not implemented yet (lands with KMP-12). Meanwhile: check `kimi --version` and run `kimi login` in a terminal.");
    case "review":
    case "adversarial-review":
      throw new Error("`review` is not implemented yet (lands with KMP-8).");
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ error: message }));
  }
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
