# Frontend and widgets

Read this reference when an App has a frontend or dashboard widget.

## React SPA

The platform serves `app/index.html`, which loads the bundled `./app.js`.
Use TanStack Router with hash history because the App is served inside a static
iframe. Keep every user-navigable route represented in `manifest.json` under
`app.routes`; this metadata powers entry-point discovery but does not register
routes at runtime.

Use TanStack Query for RPC/server state. Do not fetch with `useEffect` plus
`useState`. Use Zod for runtime response validation when the server response
needs an additional trust boundary.

The generated Connect client uses the injected `__RPC_BASE_URL__`:

```tsx
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { useQuery } from '@tanstack/react-query';
import { TodoService } from '../gen/service_pb.ts';

declare const __RPC_BASE_URL__: string;

const client = createClient(
  TodoService,
  createConnectTransport({ baseUrl: __RPC_BASE_URL__ }),
);

export function useTodos() {
  return useQuery({
    queryKey: ['todos'],
    queryFn: () => client.list({}),
  });
}
```

Adapt the scaffolded router and Query client rather than replacing their
platform wiring. Import packages normally after adding them to `package.json`.

## Widgets

Each widget is a standalone bundle and must export `mount(element, context)`
and return an unmount function:

```tsx
import { createRoot } from 'react-dom/client';

type WidgetSize = { w: number; h: number; width: number; height: number };
type WidgetContext = {
  size: WidgetSize;
  onResize: (callback: (size: WidgetSize) => void) => () => void;
  onRefresh: (callback: () => void | Promise<unknown>) => () => void;
};

export function mount(
  element: HTMLElement,
  context?: WidgetContext,
): () => void {
  const root = createRoot(element);
  root.render(<Widget context={context} />);
  return () => root.unmount();
}
```

Set `defaultSize` to an integer `w`/`h` footprint from 1 through 12. Build a
responsive widget by default and omit `supportedSizes`; use `context.size` and
`context.onResize` to adapt to grid and pixel dimensions. Declare
`supportedSizes` only after implementing and verifying every listed footprint.

Register `context.onRefresh` only when the widget performs real refresh work.
Return the actual refresh Promise so the dashboard spinner tracks completion.
For TanStack Query, return `invalidateQueries`/`refetchQueries`; use
`Promise.all` for multiple independent queries.

Treat initial load and background refresh differently:

- Before any successful data, show a loading state; an error may replace it
  with an error plus Retry action.
- After data has loaded, keep it visible throughout refresh. Replace it only
  after a successful request.
- On refresh failure, retain the previous data and use a non-destructive error
  indicator.
- Do not add a routine refresh button inside the widget; the dashboard provides
  it when `onRefresh` is registered.

Widgets may use the same Connect client or managed Data Table client as the SPA.
