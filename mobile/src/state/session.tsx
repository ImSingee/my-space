import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';
import { AppState } from 'react-native';
import { canonicalizeInstanceUrl, type HatchApiClient } from '../core';
import { createNativeClient, createNativeVault } from '../core/native';

export const allowDevelopmentLoopback = __DEV__;
export const vault = createNativeVault({ allowDevelopmentLoopback });
const RECENT_KEY = 'hatch.mobile.instances.v1';
const ACTIVE_KEY = 'hatch.mobile.active.v1';
// One process owns one active instance. Serialize storage and cache transitions.
let currentInstance: string | null = null;
let currentRevision = 0;
let transitions: Promise<unknown> = Promise.resolve();
function transition<T>(operation: () => Promise<T>): Promise<T> {
  const next = transitions.then(operation, operation);
  transitions = next.catch(() => undefined);
  return next;
}
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1 },
    mutations: { retry: false, networkMode: 'always' },
  },
});

type SessionContextValue = {
  ready: boolean;
  origin: string | null;
  origins: string[];
  api: HatchApiClient | null;
  epoch: number;
  connect: (origin: string, signal?: AbortSignal) => Promise<void>;
  disconnect: () => Promise<void>;
  authError: string | null;
};
const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: PropsWithChildren) {
  const [ready, setReady] = useState(false);
  const [origin, setOrigin] = useState<string | null>(null);
  const [origins, setOrigins] = useState<string[]>([]);
  const [epoch, setEpoch] = useState(0);
  const [authError, setAuthError] = useState<string | null>(null);
  const clear = (expectedOrigin: string, expectedRevision: number) =>
    transition(async () => {
      if (
        currentInstance !== expectedOrigin ||
        currentRevision !== expectedRevision
      )
        return;
      currentInstance = null;
      currentRevision++;
      setOrigin(null);
      setEpoch(currentRevision);
      await queryClient.cancelQueries();
      queryClient.clear();
      await SecureStore.deleteItemAsync(ACTIVE_KEY);
    });
  const api = useMemo(
    () =>
      origin
        ? createNativeClient({
            origin,
            vault,
            allowDevelopmentLoopback,
            onUnauthorized: (expiredOrigin) => {
              if (
                currentInstance !== expiredOrigin ||
                currentRevision !== epoch
              )
                return;
              setAuthError('Your session expired. Sign in again to continue.');
              void clear(expiredOrigin, epoch).catch(() =>
                setAuthError('Your session expired. Please reconnect.'),
              );
            },
          })
        : null,
    [origin, epoch],
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const raw = await SecureStore.getItemAsync(RECENT_KEY);
        const recent: unknown = raw ? JSON.parse(raw) : [];
        if (alive && Array.isArray(recent)) {
          setOrigins(
            recent
              .filter((item): item is string => typeof item === 'string')
              .slice(0, 10),
          );
        }
        const active = await SecureStore.getItemAsync(ACTIVE_KEY);
        if (active && (await vault.get(active)) && alive) {
          currentInstance = canonicalizeInstanceUrl(active, {
            allowDevelopmentLoopback,
          });
          currentRevision++;
          setEpoch(currentRevision);
          setOrigin(currentInstance);
        }
      } catch {
        if (alive)
          setAuthError('Saved sign-in could not be read. Please reconnect.');
      } finally {
        if (alive) setReady(true);
      }
    })();
    const subscription = AppState.addEventListener('change', (state) =>
      focusManager.setFocused(state === 'active'),
    );
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);

  const connect = (url: string, signal?: AbortSignal) =>
    transition(async () => {
      const next = canonicalizeInstanceUrl(url, { allowDevelopmentLoopback });
      if (signal?.aborted) return;
      if (!(await vault.get(next)))
        throw new Error('Sign in to this instance first.');
      await queryClient.cancelQueries();
      if (signal?.aborted) return;
      queryClient.clear();
      const recent = [next, ...origins.filter((item) => item !== next)].slice(
        0,
        10,
      );
      await SecureStore.setItemAsync(RECENT_KEY, JSON.stringify(recent));
      if (signal?.aborted) return;
      await SecureStore.setItemAsync(ACTIVE_KEY, next);
      if (signal?.aborted) {
        await SecureStore.deleteItemAsync(ACTIVE_KEY);
        return;
      }
      currentInstance = next;
      currentRevision++;
      setOrigins(recent);
      setAuthError(null);
      setEpoch(currentRevision);
      setOrigin(next);
    });

  const disconnect = async () => {
    const expectedOrigin = origin;
    const expectedRevision = epoch;
    const capturedToken = expectedOrigin
      ? await vault.get(expectedOrigin)
      : null;
    let failure: unknown;
    try {
      await api?.signOut();
    } catch (error) {
      failure = error;
    }
    if (expectedOrigin && currentRevision === expectedRevision) {
      if (capturedToken)
        await vault.removeIfMatch(expectedOrigin, capturedToken);
      await clear(expectedOrigin, expectedRevision);
    }
    if (failure)
      throw new Error(
        'This phone is signed out. The server could not confirm revocation. Revoke this device from Hatch account sessions when you reconnect.',
      );
  };

  return (
    <QueryClientProvider client={queryClient}>
      <SessionContext.Provider
        value={{
          ready,
          origin,
          origins,
          api,
          epoch,
          connect,
          disconnect,
          authError,
        }}
      >
        {children}
      </SessionContext.Provider>
    </QueryClientProvider>
  );
}

export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error('SessionProvider is missing.');
  return session;
}
