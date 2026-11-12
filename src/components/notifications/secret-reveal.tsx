import {
  ActionIcon,
  Alert,
  Code,
  Group,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconAlertTriangle, IconCopy } from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import { toast } from 'sonner';

/** A copyable value, e.g. a URL or command. */
export function CopyableCode({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Group gap={8} wrap="nowrap" align="flex-start">
        <Code
          block
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 'var(--mantine-font-size-xs)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {value}
        </Code>
        <Tooltip label="Copy" withArrow position="left">
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={`Copy ${label.toLowerCase()}`}
            onClick={() => {
              copy(value, { format: 'text/plain' });
              toast.success('Copied');
            }}
          >
            <IconCopy size={16} stroke={1.6} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Stack>
  );
}

/** A credential that is shown exactly once, with a reminder to store it. */
export function SecretReveal({
  label,
  secret,
}: {
  label: string;
  secret: string;
}) {
  return (
    <Stack gap="sm">
      <Alert
        color="yellow"
        variant="light"
        icon={<IconAlertTriangle size={18} stroke={1.6} />}
      >
        Copy it now. Hatch stores only what it needs to verify or sign requests
        and will not show this {label.toLowerCase()} again.
      </Alert>
      <CopyableCode label={label} value={secret} />
    </Stack>
  );
}
