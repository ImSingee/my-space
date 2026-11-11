import { useNativeState } from '@expo/ui';
import { useEffect, useRef } from 'react';

// Native edits already update the binding. Only write external changes back;
// echoing asynchronous JS events would move the caret or overwrite newer edits.
export function useFieldState(value: string, onChange: (text: string) => void) {
  const state = useNativeState(value);
  const emitted = useRef(value);
  useEffect(() => {
    if (emitted.current !== value) {
      emitted.current = value;
      state.set(value);
    }
  }, [value, state]);
  return {
    value: state,
    onChangeText: (text: string) => {
      emitted.current = text;
      onChange(text);
    },
  };
}
