import { createFileRoute } from '@tanstack/react-router';
import { handleRpcRequest } from '~server/apps/runtime-api/rpc';

export const handle = handleRpcRequest;

export const Route = createFileRoute('/api/app/$appId/rpc/$')({
  server: { handlers: { GET: handle, POST: handle } },
});
