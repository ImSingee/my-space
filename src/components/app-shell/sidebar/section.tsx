import { ActionIcon, Box, Group, Menu, Text, Tooltip } from '@mantine/core';
import { Link, useRouterState } from '@tanstack/react-router';
import {
  IconDots,
  IconPencil,
  IconPinnedOff,
  IconPlus,
  IconSettings,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import classes from './sidebar.module.css';

/** Matches the current route against a sidebar link target (prefix-aware). */
export function useIsActive() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (to: string) => pathname === to || pathname.startsWith(`${to}/`);
}

function addButtonClass(alwaysVisible: boolean) {
  // Empty sections keep their call to action visible without hovering.
  return alwaysVisible
    ? `${classes.actionButton} ${classes.actionButtonStatic}`
    : classes.actionButton;
}

/**
 * The section-header "+" button that opens a dropdown (pin an existing item /
 * create a new one). Revealed on hover unless `alwaysVisible`.
 */
export function AddMenuButton({
  label,
  alwaysVisible,
  children,
}: {
  label: string;
  alwaysVisible: boolean;
  /** Dropdown content (`Menu.Item`s / `Menu.Label`s). */
  children: ReactNode;
}) {
  return (
    <Menu position="right-start" withArrow shadow="md" width={240}>
      <Menu.Target>
        <ActionIcon
          className={addButtonClass(alwaysVisible)}
          variant="subtle"
          color="gray"
          size="xs"
          radius="sm"
          aria-label={label}
        >
          <IconPlus size={14} stroke={1.8} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>{children}</Menu.Dropdown>
    </Menu>
  );
}

/**
 * The section-header "+" button variant that triggers a single action directly
 * (used when there is nothing to pin yet).
 */
export function AddActionButton({
  label,
  alwaysVisible,
  loading,
  onClick,
}: {
  label: string;
  alwaysVisible: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={label} position="top" withArrow>
      <ActionIcon
        className={addButtonClass(alwaysVisible)}
        variant="subtle"
        color="gray"
        size="xs"
        radius="sm"
        aria-label={label}
        loading={loading}
        onClick={onClick}
      >
        <IconPlus size={14} stroke={1.8} />
      </ActionIcon>
    </Tooltip>
  );
}

/** Small dimmed section header used to label sidebar groups. */
export function SectionHeading({
  label,
  addControl,
  manageTo,
  manageLabel,
}: {
  label: string;
  addControl?: ReactNode;
  manageTo?: string;
  manageLabel?: string;
}) {
  return (
    <Group
      className={classes.sectionHeader}
      justify="space-between"
      wrap="nowrap"
      px="sm"
      mt="md"
      mb={4}
      gap={4}
    >
      <Text className={classes.sectionLabel}>{label}</Text>
      {addControl || manageTo ? (
        <Group gap={2} wrap="nowrap">
          {addControl}
          {manageTo ? (
            <Tooltip label={manageLabel} position="top" withArrow>
              <ActionIcon
                className={classes.actionButton}
                component={Link}
                to={manageTo}
                variant="subtle"
                color="gray"
                size="xs"
                radius="sm"
                aria-label={manageLabel}
              >
                <IconSettings size={14} stroke={1.7} />
              </ActionIcon>
            </Tooltip>
          ) : null}
        </Group>
      ) : null}
    </Group>
  );
}

/**
 * A pinned sidebar row: a full-width link with a kebab menu (revealed on hover)
 * exposing Rename (when `onRename` is given) / Unpin. The menu lives as an
 * absolutely-positioned sibling of the link so clicking it never triggers
 * navigation.
 */
export function PinnedRow({
  children,
  onRename,
  onUnpin,
  renameLabel = 'Rename',
}: {
  children: ReactNode;
  onRename?: () => void;
  onUnpin: () => void;
  /** Label for the first (edit) menu item; defaults to "Rename". */
  renameLabel?: string;
}) {
  return (
    <Box className={classes.item}>
      {children}
      <Box className={classes.itemActionWrap}>
        <Menu position="bottom-end" withArrow shadow="md" width={160}>
          <Menu.Target>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              radius="sm"
              className={classes.itemAction}
              aria-label="Options"
            >
              <IconDots size={15} stroke={1.7} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {onRename ? (
              <Menu.Item
                leftSection={<IconPencil size={15} stroke={1.7} />}
                onClick={onRename}
              >
                {renameLabel}
              </Menu.Item>
            ) : null}
            <Menu.Item
              leftSection={<IconPinnedOff size={15} stroke={1.7} />}
              onClick={onUnpin}
            >
              Unpin
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Box>
    </Box>
  );
}
