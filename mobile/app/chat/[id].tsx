import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Conversation } from '../../src/screens/conversation';
import {
  conversationSplit,
  fromConversationList,
  useShowsConversation,
} from '../../src/state/use-agent-selection';
import { useFoldSplit } from '../../src/ui/columns';

/**
 * Returns to the list only with room to spare: this screen's bars and the
 * list's take slightly different side insets, and near the threshold the two
 * must never disagree and bounce the conversation back and forth.
 */
const returnSplit = {
  ...conversationSplit,
  minColumn: conversationSplit.minColumn + 24,
};

export default function ChatScreen() {
  const { id, from } = useLocalSearchParams<{ id: string; from?: string }>();
  const focused = useIsFocused();
  useShowsConversation(id);
  // Opened from the conversation list on a compact width: once the list and
  // this conversation fit side by side again, the list shows it beside itself.
  const { ref, onLayout, split } = useFoldSplit(returnSplit);
  const returns = from === fromConversationList && Boolean(split);
  useEffect(() => {
    if (returns && focused && router.canGoBack()) router.back();
  }, [returns, focused]);
  return (
    // Measured inside the side insets, as the list measures its own layout.
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1 }}>
      <View ref={ref} onLayout={onLayout} style={{ flex: 1 }}>
        <Conversation key={id} id={id} />
      </View>
    </SafeAreaView>
  );
}
