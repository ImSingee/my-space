/** Public HTTP contract. Independent of the Platform/Runner wire protocol. */
import { oc } from '@orpc/contract';
import { JSON_SCHEMA_INPUT_REGISTRY } from '@orpc/zod/zod4';
import { z } from 'zod';
import { APP_NAME_MAX_LENGTH } from '~/app-identity';
import { APP_SLUG_RE } from '../../packages/hatch-manifest/src/app-schema.js';
import { WORKFLOW_SLUG_RE } from '../../packages/hatch-manifest/src/workflow-schema.js';
import {
  createAppRequestSchema,
  createWorkflowRequestSchema,
  deploySourceRequestSchema,
  rollbackRequestSchema,
} from './lifecycle-schemas';

// JSON Schema counts Unicode code points, matching the shared name refinement.
JSON_SCHEMA_INPUT_REGISTRY.add(createAppRequestSchema.shape.name, {
  maxLength: APP_NAME_MAX_LENGTH,
});

export const publicApiErrors = {
  BAD_REQUEST: { status: 400, message: 'Invalid request.' },
  UNAUTHORIZED: { status: 401, message: 'Authentication required.' },
  INVALID_TOKEN: { status: 401, message: 'Invalid Run credential.' },
  RUN_ENDED: { status: 401, message: 'Run is no longer live.' },
  FORBIDDEN: { status: 403, message: 'Cross-origin request denied.' },
  NOT_FOUND: { status: 404, message: 'Resource not found.' },
  CONFLICT: { status: 409, message: 'Resource conflict.' },
  RESOURCE_GENERATION_CONFLICT: {
    status: 409,
    message: 'Resource was deleted or recreated. Fetch its current source.',
  },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'Payload too large.' },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    message: 'JSON content type required.',
  },
  INTERNAL_SERVER_ERROR: { status: 500, message: 'Internal server error.' },
  SERVICE_UNAVAILABLE: { status: 503, message: 'Service unavailable.' },
} as const;

const base = oc.errors(publicApiErrors);
const id = z.string().min(1).max(191);
const params = z.object({ id }).strict();
const empty = z.object({}).strict();
const resource = z
  .object({
    id,
    slug: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    status: z.enum(['draft', 'building', 'deployed', 'failed', 'archived']),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
const created = z
  .object({
    id,
    slug: z.string(),
    name: z.string(),
    files: z.array(
      z.object({ path: z.string(), contentBase64: z.string() }).strict(),
    ),
  })
  .strict();
const source = z
  .object({
    id,
    masterCommit: z.string().nullable(),
    bundleBase64: z.string().nullable(),
  })
  .strict();
const deployment = z
  .object({
    deploymentId: id,
    version: z.number().int().positive(),
    compatibilityVersion: z.number().int().positive(),
  })
  .strict();
const compatibility = z
  .object({
    version: z.number().int(),
    latestVersion: z.number().int(),
    minimumSupportedVersion: z.number().int(),
    isSupported: z.boolean(),
    isLatest: z.boolean(),
  })
  .strict();
const restored = z
  .object({
    version: z.number().int().positive(),
    compatibility,
  })
  .strict();

function lifecycleContract(collection: 'apps' | 'workflows') {
  const create =
    collection === 'apps'
      ? createAppRequestSchema
      : createWorkflowRequestSchema;
  return {
    list: base
      .route({ method: 'GET', path: `/${collection}`, successStatus: 200 })
      .input(empty)
      .output(z.array(resource)),
    create: base
      .route({ method: 'POST', path: `/${collection}`, successStatus: 201 })
      .input(
        create
          .extend({
            slug: create.shape.slug
              .trim()
              .regex(collection === 'apps' ? APP_SLUG_RE : WORKFLOW_SLUG_RE),
          })
          .strict(),
      )
      .output(created),
    get: base
      .route({ method: 'GET', path: `/${collection}/{id}`, successStatus: 200 })
      .input(params)
      .output(resource),
    source: base
      .route({
        method: 'GET',
        path: `/${collection}/{id}/source`,
        successStatus: 200,
      })
      .input(params)
      .output(source),
    deploy: base
      .route({
        method: 'POST',
        path: `/${collection}/{id}/deploy`,
        inputStructure: 'detailed',
        successStatus: 200,
      })
      .input(z.object({ params, body: deploySourceRequestSchema.strict() }))
      .output(deployment),
    rollback: base
      .route({
        method: 'POST',
        path: `/${collection}/{id}/rollback`,
        inputStructure: 'detailed',
        successStatus: 200,
      })
      .input(z.object({ params, body: rollbackRequestSchema.strict() }))
      .output(
        collection === 'apps'
          ? restored.extend({ dataSchemaMismatch: z.boolean() }).strict()
          : restored,
      ),
  };
}

export const platformApiContract = {
  apps: lifecycleContract('apps'),
  workflows: lifecycleContract('workflows'),
};
