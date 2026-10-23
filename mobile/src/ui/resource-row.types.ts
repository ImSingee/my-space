export type ResourceRowProps = {
  title: string;
  detail: string;
  kind: 'app' | 'conversation' | 'workflow' | 'dashboard' | 'settings';
  onPress: () => void;
};
