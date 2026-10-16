import {
  Alert,
  Button,
  Group,
  Select,
  Skeleton,
  Stack,
  Text,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { authClient } from '~auth/client';
import { AppRouteAutocomplete } from '~components/apps/app-route-autocomplete';
import { HOMEPAGE_PAGES, type HomepageTarget } from '~/homepage';
import { normalizedManifestQueryOptions } from '~queries/apps';
import { dashboardsQueryOptions } from '~queries/dashboards';
import { homepageSettingsQueryOptions } from '~queries/homepage';
import {
  updateHomepageSettings,
  type HomepageSettings,
} from '~server/homepage';

function targetValue(target: HomepageTarget): string {
  if (target.kind === 'page') return `page:${target.page}`;
  if (target.kind === 'dashboard') return `dashboard:${target.dashboardId}`;
  return `app:${target.appId}`;
}

export function HomepagePanel() {
  const session = authClient.useSession();
  if (session.isPending) return <Skeleton height={120} />;
  if (!session.data || session.error) {
    return (
      <Alert color="red" title="Homepage could not be loaded">
        <Button
          type="button"
          variant="subtle"
          onClick={() => void session.refetch()}
        >
          Try again
        </Button>
      </Alert>
    );
  }
  return (
    <AccountHomepage key={session.data.user.id} userId={session.data.user.id} />
  );
}

function AccountHomepage({ userId }: { userId: string }) {
  const settings = useQuery(homepageSettingsQueryOptions(userId));
  const dashboards = useQuery(dashboardsQueryOptions);
  const error = settings.error ?? dashboards.error;
  if (error) {
    return (
      <Alert color="red" title="Homepage could not be loaded">
        <Text size="sm">{error.message}</Text>
        <Button
          type="button"
          variant="subtle"
          onClick={() => {
            void settings.refetch();
            void dashboards.refetch();
          }}
        >
          Try again
        </Button>
      </Alert>
    );
  }
  if (!settings.data || !dashboards.data) return <Skeleton height={120} />;

  const options = [
    {
      group: 'Platform pages',
      items: HOMEPAGE_PAGES.map((page) => ({
        value: `page:${page.value}`,
        label: page.label,
        target: { kind: 'page', page: page.value } satisfies HomepageTarget,
      })),
    },
    {
      group: 'Dashboards',
      items: dashboards.data.map((dashboard) => ({
        value: `dashboard:${dashboard.id}`,
        label: dashboard.name,
        target: {
          kind: 'dashboard',
          dashboardId: dashboard.id,
        } satisfies HomepageTarget,
      })),
    },
    {
      group: 'Apps',
      items: settings.data.apps.map((app) => ({
        value: `app:${app.id}`,
        label: app.name,
        target: {
          kind: 'app',
          appId: app.id,
          entryHash: null,
        } satisfies HomepageTarget,
      })),
    },
  ];
  const savedValue = targetValue(settings.data.homepage);
  const missing = !options.some((group) =>
    group.items.some((option) => option.value === savedValue),
  );
  const data: HomepageOptionGroup[] = options;
  if (missing)
    data.push({
      group: 'Unavailable',
      items: [
        {
          value: savedValue,
          label: 'Previously selected homepage (unavailable)',
          target: settings.data.homepage,
          disabled: true,
        },
      ],
    });

  return (
    <HomepageForm
      key={`${userId}:${JSON.stringify(settings.data.homepage)}`}
      settings={settings.data}
      options={data}
    />
  );
}

type HomepageOptionGroup = {
  group: string;
  items: {
    value: string;
    label: string;
    target: HomepageTarget;
    disabled?: boolean;
  }[];
};

function HomepageForm({
  settings,
  options,
}: {
  settings: HomepageSettings;
  options: HomepageOptionGroup[];
}) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState(settings.homepage);
  const appId = target.kind === 'app' ? target.appId : '';
  const manifest = useQuery({
    ...normalizedManifestQueryOptions(appId),
    enabled: Boolean(appId),
  });
  const save = useMutation({
    mutationFn: (homepage: HomepageTarget) =>
      updateHomepageSettings({ data: homepage }),
    meta: { errorToast: false },
    retry: false,
    networkMode: 'always',
    onSuccess: (saved) => {
      queryClient.setQueryData(
        homepageSettingsQueryOptions(saved.userId).queryKey,
        saved,
      );
      toast.success('Homepage updated');
    },
  });
  const value = targetValue(target);
  const selected = options
    .flatMap((group) => group.items)
    .find((item) => item.value === value);
  const changed = JSON.stringify(target) !== JSON.stringify(settings.homepage);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!save.isPending && changed && selected && !selected.disabled)
          save.mutate(target);
      }}
    >
      <Stack gap="md">
        <Stack gap={2}>
          <Text fw={600}>Homepage</Text>
          <Text size="sm" c="dimmed">
            Choose where Hatch opens for your account. Your homepage follows you
            across devices.
          </Text>
        </Stack>
        {!settings.available && (
          <Alert color="yellow" title="Your saved homepage is unavailable">
            Hatch opens the default Dashboard until this page becomes available
            or you choose another homepage.
          </Alert>
        )}
        <Select
          label="Open Hatch to"
          data={options}
          value={value}
          searchable
          nothingFoundMessage="No matching homepages"
          allowDeselect={false}
          disabled={save.isPending}
          onChange={(next) => {
            const option = options
              .flatMap((group) => group.items)
              .find((item) => item.value === next);
            if (option && !option.disabled) setTarget(option.target);
          }}
        />
        {target.kind === 'app' && (
          <AppRouteAutocomplete
            label="App entry point"
            description="Leave blank for the app home."
            placeholder="/settings"
            routes={manifest.data?.app?.routes ?? []}
            value={target.entryHash ?? ''}
            disabled={save.isPending || Boolean(selected?.disabled)}
            onChange={(entryHash) =>
              setTarget({ ...target, entryHash: entryHash || null })
            }
          />
        )}
        {target.kind === 'app' && manifest.error && (
          <Alert
            color="yellow"
            title="App page suggestions could not be loaded"
          >
            You can still enter an app page manually.
            <Button
              type="button"
              variant="subtle"
              onClick={() => void manifest.refetch()}
            >
              Try again
            </Button>
          </Alert>
        )}
        {save.error && (
          <Alert color="red" title="Homepage could not be saved" role="alert">
            {save.error.message}
          </Alert>
        )}
        <Group justify="flex-start">
          <Button
            type="submit"
            loading={save.isPending}
            disabled={!changed || !selected || selected.disabled}
          >
            Save homepage
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
