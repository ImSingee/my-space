import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AgentRunnerPanel } from '~components/settings/agent-runner-panel';
import { SectionHead } from '~components/settings/section-head';
import { agentRunnerStatusQueryOptions } from '~queries/agent';

export const Route = createFileRoute('/_app/settings/agent-runner')({
  // Warm the cache without blocking navigation: the panel owns its own
  // skeleton and error states, so a slow or failing status probe must not
  // keep the whole settings page from opening.
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(agentRunnerStatusQueryOptions);
  },
  component: AgentRunnerRoute,
});

function AgentRunnerRoute() {
  const query = useQuery(agentRunnerStatusQueryOptions);
  return (
    <>
      <SectionHead
        title="Agent Runner"
        description="Whether the Agent Runner service is online, which runners are connected, and the agent runs they are carrying. Refreshes every 5 seconds while open."
      />
      <AgentRunnerPanel
        snapshot={query.data}
        isLoading={query.isPending}
        error={query.error}
        onRefresh={() => query.refetch()}
      />
    </>
  );
}
