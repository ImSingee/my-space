import {
  fromJson,
  toJson,
  type DescMessage,
  type JsonObject,
  type JsonValue,
} from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { z } from 'zod';
import {
  queryAppKvRequestSchema,
  queryAppDataTableRequestSchema,
  type QueryAppKvRequest,
  type QueryAppDataTableRequest,
} from '../../../src/platform-api/data-schemas';
/** Connect transport with CLI-specific projection and recovery semantics. */
import {
  createClient,
  Code,
  ConnectError,
  type Transport,
} from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import {
  CreateAppRequestSchema,
  AppService,
} from '../../hatch-platform-api/gen/hatch/platform/v1/app_pb';
import {
  CreateWorkflowRequestSchema,
  WorkflowService,
} from '../../hatch-platform-api/gen/hatch/platform/v1/workflow_pb';
import { AuthService } from '../../hatch-platform-api/gen/hatch/platform/v1/auth_pb';
import { SdkService } from '../../hatch-platform-api/gen/hatch/platform/v1/sdk_pb';
import { PublicErrorSchema } from '../../hatch-platform-api/gen/hatch/platform/v1/error_pb';
import {
  type Resource,
  type Source,
  type Deployment,
  type RestoredVersion,
} from '../../hatch-platform-api/gen/hatch/platform/v1/lifecycle_pb';
import { type File } from '../../hatch-platform-api/gen/hatch/platform/v1/file_pb';
import type { AuthStatus } from '../../hatch-platform-api/auth';
import type { Profile } from './config';
import { CliError } from './error';

export function credentialHeaders(credential: Profile): Record<string, string> {
  return credential.apiKey
    ? { 'x-api-key': credential.apiKey }
    : { authorization: `Bearer ${credential.token}` };
}
const invalidResponse = () =>
  new CliError(
    'invalid_response',
    'The platform returned an incomplete response.',
    7,
  );
function required<T>(value: T | undefined): T {
  if (value === undefined) throw invalidResponse();
  return value;
}
/**
 * Released CLIs must keep working after additive platform changes. JSON views
 * are server allowlists, so read only fields the CLI uses and pass the rest
 * through unchanged instead of re-validating them against a bundled snapshot.
 */
function jsonObject(value: JsonValue): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalidResponse();
  return value;
}
const resourceViewSchema = z.looseObject({
  id: z.string(),
  slug: z.string(),
  createdAt: z.string(),
});
const basicResource = (value: Resource) => ({
  id: value.id,
  slug: value.slug,
  name: value.name,
  description: value.description ?? null,
  status: value.status,
  createdAt: value.createdAt,
  updatedAt: value.updatedAt,
});
const files = (values: File[]) =>
  values.map((value) => ({
    path: value.path,
    contentBase64: Buffer.from(value.content).toString('base64'),
  }));
const source = (value: Source) => ({
  id: value.id,
  masterCommit: value.masterCommit ?? null,
  bundleBase64:
    value.bundle === undefined
      ? null
      : Buffer.from(value.bundle).toString('base64'),
});
const deployment = (value: Deployment) => ({
  deploymentId: value.deploymentId,
  version: value.version,
  compatibilityVersion: value.compatibilityVersion,
  ...(value.slug === undefined ? {} : { slug: value.slug }),
  normalized: jsonObject(toJson(ValueSchema, required(value.normalized))),
});
const restored = (value: RestoredVersion) => ({
  version: value.version,
  compatibility: {
    version: required(value.compatibility).version,
    latestVersion: required(value.compatibility).latestVersion,
    minimumSupportedVersion: required(value.compatibility)
      .minimumSupportedVersion,
    isSupported: required(value.compatibility).isSupported,
    isLatest: required(value.compatibility).isLatest,
  },
  ...(value.dataSchemaMismatch === undefined
    ? {}
    : { dataSchemaMismatch: value.dataSchemaMismatch }),
});
type CreateInput = {
  slug: string;
  name: string;
  description?: string;
  pin?: boolean;
};
type DeployInput = {
  params: { id: string };
  body: {
    message: string;
    generation: string;
    bundleBase64: string;
    allowDestructiveDataMigration?: boolean;
    dataMigrationApprovalToken?: string;
  };
};
function parseData<T>(
  schema: { parse: (value: unknown) => T },
  value: unknown,
): T {
  try {
    return schema.parse(value);
  } catch {
    throw new CliError(
      'invalid_input',
      'Input does not match the data operation contract.',
      2,
    );
  }
}

