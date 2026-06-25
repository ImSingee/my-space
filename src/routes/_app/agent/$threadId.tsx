import { createFileRoute } from '@tanstack/react-router';
import { Chat } from '~components/agent/chat';
import { sessionQueryOptions } from '~queries/agent';

export const Route = createFileRoute('/_app/agent/$threadId')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(
      sessionQueryOptions(params.threadId),
    );
  },
  component: AgentThread,
});

function AgentThread() {
  const { threadId } = Route.useParams();
  return <Chat key={threadId} sessionId={threadId} />;
}
