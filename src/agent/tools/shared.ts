/** Shared helpers for the Agent tool modules. */
import { type Static, type TSchema } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';

/** Define a tool while keeping `execute` params typed from its schema. */
export function tool<S extends TSchema>(def: {
  name: string;
  label: string;
  description: string;
  parameters: S;
  executionMode?: AgentTool['executionMode'];
  execute: (
    id: string,
    params: Static<S>,
    signal?: AbortSignal,
    /** Stream partial output while the tool is still running. */
    onUpdate?: (partial: unknown) => void,
  ) => Promise<AgentToolResult<unknown>>;
}): AgentTool {
  return def as unknown as AgentTool;
}

export function text(content: string, details: unknown = {}) {
  return { content: [{ type: 'text' as const, text: content }], details };
}

export function requireSessionId(sessionId: string | undefined): string {
  if (!sessionId) {
    throw new Error('This tool requires an Agent session id.');
  }
  return sessionId;
}

export function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** Cap on file/tool output characters returned to the model. */
export const MAX_FILE_CHARS = 60000;

/**
 * Identifier shape that is safe to use as a single path segment, Git worktree
 * name, or database identifier: lowercase alphanumerics and hyphens. A leading
 * digit is allowed so generated ULID app ids pass alongside kebab-case slugs
 * and workflow ids. This is a path-safety guard, not a semantic check.
 */
const ID_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Guard a model-supplied id before it flows into filesystem paths, Git
 * worktrees, or database names. Without this a hallucinated or injected id like
 * "../../outside" or "/tmp/pwn" would resolve repo/worktree/DB targets outside
 * the intended workspace.
 */
export function requireIdSlug(id: string): string {
  if (!ID_SLUG_RE.test(id)) {
    throw new Error(
      `Invalid id "${id}": must contain only lowercase letters, digits, and ` +
        'hyphens.',
    );
  }
  return id;
}
