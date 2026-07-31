/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 */

import type { AgentConfig } from "./types.js";

const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([
  [
    "general-purpose",
    {
      name: "general-purpose",
      displayName: "Agent",
      description: "General-purpose agent for reviews, diagnosis, design analysis, dependency/API/deprecation research, recommendations, and multi-step tasks. Use it when the requested deliverable requires evaluation or judgment, even when reaching it requires substantial codebase search.",
      // builtinToolNames omitted — means "all available tools" (resolved at lookup time)
      // inheritContext / runInBackground / isolated omitted — strategy fields, callers decide per-call.
      // Setting them to false would lock callsite intent (see resolveAgentInvocationConfig in invocation-config.ts).
      extensions: true,
      skills: true,
      systemPrompt: "",
      promptMode: "append",
      isDefault: true,
    },
  ],
  [
    "Explore",
    {
      name: "Explore",
      displayName: "Explore",
      description: "Read-only codebase locator for finding files, symbols, references, precedents, and tracing local code paths. Use it only when the requested deliverable is where something lives or how local code connects. Use general-purpose for code or plan review, diagnosis, design decisions, recommendations, and other evaluative work, even when those tasks require substantial codebase search. Specify search breadth as \"quick\", \"medium\", or \"thorough\".",
      builtinToolNames: READ_ONLY_TOOLS,
      extensions: true,
      skills: true,
      // Fast, lower-cost model for targeted codebase search.
      model: "openai-codex/gpt-5.6-luna",
      systemPrompt: `You are a read-only codebase locator. Find files, symbols, references, precedents, and trace local code paths by following relevant evidence. Report what exists and where; do not perform code or plan reviews, diagnose behavior, make design decisions, or recommend solutions.

Keep the working tree and system state unchanged. Use tools only to inspect existing files and history.

# Search
- Use the find tool for file names and patterns, the grep tool for content, and the read tool for files
- Use Bash only for read-only inspection commands such as git status, git log, and git diff
- Match the requested breadth: quick for a direct lookup, medium for following nearby references, and thorough for related locations and naming variants
- Start with the most likely target, then follow imports, callers, and tests only when they help answer the question
- Run independent searches in parallel when useful
- Distinguish confirmed findings from inference; when something is not found, summarize where you looked

# Output
- Answer the question first
- Cite absolute file paths and relevant line ranges
- Keep the result concise unless the requested breadth requires detail`,
      promptMode: "replace",
      isDefault: true,
    },
  ],
]);
