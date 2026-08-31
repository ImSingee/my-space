import { Alert, Anchor, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import type { AppCompatibility } from '~/app-compatibility';

export function AppCompatibilityNotice({
  compatibility,
}: {
  compatibility: AppCompatibility | null;
}) {
  if (!compatibility || compatibility.isLatest) return null;

  if (!compatibility.isSupported) {
    if (compatibility.version > compatibility.latestVersion) {
      return (
        <Alert
          color="red"
          variant="light"
          icon={<IconAlertTriangle size={18} />}
          title="Platform update required"
        >
          <Text size="sm">
            {`This App uses compatibility v${compatibility.version}, newer than this platform's latest supported v${compatibility.latestVersion}. Its runtime is disabled. Update the platform before running it.`}
          </Text>
        </Alert>
      );
    }

    return (
      <Alert
        color="red"
        variant="light"
        icon={<IconAlertTriangle size={18} />}
        title="App update required"
      >
        <Text size="sm">
          This App uses compatibility v{compatibility.version}, below the
          minimum supported v{compatibility.minimumSupportedVersion}. Its
          runtime is disabled. Use the{' '}
          <Anchor component={Link} to="/agent" fw={600}>
            Agent
          </Anchor>{' '}
          to update and redeploy it.
        </Text>
      </Alert>
    );
  }

  return (
    <Alert
      color="orange"
      variant="light"
      icon={<IconRefresh size={18} />}
      title="Compatibility update available"
    >
      <Text size="sm">
        This App uses compatibility v{compatibility.version}; the latest is v
        {compatibility.latestVersion}. It can keep running, but use the{' '}
        <Anchor component={Link} to="/agent" fw={600}>
          Agent
        </Anchor>{' '}
        to redeploy it for the current platform.
      </Text>
    </Alert>
  );
}
