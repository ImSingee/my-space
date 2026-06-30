import { StrictMode, type CSSProperties, useEffect, useState } from 'react';
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

/** Size the dashboard hands a widget: grid units (w/h) + live pixel size. */
type WidgetSize = { w: number; h: number; width: number; height: number };
/** Second argument the platform passes to `mount` (optional for portability). */
type WidgetContext = {
  size: WidgetSize;
  onResize: (cb: (size: WidgetSize) => void) => () => void;
  /** Runs when the user refreshes this widget (or the whole dashboard). */
  onRefresh: (cb: () => void) => () => void;
};

/** Track the widget's current size. `onResize` fires immediately, then on every
 * resize/placement change — a subscription, not data fetching. */
function useWidgetSize(context?: WidgetContext): WidgetSize | null {
  const [size, setSize] = useState<WidgetSize | null>(
    () => context?.size ?? null,
  );
  useEffect(() => context?.onResize(setSize), [context]);
  return size;
}

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

function CounterWidget({ context }: { context?: WidgetContext }) {
  const queryClient = useQueryClient();
  const size = useWidgetSize(context);
  const { data, isPending } = useQuery({
    queryKey,
    queryFn: async () => countSchema.parse(await client.getCount({})).count,
  });
  const increment = useMutation({
    mutationFn: async () =>
      countSchema.parse(await client.increment({ amount: 1 })).count,
    onSuccess: (next) => queryClient.setQueryData(queryKey, next),
  });

  // Refetch the count when the platform requests a refresh (per-widget refresh
  // button or the dashboard's "Refresh all"). A no-op subscription when the
  // host doesn't provide a context (e.g. standalone rendering).
  useEffect(
    () =>
      context?.onRefresh(() => {
        void queryClient.invalidateQueries({ queryKey });
      }),
    [context, queryClient],
  );

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
      {size ? (
        <span style={styles.label}>
          {size.w}×{size.h} · {size.width}×{size.height}px
        </span>
      ) : null}
    </div>
  );
}

/** Mount entry used by the platform dashboard. The platform passes a `context`
 * with the widget's current size and an `onResize` subscription. Returns an
 * unmount function. */
export function mount(
  element: HTMLElement,
  context?: WidgetContext,
): () => void {
  const queryClient = new QueryClient();
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <CounterWidget context={context} />
      </QueryClientProvider>
    </StrictMode>,
  );
  return () => {
    root.unmount();
    queryClient.clear();
  };
}
