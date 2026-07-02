import {
  ActionIcon,
  Badge,
  Code,
  Group,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconCopy, IconWebhook } from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import { toast } from 'sonner';
import type { AppOps } from '~server/apps';
import { SectionHeader } from './section-header';

/** Inbound webhook URL (with platform-auth secret when applicable). */
export function WebhookSection({ webhook }: { webhook: AppOps['webhook'] }) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  return (
    <Stack gap={6}>
      <SectionHeader
        icon={<IconWebhook size={16} stroke={1.8} />}
        title="Inbound webhook"
        meta={
          <Badge
            size="xs"
            variant="light"
            color={webhook.auth === 'platform' ? 'teal' : 'gray'}
          >
            {webhook.auth === 'platform' ? 'platform auth' : 'no platform auth'}
          </Badge>
        }
      />
      <Group gap={8} wrap="nowrap" align="center">
        <Code
          block
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 'var(--mantine-font-size-xs)',
          }}
        >
          {webhook.auth === 'platform'
            ? `${webhook.url ?? ''}?secret=${webhook.secret ?? ''}`
            : (webhook.url ?? '')}
        </Code>
        <Tooltip
          label={
            webhook.auth === 'platform' ? 'Copy URL with secret' : 'Copy URL'
          }
          withArrow
          position="left"
        >
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label="Copy webhook URL"
            onClick={() => {
              const url =
                webhook.auth === 'platform'
                  ? `${origin}${webhook.url ?? ''}?secret=${
                      webhook.secret ?? ''
                    }`
                  : `${origin}${webhook.url ?? ''}`;
              copy(url);
              toast.success('Webhook URL copied');
            }}
          >
            <IconCopy size={15} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Text size="xs" c="dimmed">
        {webhook.auth === 'platform' ? (
          <>
            POST here from external services. The platform verifies the secret,
            strips it, and forwards an HMAC-signed request to your backend at{' '}
            <Code>/__webhook</Code>.
          </>
        ) : (
          <>
            Unauthenticated passthrough: the platform forwards requests as-is to
            your backend at <Code>/__webhook</Code>. Your backend must verify
            the caller itself.
          </>
        )}
      </Text>
    </Stack>
  );
}
