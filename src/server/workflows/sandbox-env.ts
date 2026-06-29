/**
 * Server-only: the environment handed to a workflow's Deno subprocess.
 *
 * Workflows run untrusted, author-written code, so they share the same
 * allowlisted environment as deployed app backends. See `../sandbox-env`.
 */
export { subprocessSandboxEnv as workflowSandboxEnv } from '../sandbox-env';