/** Keep the CLI's persisted/output DTOs separate from generated wire messages. */
function parseCreate<D extends DescMessage>(schema: D, input: CreateInput) {
  try {
    return fromJson(schema, input as JsonObject, { ignoreUnknownFields: true });
  } catch {
    throw new CliError(
      'invalid_input',
      'Create input does not match the Protobuf message types.',
      2,
    );
  }
}

export function cliClient(transport: Transport) {
  const apps = createClient(AppService, transport);
  const workflows = createClient(WorkflowService, transport);
  function lifecycle(client: {
    list: (
      request: Record<string, never>,
    ) => Promise<{ resources: Resource[] }>;
    create: (
      request: CreateInput,
    ) => Promise<{ id: string; slug: string; name: string; files: File[] }>;
    get: (request: { id: string }) => Promise<{ resource?: Resource }>;
    source: (request: { id: string }) => Promise<{ source?: Source }>;
    deploy: (request: {
      id: string;
      message: string;
      generation: string;
      bundle: Uint8Array;
      allowDestructiveDataMigration?: boolean;
      dataMigrationApprovalToken?: string;
    }) => Promise<{ deployment?: Deployment }>;
    rollback: (request: {
      id: string;
      version: number;
    }) => Promise<{ restored?: RestoredVersion }>;
  }) {
    const resource = (value: Resource) => {
      const result = resourceViewSchema.safeParse({
        ...basicResource(value),
        ...jsonObject(toJson(ValueSchema, required(value.view))),
      });
      if (!result.success) throw invalidResponse();
      return result.data;
    };
    return {
      list: async (_input: Record<string, never>) =>
        (await client.list({})).resources.map((value) => resource(value)),
      create: async (input: CreateInput) => {
        const result = await client.create(input);
        return {
          id: result.id,
          slug: result.slug,
          name: result.name,
          files: files(result.files),
        };
      },
      get: async (input: { id: string }) =>
        resource(required((await client.get(input)).resource)),
      source: async (input: { id: string }) =>
        source(required((await client.source(input)).source)),
      deploy: async (input: DeployInput) =>
        deployment(
          required(
            (
              await client.deploy({
                id: input.params.id,
                ...input.body,
                bundle: Buffer.from(input.body.bundleBase64, 'base64'),
              })
            ).deployment,
          ),
        ),
      rollback: async (input: {
        params: { id: string };
        body: { version: number };
      }) =>
        restored(
          required(
            (
              await client.rollback({
                id: input.params.id,
                version: input.body.version,
              })
            ).restored,
          ),
        ),
    };
  }
  const auth = createClient(AuthService, transport);
  const sdk = createClient(SdkService, transport);
  return {
    apps: {
      ...lifecycle({
        list: apps.listApps,
        create: (input) =>
          apps.createApp(parseCreate(CreateAppRequestSchema, input)),
        get: apps.getApp,
        source: apps.getAppSource,
        deploy: apps.deployApp,
        rollback: apps.rollbackApp,
      }),
      kv: async (input: {
        params: { id: string };
        body: QueryAppKvRequest;
      }) => {
        const body = parseData(queryAppKvRequestSchema, input.body);
        const result = await apps.queryAppKv({
          id: input.params.id,
          input: fromJson(ValueSchema, body),
        });
        return jsonObject(toJson(ValueSchema, required(result.result)));
      },
      dataTable: async (input: {
        params: { id: string };
        body: QueryAppDataTableRequest;
      }) => {
        const body = parseData(queryAppDataTableRequestSchema, input.body);
        const result = await apps.queryAppDataTable({
          id: input.params.id,
          input: fromJson(ValueSchema, body),
        });
        return jsonObject(toJson(ValueSchema, required(result.result)));
      },
      dbQuery: async (input: {
        params: { id: string };
        body: { sql: string };
      }) => {
        const result = await apps.queryAppDb({
          id: input.params.id,
          sql: input.body.sql,
        });
        return { text: result.text, rowCount: result.rowCount };
      },
      associate: async (input: {
        params: { id: string };
        body: Record<string, never>;
      }) => {
        const result = await apps.associateAppSession({ id: input.params.id });
        return { appId: result.appId, association: result.association };
      },
    },
    workflows: lifecycle({
      list: workflows.listWorkflows,
      create: (input) =>
        workflows.createWorkflow(
          parseCreate(CreateWorkflowRequestSchema, input),
        ),
      get: workflows.getWorkflow,
      source: workflows.getWorkflowSource,
      deploy: workflows.deployWorkflow,
      rollback: workflows.rollbackWorkflow,
    }),
    auth: {
      status: async (_input: Record<string, never>): Promise<AuthStatus> => {
        const result = await auth.getStatus({});
        const common = {
          authenticated: true as const,
          authority: 'platform' as const,
          expiresAt: result.expiresAt ?? null,
        };
        const credential = result.credential;
        if (credential.case === 'run')
          return {
            ...common,
            credentialType: 'run',
            context: {
              runId: credential.value.runId,
              sessionId: credential.value.sessionId,
              runnerId: credential.value.runnerId,
            },
          };
        if (credential.case === 'session' || credential.case === 'apiKey') {
          const value = credential.value;
          if (!value.user)
            throw new CliError(
              'invalid_response',
              'Missing authorization metadata.',
              7,
            );
          const user = {
            id: value.user.id,
            email: value.user.email,
            name: value.user.name,
          };
          if (credential.case === 'session')
            return { ...common, credentialType: 'session', user };
          return {
            ...common,
            credentialType: 'api-key',
            user,
            key: {
              id: credential.value.id,
              name: credential.value.name ?? null,
            },
          };
        }
        throw new CliError(
          'invalid_response',
          'Missing authorization metadata.',
          7,
        );
      },
    },
    sdk: {
      get: async (input: { kind: 'app' | 'workflow' }) => {
        const result = await sdk.getSdk(input);
        return {
          files: files(result.files),
          ...(result.tooling
            ? {
                tooling: {
                  bufVersion: result.tooling.bufVersion,
                  protocGenEsVersion: result.tooling.protocGenEsVersion,
                },
              }
            : {}),
        };
      },
    },
  };
}
export type PlatformClient = ReturnType<typeof cliClient>;

