// Companion CLI tests: drive the real kimi-companion.mjs as child processes
// against the scripted fake agent (KIMI_COMPANION_AGENT_SPAWN override),
// with job state isolated via CLAUDE_PLUGIN_DATA.
// Run: node tests/kimi-companion.test.mjs  (prints KIMI-COMPANION-TESTS-GREEN)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/kimi-companion.mjs", import.meta.url));

const deadman = setTimeout(() => {
  console.error("COMPANION-TESTS TIMEOUT after 90s");
  process.exit(2);
}, 90_000);
deadman.unref?.();

function makeEnv(scenario, pluginData) {
  return {
    ...process.env,
    KIMI_COMPANION_AGENT_SPAWN: JSON.stringify({ command: process.execPath, args: [FIXTURE, scenario] }),
    CLAUDE_PLUGIN_DATA: pluginData
  };
}

function runCli(args, { env, cwd }) {
  const result = spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// Every workspace is registered for exit-time teardown so a failed
// assertion mid-suite cannot leak detached brokers or agents.
const cleanupTargets = [];
process.on("exit", () => {
  for (const target of cleanupTargets) {
    try {
      shutdownBroker(target.env, target.cwd);
    } catch {}
  }
});

function makeWorkspace(scenario) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-cli-"));
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-data-"));
  const env = makeEnv(scenario, pluginData);
  cleanupTargets.push({ env, cwd });
  return { cwd, env };
}

async function pollUntil(fn, timeoutMs = 20_000, intervalMs = 250) {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) {
      return value;
    }
    if (Date.now() - start > timeoutMs) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Deterministic teardown: request shutdown, verify the endpoint actually
// died, escalate to a process-group kill via the recorded pid if not.
function shutdownBroker(env, cwd) {
  const script = `
    (async () => {
      const m = await import(process.argv[2]);
      const p = await import(process.argv[3]);
      const s = m.loadBrokerSession(process.argv[1]);
      if (!s?.endpoint) process.exit(0);
      await m.sendBrokerShutdown(s.endpoint).catch(() => {});
      const start = Date.now();
      while (Date.now() - start < 3000) {
        const alive = await m.waitForBrokerEndpoint(s.endpoint, 100);
        if (!alive) process.exit(0);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (Number.isFinite(s.pid)) {
        try { p.terminateProcessTree(s.pid); } catch {}
      }
      process.exit(0);
    })();
  `;
  const probe = spawnSync(
    process.execPath,
    ["-e", script, cwd, pathToImport("../scripts/lib/broker-lifecycle.mjs"), pathToImport("../scripts/lib/process.mjs")],
    { env, cwd, encoding: "utf8", timeout: 15_000 }
  );
  return probe.status;
}

function pathToImport(relative) {
  return new URL(relative, import.meta.url).href;
}

// 1. Foreground task end to end: output rendered, job recorded completed
// with the ACP sessionId stored, status/result readable afterwards.
{
  const { cwd, env } = makeWorkspace("basic");
  const run = runCli(["task", "do the thing"], { env, cwd });
  assert.equal(run.status, 0, `task failed: ${run.stderr}`);
  assert.match(run.stdout, /pong/);

  const status = runCli(["status", "--json", "--all"], { env, cwd });
  assert.equal(status.status, 0);
  const report = JSON.parse(status.stdout);
  assert.equal(report.latestFinished.status, "completed");
  assert.equal(report.latestFinished.kindLabel, "task");
  assert.ok(report.latestFinished.threadId, "ACP sessionId must be recorded on the job");

  const result = runCli(["result"], { env, cwd });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /pong/);
  shutdownBroker(env, cwd);
}

