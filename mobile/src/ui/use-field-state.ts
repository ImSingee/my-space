import { useNativeState } from '@expo/ui';
import { useEffect, useRef } from 'react';

// Native edits already update the binding. Only write external changes back;
// echoing asynchronous JS events would move the caret or overwrite newer edits.
export function useFieldState(value: string, onChange: (text: string) => void) {
  const state = useNativeState(value);
  const emitted = useRef(value);
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  useEffect(() => {
    if (emitted.current !== value) {
      emitted.current = value;
      state.set(value);
    }
  }, [value, state]);
  // The last keystrokes can still be on their way to JS when the field goes
  // away, for example when a fold moves its conversation to another screen.
  // The native text is authoritative: report it once more if it differs.
  useEffect(
    () => () => {
      const text = state.get();
      if (text !== emitted.current) {
        emitted.current = text;
        latest.current(text);
      }
    },
    [state],
  );
  return {
    value: state,
    onChangeText: (text: string) => {
      emitted.current = text;
      onChange(text);
    },
  };
}
