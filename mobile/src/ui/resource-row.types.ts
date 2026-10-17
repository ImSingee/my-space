export type ResourceRowProps = {
  title: string;
  detail: string;
  kind: 'app' | 'conversation';
  onPress: () => void;
};
