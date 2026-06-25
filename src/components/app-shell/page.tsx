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
};

export function Page({
  title,
  description,
  actions,
  children,
  size = 1180,
}: PageProps) {
  return (
    <Box className={classes.root}>
      <Box className={classes.inner} style={{ maxWidth: size }}>
        <Group justify="space-between" align="flex-end" wrap="nowrap" gap="md">
          <Stack gap={2} className={classes.titleBlock}>
            <Title order={2} fw={650} className={classes.title}>
              {title}
            </Title>
            {description ? (
              <Text c="dimmed" size="sm">
                {description}
              </Text>
            ) : null}
          </Stack>
          {actions ? <Group gap="xs">{actions}</Group> : null}
        </Group>
        <Box className={classes.body}>{children}</Box>
      </Box>
    </Box>
  );
}
