import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { NewChat } from '~components/agent/new-chat';

export const Route = createFileRoute('/_app/agent/')({
  validateSearch: (search): { prompt?: string } => ({
    prompt: typeof search.prompt === 'string' ? search.prompt : undefined,
  }),
  component: AgentIndex,
});

function AgentIndex() {
  const { prompt } = Route.useSearch();
  const navigate = useNavigate();

  return (
    <NewChat
      initialPrompt={prompt}
      onStart={(id) => {
        void navigate({ to: '/agent/$threadId', params: { threadId: id } });
      }}
    />
  );
}
