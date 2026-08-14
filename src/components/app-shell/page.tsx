import { Box, Group, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import classes from './page.module.css';

type PageProps = {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Constrain content width for readability. Defaults to a wide column. */
  size?: number | string;
  /** Hide the standard title header for task-focused workspace modes. */
  hideHeader?: boolean;
};

export function Page({
  title,
  description,
  actions,
  children,
  size = 1180,
  hideHeader = false,
}: PageProps) {
  return (
    <Box className={classes.root} data-headerless={hideHeader || undefined}>
      <Box className={classes.inner} style={{ maxWidth: size }}>
        {hideHeader ? null : (
          <Group
            justify="space-between"
            align="flex-end"
            wrap="wrap"
            gap="md"
            className={classes.header}
          >
            <Stack gap={4} className={classes.titleBlock}>
              <Title order={2} className={classes.title}>
                {title}
              </Title>
              {description ? (
                <Text c="dimmed" size="sm" className={classes.description}>
                  {description}
                </Text>
              ) : null}
            </Stack>
            {actions ? (
              <Group gap="xs" wrap="wrap" className={classes.actions}>
                {actions}
              </Group>
            ) : null}
          </Group>
        )}
        <Box className={classes.body}>{children}</Box>
      </Box>
    </Box>
  );
}
