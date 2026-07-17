// Plugin-surface lint: the user-facing plugin files (commands, agents,
// skills, hooks, prompts, manifest) must be internally consistent — no
// stale codex references, no invocations of scripts that don't exist, no
// broken agent->skill links. This is the regression guard that would have
// caught commands/setup.md still invoking the deleted codex script.
// Run: node tests/plugin-surface.test.mjs  (prints PLUGIN-SURFACE-TESTS-GREEN)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function listFiles(dir, extension) {
  const absolute = path.join(ROOT, dir);
  if (!fs.existsSync(absolute)) {
    return [];
  }
  const results = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(extension)) {
      results.push(path.join(entry.parentPath ?? entry.path, entry.name));
    }
  }
  return results;
}

const surfaceFiles = [
  ...listFiles("commands", ".md"),
  ...listFiles("agents", ".md"),
  ...listFiles("skills", ".md"),
  ...listFiles("prompts", ".md"),
  path.join(ROOT, "hooks", "hooks.json"),
  path.join(ROOT, ".claude-plugin", "plugin.json")
];

// 1. No codex references anywhere on the plugin surface.
for (const file of surfaceFiles) {
  const content = fs.readFileSync(file, "utf8");
  assert.ok(!/codex/i.test(content), `stale codex reference in ${path.relative(ROOT, file)}`);
}

// 2. Every ${CLAUDE_PLUGIN_ROOT}-relative script invocation points at a
// file that exists.
for (const file of surfaceFiles) {
  const content = fs.readFileSync(file, "utf8");
  for (const match of content.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_\-./]+)/g)) {
    const target = path.join(ROOT, match[1]);
    assert.ok(fs.existsSync(target), `${path.relative(ROOT, file)} references missing ${match[1]}`);
  }
}

// 3. Manifests parse and carry the expected identity.
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
assert.equal(manifest.name, "kimi");
const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8"));
assert.ok(hooks.hooks.Stop, "Stop hook must be wired");
assert.ok(hooks.hooks.SessionStart && hooks.hooks.SessionEnd, "lifecycle hooks must be wired");

// 4. Agent frontmatter: every referenced skill exists as a skills/ dir.
for (const file of listFiles("agents", ".md")) {
  const content = fs.readFileSync(file, "utf8");
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const skillsSection = frontmatter.match(/skills:\n((?:\s+-\s+.+\n?)+)/)?.[1] ?? "";
  for (const line of skillsSection.split("\n")) {
    const skill = line.match(/-\s+(.+)/)?.[1]?.trim();
    if (skill) {
      assert.ok(
        fs.existsSync(path.join(ROOT, "skills", skill, "SKILL.md")),
        `${path.relative(ROOT, file)} references missing skill ${skill}`
      );
    }
  }
}

// 5. Prompt templates: every {{PLACEHOLDER}} used by the engine is present
// where expected (spot checks on load-bearing ones).
const reviewPrompt = fs.readFileSync(path.join(ROOT, "prompts", "review.md"), "utf8");
for (const placeholder of ["{{TARGET_LABEL}}", "{{OUTPUT_SCHEMA}}", "{{CONTEXT_BOUNDARY}}", "{{REVIEW_INPUT}}"]) {
  assert.ok(reviewPrompt.includes(placeholder), `prompts/review.md missing ${placeholder}`);
}
const stopPrompt = fs.readFileSync(path.join(ROOT, "prompts", "stop-review-gate.md"), "utf8");
for (const placeholder of ["{{CLAUDE_RESPONSE_BLOCK}}", "{{CONTEXT_BOUNDARY}}", "{{REPO_CONTEXT_BLOCK}}"]) {
  assert.ok(stopPrompt.includes(placeholder), `prompts/stop-review-gate.md missing ${placeholder}`);
}

console.log("PLUGIN-SURFACE-TESTS-GREEN");
