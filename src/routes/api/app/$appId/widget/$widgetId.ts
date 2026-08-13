import { createFileRoute } from '@tanstack/react-router';
import { handleWidgetRequest } from '~server/apps/runtime-api/widget';

export const handle = handleWidgetRequest;

export const Route = createFileRoute('/api/app/$appId/widget/$widgetId')({
  server: { handlers: { GET: handle } },
});
