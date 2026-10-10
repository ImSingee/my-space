import { createFileRoute } from '@tanstack/react-router';
import { handleWebhookRequest as handle } from '~server/apps/runtime-api/hook';
export { handle };
export const Route = createFileRoute('/api/app/$appId/hook/$')({
  server: {
    // Register every HTTP verb TanStack Start supports so the passthrough is as
    // verb-agnostic as the platform allows — webhook providers send preflights
    // (OPTIONS), liveness probes (HEAD), and non-CRUD methods (PATCH), not just
    // GET/POST/PUT/DELETE.
    handlers: {
      GET: handle,
      POST: handle,
      PUT: handle,
      PATCH: handle,
      DELETE: handle,
      HEAD: handle,
      OPTIONS: handle,
    },
  },
});
