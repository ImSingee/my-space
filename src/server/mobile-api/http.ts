import { z } from 'zod';
import { authenticateSessionRequest } from '~server/session-http-auth';
import { AppError } from '~server/errors';
import {
  insertAgentSession,
  listSessionSummaries,
  loadSessionDetail,
} from '~server/agent-session-store';
import { listMobileApps, getMobileApp, getMobileConfig } from './data';
import { consumeMobileHandoff, createMobileHandoff } from './handoff';
import { readMobileJson } from './body';

const createSchema = z.strictObject({
  title: z.string().max(200).optional(),
  providerId: z.string().min(1).max(200).nullish(),
  modelId: z.string().min(1).max(200).nullish(),
});
const handoffSchema = z.strictObject({ appId: z.string().min(1).max(200) });

function secureResponse(response: Response) {
  response.headers.set('cache-control', 'no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-content-type-options', 'nosniff');
  return response;
}

async function dispatch(request: Request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '');
  const base = '/api/mobile/v1';
  if (path === `${base}/handoffs/consume` && request.method === 'POST') {
    return consumeMobileHandoff(request);
  }
  const authentication = await authenticateSessionRequest(request, {
    bearerOnly: true,
  });
  if (authentication instanceof Response) return authentication;
  if (request.method === 'GET') {
    if (path === `${base}/apps`)
      return Response.json({ apps: await listMobileApps() });
    if (path === `${base}/config`)
      return Response.json(await getMobileConfig());
    if (path === `${base}/sessions`) {
      const appId = z
        .string()
        .min(1)
        .max(200)
        .optional()
        .parse(url.searchParams.get('appId') ?? undefined);
      return Response.json({ sessions: await listSessionSummaries({ appId }) });
    }
    const match = /^\/api\/mobile\/v1\/(apps|sessions)\/([^/]+)$/.exec(path);
    if (match) {
      const id = decodeURIComponent(match[2]);
      if (match[1] === 'apps') {
        const app = await getMobileApp(id);
        if (!app) throw new AppError('App not found', 404);
        return Response.json({ app });
      }
      const session = await loadSessionDetail(id);
      if (!session) throw new AppError('Session not found', 404);
      return Response.json({ session });
    }
  }
  if (request.method === 'POST' && path === `${base}/sessions`) {
    const data = createSchema.parse(await readMobileJson(request));
    return Response.json(await insertAgentSession(data), { status: 201 });
  }
  if (request.method === 'POST' && path === `${base}/handoffs`) {
    const data = handoffSchema.parse(await readMobileJson(request));
    return Response.json(
      await createMobileHandoff(request, authentication.session, data.appId),
    );
  }
  throw new AppError('Not found', 404);
}

export async function handleMobileRequest(request: Request): Promise<Response> {
  try {
    return secureResponse(await dispatch(request));
  } catch (error) {
    const status =
      error instanceof AppError
        ? error.status
        : error instanceof z.ZodError || error instanceof URIError
          ? 400
          : 500;
    return secureResponse(
      Response.json(
        {
          error:
            status >= 500
              ? 'Internal server error'
              : error instanceof AppError
                ? error.message
                : 'Bad request',
        },
        { status },
      ),
    );
  }
}
