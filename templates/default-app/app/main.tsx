import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { CounterService } from '../gen/service_pb';

declare const __RPC_BASE_URL__: string;
declare const __APP_NAME__: string;

const client = createClient(
  CounterService,
  createConnectTransport({ baseUrl: __RPC_BASE_URL__ }),
);

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash || '#/');
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash.replace(/^#/, '');
}

function Home() {
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
    <div className="card">
      <div className="muted">Persistent counter</div>
      <div className="count">{count ?? '—'}</div>
      <button type="button" disabled={busy} onClick={increment}>
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
        This app was scaffolded by Hatch. It has a React SPA (hash routing), a
        Deno Connect backend, and its own Postgres database.
      </p>
    </div>
  );
}

function App() {
  const route = useHashRoute();
  return (
    <div className="app">
      <h1>{__APP_NAME__}</h1>
      <nav>
        <a href="#/">Home</a>
        <a href="#/about">About</a>
      </nav>
      {route === '/about' ? <About /> : <Home />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
