import { usePreventRemove } from 'expo-router';
import { stepsBackInPage } from '../core';

/**
 * While a page has history of its own, the native back button and Android's
 * back key step back inside it instead of closing the screen. The screen also
 * turns off its native edge swipe (`gestureEnabled: false`) so WKWebView's own
 * swipe takes over; one gesture never pops twice. Other removals, such as a
 * reset after sign-out, go through untouched.
 */
export function useWebHistoryBack(active: boolean, goBack: () => void) {
  usePreventRemove(active, ({ data, repeat }) => {
    if (stepsBackInPage(data.action)) goBack();
    else repeat();
  });
}
