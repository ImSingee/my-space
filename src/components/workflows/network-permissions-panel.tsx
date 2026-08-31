import { Box, Center, Loader, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { NetworkAccessDetails } from '~components/system/network-access';
import { workflowOpsQueryOptions } from '~queries/workflows';

export function WorkflowNetworkPermissionsPanel({
  workflowId,
}: {
  workflowId: string;
}) {
  const query = useQuery(workflowOpsQueryOptions(workflowId));

  return (
    <Box component="section">
      <Text fw={600} fz="lg" mb="md">
        Permissions
      </Text>
      {query.isLoading ? (
        <Center py="lg">
          <Loader size="sm" />
        </Center>
      ) : query.data ? (
        <NetworkAccessDetails access={query.data.network} />
      ) : null}
    </Box>
  );
}
