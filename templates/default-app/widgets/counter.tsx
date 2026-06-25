import { StrictMode, useEffect, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { CounterService } from '../gen/service_pb';

declare const __RPC_BASE_URL__: string;

const client = createClient(
  CounterService,
  createConnectTransport({ baseUrl: __RPC_BASE_URL__ }),
);

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
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    client.getCount({}).then((r) => setCount(r.count));
  }, []);

  const increment = async () => {
    setBusy(true);
    try {
      const r = await client.increment({ amount: 1 });
      setCount(r.count);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.card}>
      <span style={styles.label}>Counter</span>
      <span style={styles.count}>{count ?? '—'}</span>
      <button
        type="button"
        style={styles.button}
        disabled={busy}
        onClick={increment}
      >
        Increment
      </button>
    </div>
  );
}

/** Mount entry used by the platform dashboard. Returns an unmount function. */
export function mount(element: HTMLElement): () => void {
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <CounterWidget />
    </StrictMode>,
  );
  return () => root.unmount();
}
