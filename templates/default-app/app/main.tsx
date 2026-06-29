import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { IconPlus } from '@tabler/icons-react';
import { z } from 'zod';
import { CounterService } from '../gen/service_pb';

declare const __RPC_BASE_URL__: string;
declare const __APP_NAME__: string;

const client = createClient(
  CounterService,
  createConnectTransport({ baseUrl: __RPC_BASE_URL__ }),
);

// Validate RPC responses at the edge so the UI fails loudly on shape drift.
const countSchema = z.object({ count: z.number().int() });

const queryKey = ['count'] as const;

function Home() {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery({
    queryKey,
    queryFn: async () => countSchema.parse(await client.getCount({})).count,
  });
  const increment = useMutation({
    mutationFn: async () =>
      countSchema.parse(await client.increment({ amount: 1 })).count,
    onSuccess: (next) => queryClient.setQueryData(queryKey, next),
  });

  return (
    <div className="card">
      <div className="muted">Persistent counter</div>
      <div className="count">{isPending ? '—' : data}</div>
      <button
        type="button"
        disabled={isPending || increment.isPending}
        onClick={() => increment.mutate()}
      >
        <IconPlus size={16} />
        Increment
      </button>
    </div>
  );
}

function About() {
  return (
    <div className="card">
      <h1>About</h1>
      <p className="muted">
        Scaffolded by Hatch: a React SPA (TanStack Router hash history +
        TanStack Query), a Deno Connect backend, and its own Postgres database.
        Add npm packages to package.json and import them from anywhere.
      </p>
    </div>
  );
}

const rootRoute = createRootRoute({
  component: () => (
    <div className="app">
      <h1>{__APP_NAME__}</h1>
      <nav>
        <Link
          to="/"
          activeOptions={{ exact: true }}
          activeProps={{ className: 'active' }}
        >
          Home
        </Link>
        <Link to="/about" activeProps={{ className: 'active' }}>
          About
        </Link>
      </nav>
      <Outlet />
    </div>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Home,
});

const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/about',
  component: About,
});

const routeTree = rootRoute.addChildren([indexRoute, aboutRoute]);

// Hash history keeps routing entirely client-side, which is required for apps
// served from a static iframe under /app/<id>/ with no server-side router.
const router = createRouter({ routeTree, history: createHashHistory() });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
