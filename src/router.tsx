import { createRouter } from '@tanstack/react-router';
import { nprogress } from '@mantine/nprogress';
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { toast } from 'sonner';

// Import the generated route tree
import { routeTree } from './routeTree.gen';
import { AppLoading } from '~components/system/app-loading.tsx';
import { NotFoundElement } from '~components/system/not-found.tsx';

// Create a new router instance
export const getRouter = () => {
  const queryClient = new QueryClient({
    // Every failed mutation surfaces its message as an error toast, so
    // individual useMutation calls don't need (and shouldn't add) their own
    // onError toast — a local onError would run in addition and double-toast.
    // Mutations only run in the browser, so the toast call is client-only.
    mutationCache: new MutationCache({
      onError: (error) => toast.error(error.message),
    }),
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    defaultPreload: 'intent',
    defaultPendingComponent: AppLoading,
    defaultNotFoundComponent: NotFoundElement,
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });

  router.subscribe('onBeforeLoad', ({ fromLocation, pathChanged }) => {
    if (fromLocation && pathChanged) {
      nprogress.start();
    }
  });
  router.subscribe('onLoad', () => {
    nprogress.complete();
  });

  return router;
};

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
