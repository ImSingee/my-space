/** Persisted chat messages: user bubbles, assistant blocks, tool timelines. */
import {
  ActionIcon,
  Box,
  Button,
  Group,
  Image,
  Menu,
  Paper,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import {
  IconDownload,
  IconExternalLink,
  IconFile,
  IconDots,
  IconSettings,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { AppGlyph } from '~components/apps/app-glyph';
import { formatBytes } from '~lib/format';
import type { AppListItem } from '~server/apps';
import { AgentErrorNotice } from './agent-error-notice';
import { Markdownish } from './markdownish';
import { ThinkingStep, ToolStep } from './steps';
import {
  type AssistantBlock,
  type ChatMessage,
  type ToolResultMessage,
  partsToImages,
  partsToText,
  successfullyDeployedAppIds,
  toolDetail,
} from './types';
import classes from './chat.module.css';

type ToolResultMap = Map<string, ToolResultMessage>;

type DeployedApp = {
  reference: string;
  app?: AppListItem;
};

/** Resolve id/slug handles and deduplicate aliases by the canonical app id. */
export function resolveDeployedApps(
  references: string[],
  apps: AppListItem[],
): DeployedApp[] {
  const seen = new Set<string>();
  const resolved: DeployedApp[] = [];
  for (const reference of references) {
    const app = apps.find(
      (candidate) => candidate.id === reference || candidate.slug === reference,
    );
    const key = app?.id ?? `missing:${reference}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ reference, ...(app ? { app } : {}) });
  }
  return resolved;
}

function AppActions({
  ids,
  apps,
}: {
  ids: string[];
  apps: AppListItem[] | undefined;
}) {
  if (!apps) return null;
  const deployedApps = resolveDeployedApps(ids, apps);
  if (deployedApps.length === 0) return null;
  const plural = deployedApps.length > 1;

  return (
    <Box
      component="section"
      className={classes.appActions}
      aria-label={plural ? 'Deployed apps' : 'Deployed app'}
    >
      <Text className={classes.appActionsTitle}>
        {plural ? `Deployed apps · ${deployedApps.length}` : 'Deployed app'}
      </Text>
      <Box className={classes.appActionRows}>
        {deployedApps.map(({ reference, app }) => {
          const name = app?.name ?? reference;
          const canOpen =
            app?.status === 'deployed' && Boolean(app.capabilities?.frontend);
          return (
            <Group
              key={app?.id ?? reference}
              className={classes.appActionRow}
              wrap="nowrap"
            >
              <AppGlyph name={name} seed={app?.id ?? reference} size="sm" />
              <Box className={classes.appActionIdentity}>
                <Text size="sm" fw={600} truncate>
                  {name}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                  {app ? app.slug : 'No longer available'}
                </Text>
              </Box>
              {app ? (
                <Group gap={4} wrap="nowrap" className={classes.appActionCtas}>
                  {canOpen ? (
                    <Button
                      size="compact-sm"
                      variant="light"
                      color="ember"
                      leftSection={<IconExternalLink size={14} stroke={1.8} />}
                      renderRoot={(props) => (
                        <Link
                          to="/apps/$appId"
                          params={{ appId: app.id }}
                          {...props}
                        />
                      )}
                    >
                      Open
                    </Button>
                  ) : (
                    <Button
                      size="compact-sm"
                      variant="default"
                      leftSection={<IconSettings size={14} stroke={1.8} />}
                      renderRoot={(props) => (
                        <Link
                          to="/apps/$appId/manage"
                          params={{ appId: app.id }}
                          {...props}
                        />
                      )}
                    >
                      Manage
                    </Button>
                  )}
                  {canOpen ? (
                    <Menu position="bottom-end" withinPortal>
                      <Menu.Target>
                        <Tooltip label={`Manage ${name}`} withArrow>
                          <ActionIcon
                            variant="subtle"
                            color="gray"
                            size="sm"
                            aria-label={`More actions for ${name}`}
                          >
                            <IconDots size={16} stroke={1.8} />
                          </ActionIcon>
                        </Tooltip>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          leftSection={<IconSettings size={15} stroke={1.7} />}
                          renderRoot={(props) => (
                            <Link
                              to="/apps/$appId/manage"
                              params={{ appId: app.id }}
                              {...props}
                            />
                          )}
                        >
                          Manage app
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  ) : null}
                </Group>
              ) : (
                <Text size="xs" c="dimmed" className={classes.unavailableApp}>
                  Unavailable
                </Text>
              )}
            </Group>
          );
        })}
      </Box>
    </Box>
  );
}

/**
 * Render assistant blocks, grouping consecutive thinking/tool steps into one
 * connected timeline and keeping prose as clean standalone markdown.
 */
function AssistantBlocks({
  blocks,
  toolResults,
}: {
  blocks: AssistantBlock[];
  toolResults?: ToolResultMap;
}) {
  const out: ReactNode[] = [];
  let steps: ReactNode[] = [];

  const flush = () => {
    if (steps.length === 0) return;
    out.push(
      <Box key={`steps-${out.length}`} className={classes.steps}>
        {steps}
      </Box>,
    );
    steps = [];
  };

  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      flush();
      out.push(<Markdownish key={index} text={block.text} />);
    } else if (block.type === 'thinking') {
      steps.push(<ThinkingStep key={index} text={block.thinking} />);
    } else {
      const result = toolResults?.get(block.id);
      steps.push(
        <ToolStep
          key={index}
          name={block.name}
          detail={toolDetail(block.name, block.arguments)}
          status="done"
          result={
            result
              ? {
                  text: partsToText(result.content),
                  details: result.details,
                  isError: result.isError,
                }
              : undefined
          }
        />,
      );
    }
  });
  flush();

  return <>{out}</>;
}

export function MessageView({
  message,
  toolResults,
  onRetry,
  retrying = false,
  retryDisabled = false,
  apps,
}: {
  message: ChatMessage;
  toolResults?: ToolResultMap;
  onRetry?: () => void;
  retrying?: boolean;
  retryDisabled?: boolean;
  apps?: AppListItem[];
}) {
  if (message.role === 'user') {
    const text = partsToText(message.content, message.attachments);
    const images = partsToImages(message.content);
    const files = message.attachments ?? [];
    return (
      <Box className={classes.userRow}>
        <Stack gap={6} align="flex-end" maw="80%">
          {images.length > 0 ? (
            <Group gap={6} justify="flex-end" wrap="wrap">
              {images.map((src, i) => (
                <Image
                  key={i}
                  src={src}
                  alt="Attached image"
                  radius="md"
                  w="auto"
                  mah={260}
                  className={classes.messageImage}
                />
              ))}
            </Group>
          ) : null}
          {files.length > 0 ? (
            <Box className={classes.messageFiles}>
              {files.map((file) => (
                <Box
                  component="a"
                  key={file.id}
                  href={`/api/agent/attachments/${encodeURIComponent(file.id)}`}
                  download={file.name}
                  className={classes.messageFile}
                  title={`${file.name} (${formatBytes(file.size)})`}
                >
                  <IconFile size={16} stroke={1.7} />
                  <Text size="xs" className={classes.messageFileName}>
                    {file.name}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {formatBytes(file.size)}
                  </Text>
                  <IconDownload size={14} stroke={1.7} />
                </Box>
              ))}
            </Box>
          ) : null}
          {text ? (
            <Paper className={classes.userBubble} radius="md" px="sm" py={6}>
              <Text className={classes.messageText}>{text}</Text>
            </Paper>
          ) : null}
        </Stack>
      </Box>
    );
  }

  // Standalone tool results are normally merged into their call above; this is
  // a fallback for any result we could not pair.
  if (message.role === 'toolResult') {
    return (
      <Box className={classes.steps}>
        <ToolStep
          name={message.toolName}
          status={message.isError ? 'error' : 'done'}
          result={{
            text: partsToText(message.content),
            details: message.details,
            isError: message.isError,
          }}
        />
      </Box>
    );
  }

  return (
    <Box className={classes.assistantRow}>
      <AssistantBlocks blocks={message.content} toolResults={toolResults} />
      <AppActions
        ids={successfullyDeployedAppIds(message.content, toolResults)}
        apps={apps}
      />
      {message.stopReason === 'error' ? (
        <AgentErrorNotice
          message={message.errorMessage}
          onRetry={onRetry}
          retrying={retrying}
          retryDisabled={retryDisabled}
        />
      ) : null}
    </Box>
  );
}