// 2. Background task survives its launcher: the launcher exits immediately,
// the detached worker finishes the job, and the result is recoverable from
// a completely fresh CLI invocation (M2 criteria 1 + 2, deterministic).
{
  const { cwd, env } = makeWorkspace("slow-prompt");
  const launch = runCli(["task", "--background", "slow thing"], { env, cwd });
  assert.equal(launch.status, 0, `launch failed: ${launch.stderr}`);
  const jobId = launch.stdout.match(/as (task-[a-z0-9-]+)\./)?.[1];
  assert.ok(jobId, `no job id in: ${launch.stdout}`);
  // The launcher process has already exited here — only the detached worker
  // remains. Poll job state from fresh CLI invocations.
  const completed = await pollUntil(() => {
    const status = runCli(["status", jobId, "--json"], { env, cwd });
    if (status.status !== 0) {
      return null;
    }
    const snapshot = JSON.parse(status.stdout);
    return snapshot.job.status === "completed" ? snapshot : null;
  });
  assert.ok(completed, "background job never completed");

  const result = runCli(["result", jobId], { env, cwd });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /slow done/);
  shutdownBroker(env, cwd);
}

// 3. Busy signaling surfaces through the CLI: while a background turn runs,
// a concurrent foreground task fails with the friendly busy message
// (M2 criterion 3, deterministic).
{
  const { cwd, env } = makeWorkspace("slow-prompt-3s");
  const launch = runCli(["task", "--background", "long thing"], { env, cwd });
  assert.equal(launch.status, 0);
  const jobId = launch.stdout.match(/as (task-[a-z0-9-]+)\./)?.[1];
  // Wait until the background worker's turn is actually in flight.
  const running = await pollUntil(() => {
    const status = runCli(["status", jobId, "--json"], { env, cwd });
    const snapshot = status.status === 0 ? JSON.parse(status.stdout) : null;
    return snapshot?.job.status === "running" ? snapshot : null;
  }, 10_000);
  assert.ok(running, "background job never started running");

  const concurrent = runCli(["task", "second thing"], { env, cwd });
  assert.notEqual(concurrent.status, 0);
  assert.match(concurrent.stdout + concurrent.stderr, /busy with another turn/);

  const completed = await pollUntil(() => {
    const status = runCli(["status", jobId, "--json"], { env, cwd });
    const snapshot = status.status === 0 ? JSON.parse(status.stdout) : null;
    return snapshot?.job.status === "completed" ? snapshot : null;
  });
  assert.ok(completed, "background job should still complete after the busy rejection");
  shutdownBroker(env, cwd);
}

// 4. Cancel: a hanging background turn is cancelled; the job is marked
// cancelled and the shared runtime is NOT left busy.
{
  const { cwd, env } = makeWorkspace("cancellable");
  const launch = runCli(["task", "--background", "never ending"], { env, cwd });
  assert.equal(launch.status, 0);
  const jobId = launch.stdout.match(/as (task-[a-z0-9-]+)\./)?.[1];
  const running = await pollUntil(() => {
    const status = runCli(["status", jobId, "--json"], { env, cwd });
    const snapshot = status.status === 0 ? JSON.parse(status.stdout) : null;
    return snapshot?.job.status === "running" ? snapshot : null;
  }, 10_000);
  assert.ok(running, "job never reached running state");

  const cancel = runCli(["cancel", jobId], { env, cwd });
  assert.equal(cancel.status, 0, `cancel failed: ${cancel.stderr}`);
  assert.match(cancel.stdout, /Cancelled task-/);

  const status = runCli(["status", jobId, "--json"], { env, cwd });
  assert.equal(JSON.parse(status.stdout).job.status, "cancelled");

  // The broker must be responsive (not busy) afterwards. Probe with a raw
  // session/new — a fixture "cancellable" prompt would hold by design, so a
  // follow-up task is the wrong instrument here.
  const probeScript = `
    const deadman = setTimeout(() => process.exit(3), 5000);
    (async () => {
      const { AcpClient } = await import(process.argv[2]);
      const { loadBrokerSession } = await import(process.argv[3]);
      const endpoint = loadBrokerSession(process.argv[1])?.endpoint;
      if (!endpoint) process.exit(4);
      const client = await AcpClient.connect(process.argv[1], { brokerEndpoint: endpoint });
      await client.request("session/new", { cwd: process.argv[1], mcpServers: [] });
      await client.close();
      clearTimeout(deadman);
      process.exit(0);
    })().catch(() => process.exit(5));
  `;
  const probeOk = await pollUntil(() => {
    const probe = spawnSync(
      process.execPath,
      ["-e", probeScript, cwd, pathToImport("../scripts/lib/acp-client.mjs"), pathToImport("../scripts/lib/broker-lifecycle.mjs")],
      { env, cwd, encoding: "utf8", timeout: 10_000 }
    );
    return probe.status === 0 ? true : null;
  }, 10_000, 500);
  assert.ok(probeOk, "broker stayed busy after cancel");
  shutdownBroker(env, cwd);
}

