import { expect, test, vi } from 'vitest';

type CountReply = { count: number };
type RefreshCallback = () => void | Promise<unknown>;
type WidgetSize = { w: number; h: number; width: number; height: number };
type WidgetContext = {
  size: WidgetSize;
  onResize: (callback: (size: WidgetSize) => void) => () => void;
  onRefresh: (callback: RefreshCallback) => () => void;
};
type CounterTemplateModule = {
  mount: (element: HTMLElement, context?: WidgetContext) => () => void;
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function renderedCount(container: HTMLElement): string | null {
  return (
    container.querySelector('button')?.previousElementSibling?.textContent ??
    null
  );
}

function trackSettlement(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { isSettled: () => settled, promise };
}

test('default counter keeps cached data throughout background refreshes', async () => {
  const getCount = vi.fn<() => Promise<CountReply>>();
  const increment = vi.fn<() => Promise<CountReply>>();
  Reflect.set(globalThis, '__defaultCounterTemplateRpcClient', {
    getCount,
    increment,
  });

  getCount.mockResolvedValueOnce({ count: 1 });
  increment.mockResolvedValue({ count: 1 });

  const { mount } = (await import(
    // @ts-expect-error -- supplied by the Browser Mode Vite plugin.
    'virtual:default-counter-template'
  )) as CounterTemplateModule;

  const size = { w: 4, h: 3, width: 320, height: 220 };
  let refreshCallback: RefreshCallback | undefined;
  const context: WidgetContext = {
    size,
    onResize(callback) {
      callback(size);
      return () => {};
    },
    onRefresh(callback) {
      refreshCallback = callback;
      return () => {
        if (refreshCallback === callback) refreshCallback = undefined;
      };
    },
  };
  const container = document.createElement('div');
  container.style.cssText = 'width:320px;height:220px;overflow:auto';
  document.body.appendChild(container);
  const unmount = mount(container, context);

  const refresh = () => {
    if (!refreshCallback) throw new Error('Widget did not register onRefresh');
    return Promise.resolve(refreshCallback());
  };

  try {
    await vi.waitFor(() => {
      expect(getCount).toHaveBeenCalledTimes(1);
      expect(renderedCount(container)).toBe('1');
      expect(refreshCallback).toBeTypeOf('function');
      expect(container.clientHeight).toBe(220);
      expect(container.scrollHeight).toBe(container.clientHeight);
    });

    const successfulRequest = deferred<CountReply>();
    getCount.mockImplementationOnce(() => successfulRequest.promise);
    const successfulRefresh = trackSettlement(refresh());

    await vi.waitFor(() => expect(getCount).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(successfulRefresh.isSettled()).toBe(false);
    expect(renderedCount(container)).toBe('1');

    successfulRequest.resolve({ count: 2 });
    await successfulRefresh.promise;
    await vi.waitFor(() => expect(renderedCount(container)).toBe('2'));

    const failedRequest = deferred<CountReply>();
    getCount.mockRejectedValue(new Error('refresh failed'));
    getCount.mockImplementationOnce(() => failedRequest.promise);
    const failedRefresh = trackSettlement(refresh());

    await vi.waitFor(() => expect(getCount).toHaveBeenCalledTimes(3));
    await Promise.resolve();
    expect(failedRefresh.isSettled()).toBe(false);
    expect(renderedCount(container)).toBe('2');

    vi.useFakeTimers();
    failedRequest.reject(new Error('refresh failed'));
    await vi.runAllTimersAsync();
    await failedRefresh.promise;
    vi.useRealTimers();
    expect(renderedCount(container)).toBe('2');
  } finally {
    vi.useRealTimers();
    unmount();
    container.remove();
    Reflect.deleteProperty(globalThis, '__defaultCounterTemplateRpcClient');
  }
});
