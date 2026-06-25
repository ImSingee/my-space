/** Server-only: canonical workspace paths used by the Agent, builder, runtime. */
import path from 'node:path';

export const REPO_ROOT = process.cwd();
export const WORKSPACE_ROOT = path.resolve(REPO_ROOT, 'workspace');
/** Subapp source trees the Agent authors: workspace/subapps/<id>. */
export const SUBAPPS_DIR = path.resolve(WORKSPACE_ROOT, 'subapps');
/** Built artifacts (live, served): workspace/builds/<id>/{app,widgets}. */
export const BUILDS_DIR = path.resolve(WORKSPACE_ROOT, 'builds');
/** Per-deployment build snapshots for rollback: workspace/versions/<id>/<deploymentId>. */
export const VERSIONS_DIR = path.resolve(WORKSPACE_ROOT, 'versions');
/** Persistent per-subapp blob storage: workspace/storage/<id>/<key>. */
export const STORAGE_DIR = path.resolve(WORKSPACE_ROOT, 'storage');
/** Markdown skills available to the Agent. */
export const SKILLS_DIR = path.resolve(REPO_ROOT, 'skills');
/** Subapp scaffolding template. */
export const TEMPLATES_DIR = path.resolve(REPO_ROOT, 'templates');

export function subappSrcDir(id: string): string {
  return path.resolve(SUBAPPS_DIR, id);
}

export function subappBuildDir(id: string): string {
  return path.resolve(BUILDS_DIR, id);
}

/** Snapshot directory for a specific deployment (used for rollback). */
export function subappVersionsDir(id: string): string {
  return path.resolve(VERSIONS_DIR, id);
}

export function deploymentBuildDir(id: string, deploymentId: string): string {
  return path.resolve(VERSIONS_DIR, id, deploymentId);
}

/** Persistent storage root for a subapp's blobs. */
export function subappStorageDir(id: string): string {
  return path.resolve(STORAGE_DIR, id);
}