// 5. Resume: --resume-last picks the stored sessionId from the last task
// job and goes through session/load (fixture reports resumed vs fresh).
{
  const { cwd, env } = makeWorkspace("resume-check");
  const first = runCli(["task", "start something"], { env, cwd });
  assert.equal(first.status, 0);
  assert.match(first.stdout, /fresh-session/);

  const firstStatus = JSON.parse(runCli(["status", "--json", "--all"], { env, cwd }).stdout);
  const storedSessionId = firstStatus.latestFinished.threadId;
  assert.ok(storedSessionId);

  const resumed = runCli(["task", "--resume-last"], { env, cwd });
  assert.equal(resumed.status, 0, `resume failed: ${resumed.stderr}`);
  assert.match(resumed.stdout, /resumed-session/);

  const secondStatus = JSON.parse(runCli(["status", "--json", "--all"], { env, cwd }).stdout);
  assert.equal(secondStatus.latestFinished.threadId, storedSessionId, "resumed job must reuse the stored sessionId");
  shutdownBroker(env, cwd);
}

// 6. Guardrails: bogus model rejected with the menu; no prompt and no
// resume is an error; unimplemented subcommands say which item ships them.
{
  const { cwd, env } = makeWorkspace("basic");
  const model = runCli(["task", "--model", "gpt-4", "x"], { env, cwd });
  assert.notEqual(model.status, 0);
  assert.match(model.stderr, /Unknown model "gpt-4"/);
  assert.match(model.stderr, /highspeed/);

  const empty = runCli(["task"], { env, cwd });
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /Provide a prompt/);

  const setup = runCli(["setup"], { env, cwd });
  assert.notEqual(setup.status, 0);
  assert.match(setup.stderr, /KMP-12/);
}

// 6b. --model alias resolves to the wire id and reaches the agent via
// session/set_model (fixture echoes what it received).
{
  const { cwd, env } = makeWorkspace("model-check");
  const aliased = runCli(["task", "--model", "highspeed", "x"], { env, cwd });
  assert.equal(aliased.status, 0, `model task failed: ${aliased.stderr}`);
  assert.match(aliased.stdout, /model:kimi-code\/kimi-for-coding-highspeed,thinking/);
  shutdownBroker(env, cwd);
}
{
  const { cwd, env } = makeWorkspace("model-check");
  const noFlag = runCli(["task", "x"], { env, cwd });
  assert.equal(noFlag.status, 0);
  assert.match(noFlag.stdout, /model:default/);
  shutdownBroker(env, cwd);
}

// 7. --write end to end: the allow policy reaches the session the task runs
// on (fixture reports which option the broker selected) AND the permission
// event plumbing records the decision on the job payload.
{
  const { cwd, env } = makeWorkspace("permission-standard");
  const writeRun = runCli(["task", "--write", "--json", "edit something"], { env, cwd });
  assert.equal(writeRun.status, 0, `write task failed: ${writeRun.stderr}`);
  const payload = JSON.parse(writeRun.stdout);
  assert.match(payload.rawOutput, /perm:ok/);
  assert.equal(payload.permissionEvents.length, 1);
  assert.equal(payload.permissionEvents[0].decision, "allow");
  assert.equal(payload.permissionEvents[0].optionId, "ok");
  shutdownBroker(env, cwd);
}
{
  const { cwd, env } = makeWorkspace("permission-standard");
  const readRun = runCli(["task", "--json", "read-only thing"], { env, cwd });
  assert.equal(readRun.status, 0);
  const payload = JSON.parse(readRun.stdout);
  assert.match(payload.rawOutput, /perm:no/);
  assert.equal(payload.permissionEvents.length, 1);
  assert.equal(payload.permissionEvents[0].decision, "reject");
  assert.equal(payload.permissionEvents[0].optionId, "no");
  shutdownBroker(env, cwd);
}

