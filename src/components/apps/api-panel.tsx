import {
  ActionIcon,
  Badge,
  Box,
  Center,
  Code,
  Collapse,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { IconChevronRight, IconCopy } from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import { toast } from 'sonner';
import type { ProtoFile, RpcServiceApi } from '~server/apps/manifest';
import { normalizedManifestQueryOptions } from '~queries/apps';

/** Local-name of a fully-qualified proto type (drops the package prefix). */
function shortType(fqName: string): string {
  const i = fqName.lastIndexOf('.');
  return i === -1 ? fqName : fqName.slice(i + 1);
}

function MethodRow({ method }: { method: RpcServiceApi['methods'][number] }) {
  return (
    <Table.Tr>
      <Table.Td>
        <Text size="sm" fw={500} ff="monospace">
          {method.name}
        </Text>
      </Table.Td>
      <Table.Td>
        <Group gap={6} wrap="nowrap" align="center">
          {method.clientStreaming ? (
            <Badge size="xs" variant="light" color="grape">
              stream
            </Badge>
          ) : null}
          <Tooltip label={method.inputType} withArrow position="top">
            <Text size="xs" c="dimmed" ff="monospace" truncate>
              {shortType(method.inputType)}
            </Text>
          </Tooltip>
          <Text size="xs" c="dimmed">
            →
          </Text>
          {method.serverStreaming ? (
            <Badge size="xs" variant="light" color="grape">
              stream
            </Badge>
          ) : null}
          <Tooltip label={method.outputType} withArrow position="top">
            <Text size="xs" c="dimmed" ff="monospace" truncate>
              {shortType(method.outputType)}
            </Text>
          </Tooltip>
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

function ServiceBlock({ service }: { service: RpcServiceApi }) {
  return (
    <Stack gap={6}>
      <Group gap={8} wrap="nowrap" align="baseline">
        <Text fw={600} size="sm" ff="monospace">
          {service.name}
        </Text>
        <Text size="xs" c="dimmed">
          {service.methods.length} method
          {service.methods.length === 1 ? '' : 's'}
        </Text>
      </Group>
      {service.methods.length === 0 ? (
        <Text size="xs" c="dimmed">
          No methods defined.
        </Text>
      ) : (
        <Table withTableBorder verticalSpacing={6} highlightOnHover>
          <Table.Tbody>
            {service.methods.map((m) => (
              <MethodRow key={m.name} method={m} />
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

function ProtoSource({ file }: { file: ProtoFile }) {
  const [opened, { toggle }] = useDisclosure(false);
  return (
    <Stack gap={4}>
      <Group gap={6} wrap="nowrap" align="center">
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          onClick={toggle}
          aria-label={opened ? `Hide ${file.path}` : `Show ${file.path}`}
        >
          <IconChevronRight
            size={15}
            style={{
              transform: opened ? 'rotate(90deg)' : 'none',
              transition: 'transform 120ms ease',
            }}
          />
        </ActionIcon>
        <Text
          size="xs"
          ff="monospace"
          c="dimmed"
          style={{ cursor: 'pointer' }}
          onClick={toggle}
        >
          {file.path}
        </Text>
        <Tooltip label="Copy proto" withArrow position="top">
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={`Copy ${file.path}`}
            onClick={() => {
              copy(file.content);
              toast.success('Proto copied');
            }}
          >
            <IconCopy size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Collapse expanded={opened}>
        <Code
          block
          style={{ fontSize: 'var(--mantine-font-size-xs)', whiteSpace: 'pre' }}
        >
          {file.content}
        </Code>
      </Collapse>
    </Stack>
  );
}

/**
 * Shows the RPC API the app declares via its proto: every service + method, plus
 * the raw `.proto` sources captured at deploy time. Self-hides for apps that
 * don't expose an RPC service.
 */
export function ApiPanel({ appId }: { appId: string }) {
  const query = useQuery(normalizedManifestQueryOptions(appId));

  if (query.isLoading) {
    return (
      <Box component="section">
        <Text fw={600} fz="lg" mb="md">
          API
        </Text>
        <Center py="lg">
          <Loader size="sm" />
        </Center>
      </Box>
    );
  }

  const api = query.data?.api;

  return (
    <Box component="section">
      <Text fw={600} fz="lg" mb="md">
        API
      </Text>
      {!query.data ? (
        <Text size="sm" c="dimmed">
          Deploy this app to capture its declared API.
        </Text>
      ) : !api || api.services.length === 0 ? (
        <Text size="sm" c="dimmed">
          No RPC services declared in the proto.
        </Text>
      ) : (
        <Stack gap="lg">
          <Text size="sm" c="dimmed">
            Connect RPC services this app exposes, captured from its proto on
            deploy.
          </Text>
          {api.services.map((service) => (
            <ServiceBlock key={service.name} service={service} />
          ))}
          {api.protoFiles.length > 0 ? (
            <Stack gap={6}>
              <Text fw={600} size="sm">
                Proto source
              </Text>
              {api.protoFiles.map((file) => (
                <ProtoSource key={file.path} file={file} />
              ))}
            </Stack>
          ) : null}
        </Stack>
      )}
    </Box>
  );
}
