import { Stack, Text, Title, VisuallyHidden } from '@mantine/core';
import { useEffect, useRef, type ReactNode } from 'react';
import { Brand } from '~components/app-shell/brand';
import { USER_CODE_LENGTH } from './device-api';
import classes from './device-approval.module.css';

export function DeviceLayout({ children }: { children: ReactNode }) {
  return (
    <div className={classes.root}>
      <main className={classes.column}>
        <Brand size="lg" withWordmark={false} />
        {children}
      </main>
    </div>
  );
}

/**
 * Page title for one step. When a step replaces another, focus moves to its
 * title so keyboard and screen reader users start at the new content.
 */
export function ViewHeader({
  title,
  focus = false,
  children,
}: {
  title: ReactNode;
  focus?: boolean;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  return (
    <Stack gap={8} align="center" className={classes.header}>
      <Title ref={ref} order={1} size="h2" tabIndex={-1} ta="center">
        {title}
      </Title>
      {children ? (
        <Text c="dimmed" ta="center" className={classes.lead}>
          {children}
        </Text>
      ) : null}
    </Stack>
  );
}

/** The user code as the device prints it, spelled out for screen readers. */
export function DeviceCode({ code }: { code: string }) {
  const half = USER_CODE_LENGTH / 2;
  return (
    <p className={classes.code}>
      <VisuallyHidden>{code.split('').join(' ')}</VisuallyHidden>
      <span aria-hidden>{code.slice(0, half)}</span>
      <span aria-hidden className={classes.codeDash}>
        -
      </span>
      <span aria-hidden>{code.slice(half)}</span>
    </p>
  );
}
