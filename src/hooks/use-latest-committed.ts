import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Keeps the value from the latest committed render available to asynchronous
 * callbacks without reading or mutating a ref during render.
 */
export function useLatestCommitted<T>(value: T) {
  const valueRef = useRef(value);

  useLayoutEffect(() => {
    valueRef.current = value;
  }, [value]);

  return valueRef;
}

/**
 * Returns a stable callback that delegates to the implementation from the
 * latest committed render.
 */
export function useEventCallback<TArguments extends unknown[], TResult>(
  callback: (...arguments_: TArguments) => TResult,
): (...arguments_: TArguments) => TResult {
  const callbackRef = useLatestCommitted(callback);

  return useCallback(
    (...arguments_: TArguments) => callbackRef.current(...arguments_),
    [callbackRef],
  );
}
