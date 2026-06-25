import {
  Box,
  Button,
  Card,
  Center,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Text,
  UnstyledButton,
  useMantineColorScheme,
} from '@mantine/core';
import { createFileRoute } from '@tanstack/react-router';
import { IconPalette, IconPlus, IconServer2 } from '@tabler/icons-react';
import { type ComponentType, type ReactNode, Suspense, useState } from 'react';
import { Page } from '~components/app-shell/page';
import {
  ProviderFormModal,
  ProvidersPanel,
} from '~components/settings/providers-panel';
import { providersQueryOptions } from '~queries/agent';
import classes from './settings.module.css';

export const Route = createFileRoute('/_app/settings')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(providersQueryOptions),
  component: SettingsPage,
});

type SectionId = 'providers' | 'appearance';

type IconType = ComponentType<{
  size?: number | string;
  stroke?: number;
  className?: string;
}>;

const SECTIONS: { id: SectionId; label: string; icon: IconType }[] = [
  { id: 'providers', label: 'AI Providers', icon: IconServer2 },
  { id: 'appearance', label: 'Appearance', icon: IconPalette },
];

function SettingsPage() {
  const [section, setSection] = useState<SectionId>('providers');
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <Page
      title="Settings"
      description="Manage providers, models, and how Hatch looks."
      size={1040}
    >
      <Box className={classes.layout}>
        <Box component="nav" className={classes.nav}>
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const active = section === s.id;
            return (
              <UnstyledButton
                key={s.id}
                className={active ? classes.navItemActive : classes.navItem}
                onClick={() => setSection(s.id)}
              >
                <Icon size={18} stroke={1.6} className={classes.navItemIcon} />
                {s.label}
              </UnstyledButton>
            );
          })}
        </Box>

        <Box className={classes.section}>
          {section === 'providers' ? (
            <ProvidersSection onAdd={() => setCreateOpen(true)} />
          ) : (
            <AppearanceSection />
          )}
        </Box>
      </Box>

      <ProviderFormModal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </Page>
  );
}

function SectionHead({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <Group
      justify="space-between"
      align="flex-end"
      wrap="nowrap"
      gap="md"
      className={classes.sectionHead}
    >
      <Stack gap={2}>
        <Text fw={600} fz="lg">
          {title}
        </Text>
        <Text size="sm" c="dimmed">
          {description}
        </Text>
      </Stack>
      {action}
    </Group>
  );
}

function ProvidersSection({ onAdd }: { onAdd: () => void }) {
  return (
    <>
      <SectionHead
        title="AI Providers"
        description="Connect model providers so the Agent can build and run apps."
        action={
          <Button
            leftSection={<IconPlus size={16} stroke={1.8} />}
            onClick={onAdd}
          >
            Add provider
          </Button>
        }
      />
      <Suspense
        fallback={
          <Center py="xl">
            <Loader />
          </Center>
        }
      >
        <ProvidersPanel onAddProvider={onAdd} />
      </Suspense>
    </>
  );
}

function AppearanceSection() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();

  return (
    <>
      <SectionHead
        title="Appearance"
        description="Personalize how Hatch looks on this device."
      />
      <Card withBorder radius="md" padding="lg">
        <Group justify="space-between" wrap="nowrap" gap="md">
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
        </Group>
      </Card>
    </>
  );
}