// 8. Externally killed worker: status must reconcile the record to failed
// instead of reporting "running" forever, and cancel must then refuse.
{
  const { cwd, env } = makeWorkspace("cancellable");
  const launch = runCli(["task", "--background", "doomed"], { env, cwd });
  const jobId = launch.stdout.match(/as (task-[a-z0-9-]+)\./)?.[1];
  const running = await pollUntil(() => {
    const status = runCli(["status", jobId, "--json"], { env, cwd });
    const snapshot = status.status === 0 ? JSON.parse(status.stdout) : null;
    return snapshot?.job.status === "running" && Number.isFinite(snapshot.job.pid) ? snapshot : null;
  }, 10_000);
  assert.ok(running, "job never reached running with a recorded pid");

  process.kill(running.job.pid, "SIGKILL");
  const reconciled = await pollUntil(() => {
    const status = runCli(["status", jobId, "--json"], { env, cwd });
    const snapshot = status.status === 0 ? JSON.parse(status.stdout) : null;
    return snapshot?.job.status === "failed" ? snapshot : null;
  }, 10_000);
  assert.ok(reconciled, "dead worker was never reconciled to failed");
  assert.match(reconciled.job.errorMessage ?? "", /Worker process died/);
  shutdownBroker(env, cwd);
}

// 9. Foreground cancel: a running foreground task (NOT a group leader) is
// killed for real, and the job record ends cancelled — never a false
// "cancelled" while the task actually continues.
{
  const { cwd, env } = makeWorkspace("slow-prompt-3s");
  const fg = spawn(process.execPath, [CLI, "task", "long foreground"], { env, cwd, stdio: "ignore" });
  const fgExit = new Promise((resolve) => fg.on("exit", (code, signal) => resolve({ code, signal })));

  const running = await pollUntil(() => {
    const status = runCli(["status", "--json", "--all"], { env, cwd });
    const snapshot = status.status === 0 ? JSON.parse(status.stdout) : null;
    const job = snapshot?.running?.[0];
    return job && job.threadId ? job : null;
  }, 10_000);
  assert.ok(running, "foreground job never reached running with a sessionId");

  const cancel = runCli(["cancel", running.id], { env, cwd });
  assert.equal(cancel.status, 0, `foreground cancel failed: ${cancel.stderr}`);

  const exited = await Promise.race([fgExit, new Promise((resolve) => setTimeout(() => resolve(null), 8000))]);
  assert.ok(exited, "foreground process kept running after cancel reported success");

  const finalStatus = runCli(["status", running.id, "--json"], { env, cwd });
  assert.equal(JSON.parse(finalStatus.stdout).job.status, "cancelled");
  shutdownBroker(env, cwd);
}

