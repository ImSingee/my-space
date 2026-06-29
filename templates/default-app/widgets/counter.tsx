import { StrictMode, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { z } from 'zod';
import { CounterService } from '../gen/service_pb';

declare const __RPC_BASE_URL__: string;

const client = createClient(
  CounterService,
  createConnectTransport({ baseUrl: __RPC_BASE_URL__ }),
);

const countSchema = z.object({ count: z.number().int() });
const queryKey = ['count'] as const;

const styles: Record<string, CSSProperties> = {
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: '100%',
    padding: 16,
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  },
  count: { fontSize: 40, fontWeight: 700, letterSpacing: '-0.02em' },
  label: { fontSize: 12, color: 'var(--mantine-color-dimmed, #888)' },
  button: {
    border: 'none',
    borderRadius: 8,
    background: '#7c3aed',
    color: 'white',
    fontSize: 13,
    fontWeight: 600,
    padding: '6px 14px',
    cursor: 'pointer',
  },
};

function CounterWidget() {
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
    <div style={styles.card}>
      <span style={styles.label}>Counter</span>
      <span style={styles.count}>{isPending ? '—' : data}</span>
      <button
        type="button"
        style={styles.button}
        disabled={isPending || increment.isPending}
        onClick={() => increment.mutate()}
      >
        Increment
      </button>
    </div>
  );
}

/** Mount entry used by the platform dashboard. Returns an unmount function. */
export function mount(element: HTMLElement): () => void {
  const queryClient = new QueryClient();
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <CounterWidget />
      </QueryClientProvider>
    </StrictMode>,
  );
  return () => {
    root.unmount();
    queryClient.clear();
  };
}
