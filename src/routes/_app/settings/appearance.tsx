import {
  SegmentedControl,
  Stack,
  Text,
  useMantineColorScheme,
} from '@mantine/core';
import { createFileRoute } from '@tanstack/react-router';
import { SectionHead } from '~components/settings/section-head';
import classes from '../settings.module.css';

export const Route = createFileRoute('/_app/settings/appearance')({
  component: AppearanceRoute,
});

function AppearanceRoute() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();

  return (
    <>
      <SectionHead
        title="Appearance"
        description="Personalize how Hatch looks on this device."
      />
      <div className={classes.row}>
        <Stack gap={2}>
          <Text fw={600}>Theme</Text>
          <Text size="sm" c="dimmed">
            Match your system or pick a fixed appearance.
          </Text>
        </Stack>
        <SegmentedControl
          value={colorScheme}
          onChange={(v) => setColorScheme(v as 'auto' | 'light' | 'dark')}
          data={[
            { label: 'System', value: 'auto' },
            { label: 'Light', value: 'light' },
            { label: 'Dark', value: 'dark' },
          ]}
        />
      </div>
    </>
  );
}