// 10. Review end to end: git context collected, prompt-driven review runs
// read-only, fenced JSON tolerated, findings rendered, job recorded.
function makeGitWorkspace(scenario) {
  const ws = makeWorkspace(scenario);
  spawnSync("git", ["init", "-q"], { cwd: ws.cwd, encoding: "utf8" });
  fs.mkdirSync(path.join(ws.cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws.cwd, "src", "buggy.mjs"), "export function compute(total, divisor) {\n  return total / divisor;\n}\n");
  return ws;
}
{
  const { cwd, env } = makeGitWorkspace("review-json");
  const review = runCli(["review", "--wait", "check the math"], { env, cwd });
  assert.equal(review.status, 0, `review failed: ${review.stderr}`);
  assert.match(review.stdout, /# Kimi Review/);
  assert.match(review.stdout, /Verdict: needs-attention/);
  assert.match(review.stdout, /Planted divide-by-zero/);
  assert.match(review.stdout, /Guard the divisor/);

  const status = runCli(["status", "--json", "--all"], { env, cwd });
  const report = JSON.parse(status.stdout);
  assert.equal(report.latestFinished.kindLabel, "review");
  assert.equal(report.latestFinished.status, "completed");
  shutdownBroker(env, cwd);
}

// 11. Review with unparseable output is a FAILED review: parse error and
// raw message surfaced, nonzero exit, job recorded failed.
{
  const { cwd, env } = makeGitWorkspace("review-bad-json");
  const review = runCli(["review", "--wait"], { env, cwd });
  assert.notEqual(review.status, 0, "structurally failed review must exit nonzero");
  assert.match(review.stdout, /did not return valid structured JSON/i);
  assert.match(review.stdout, /could not produce structured output/);
  const status = runCli(["status", "--json", "--all"], { env, cwd });
  assert.equal(JSON.parse(status.stdout).latestFinished.status, "failed");
  shutdownBroker(env, cwd);
}

// 11d. A review turn that ends with NO message at all is a failed review
// (regression: empty stderr as failureMessage laundered parseError to "").
{
  const { cwd, env } = makeGitWorkspace("review-empty");
  const review = runCli(["review", "--wait", "--json"], { env, cwd });
  assert.notEqual(review.status, 0, "empty review output must exit nonzero");
  const payload = JSON.parse(review.stdout);
  assert.equal(payload.result, null);
  assert.match(payload.parseError ?? "", /did not return/);
  const status = runCli(["status", "--json", "--all"], { env, cwd });
  assert.equal(JSON.parse(status.stdout).latestFinished.status, "failed", "empty review must persist as failed");
  shutdownBroker(env, cwd);
}

// 11b. Schema-invalid JSON (verdict outside the enum) also fails the review.
{
  const { cwd, env } = makeGitWorkspace("review-invalid-schema");
  const review = runCli(["review", "--wait"], { env, cwd });
  assert.notEqual(review.status, 0);
  assert.match(review.stdout, /unexpected review shape/i);
  assert.match(review.stdout, /Invalid verdict/);
  shutdownBroker(env, cwd);
}

// 11c. Review invoked from a SUBDIRECTORY still targets the whole repo: the
// only change is a root-level untracked file, which must select
// working-tree scope (branch scope would fail in this commitless repo).
{
  const { cwd, env } = makeGitWorkspace("review-json");
  const subdir = path.join(cwd, "src");
  const review = runCli(["review", "--wait"], { env, cwd: subdir });
  assert.equal(review.status, 0, `subdir review failed: ${review.stderr}`);
  assert.match(review.stdout, /Target: working tree diff/);
  shutdownBroker(env, cwd);
}

// 12. Review outside a git repository fails with a clear message.
{
  const { cwd, env } = makeWorkspace("review-json");
  const review = runCli(["review", "--wait"], { env, cwd });
  assert.notEqual(review.status, 0);
  assert.match(review.stderr + review.stdout, /Git repository/i);
}

// 13. M3 security criterion: a write attempt DURING A REVIEW is rejected,
// and the reject path is ASSERTED three ways — the agent saw the reject
// option selected (summary echo), our handler recorded the event with the
// reject decision, and the review still completed with a valid verdict.
{
  const { cwd, env } = makeGitWorkspace("review-write-attempt");
  const review = runCli(["review", "--wait", "--json"], { env, cwd });
  assert.equal(review.status, 0, `review failed: ${review.stderr}`);
  const payload = JSON.parse(review.stdout);
  assert.equal(payload.result.summary, "perm-outcome:no", "the agent must have received the REJECT option");
  assert.equal(payload.permissionRejections, 1, "the reject path must be recorded, not inferred");
  assert.ok(payload.permissionEvents.every((event) => event.decision === "reject"));
  assert.equal(payload.result.verdict, "needs-attention");

  const status = runCli(["status", "--json", "--all"], { env, cwd });
  assert.equal(JSON.parse(status.stdout).latestFinished.status, "completed");
  shutdownBroker(env, cwd);
}

// Final leak sweep: the suite itself fails if any scenario left a broker or
// fake agent running — silent leaks must not depend on a manual pgrep.
await new Promise((resolve) => setTimeout(resolve, 500));
const sweep = spawnSync("pgrep", ["-f", "fake-acp-agent|acp-broker.mjs serve"], { encoding: "utf8" });
assert.equal((sweep.stdout ?? "").trim(), "", `leaked processes:\n${sweep.stdout}`);

console.log("KIMI-COMPANION-TESTS-GREEN");
process.exit(0);