export function platformClient(
  credential: Profile,
  timeout: number,
  signal: AbortSignal,
) {
  const headers = credentialHeaders(credential);
  const transport = createConnectTransport({
    baseUrl: `${credential.url}/api/rpc`,
    useBinaryFormat: true,
    defaultTimeoutMs: timeout,
    interceptors: [
      (next) => (request) => {
        for (const [key, value] of Object.entries(headers))
          request.header.set(key, value);
        return next(request);
      },
    ],
    fetch: async (input, init) => fetch(input, { ...init, redirect: 'error' }),
  });
  // Convert errors after Connect's call boundary, which wraps interceptor errors.
  return cliClient({
    ...transport,
    unary: async (
      method,
      callSignal,
      timeoutMs,
      callHeaders,
      input,
      contextValues,
    ) => {
      try {
        return await transport.unary(
          method,
          callSignal ? AbortSignal.any([callSignal, signal]) : signal,
          timeoutMs,
          callHeaders,
          input,
          contextValues,
        );
      } catch (error) {
        const safe = publicError(error);
        let message = safe.message;
        for (const value of [credential.token, credential.apiKey])
          if (value) message = message.replaceAll(value, '[redacted]');
        throw new CliError(safe.code, message, safe.exitCode, safe.httpStatus);
      }
    },
  });
}

export function publicError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof ConnectError) {
    const detail = error.findDetails(PublicErrorSchema)[0];
    const status = detail?.httpStatus;
    const exit =
      error.code === Code.Unauthenticated
        ? 3
        : error.code === Code.PermissionDenied
          ? 4
          : error.code === Code.NotFound
            ? 5
            : error.code === Code.Aborted ||
                error.code === Code.AlreadyExists ||
                error.code === Code.FailedPrecondition
              ? 6
              : error.code === Code.InvalidArgument ||
                  error.code === Code.OutOfRange ||
                  error.code === Code.ResourceExhausted
                ? 2
                : error.code === Code.Canceled
                  ? 130
                  : 7;
    const known = !!detail && !!status && status < 500;
    return new CliError(
      detail?.code ??
        (error.code === Code.Canceled
          ? 'cancelled'
          : error.code === Code.DeadlineExceeded
            ? 'outcome_unknown'
            : 'rpc_error'),
      known
        ? error.rawMessage
        : 'The platform request failed. Inspect platform state before retrying mutations.',
      exit,
      status,
    );
  }
  return new CliError('internal_error', 'CLI operation failed.', 1);
}
