import { Group, SegmentedControl } from '@mantine/core';
import {
  IconDeviceDesktop,
  IconDeviceMobile,
  IconDeviceTablet,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { DashboardBreakpoint } from '~/lib/dashboard-layout';

const PREVIEW_OPTIONS: Array<{
  value: DashboardBreakpoint;
  label: string;
  icon: ReactNode;
}> = [
  {
    value: 'desktop',
    label: 'Desktop',
    icon: <IconDeviceDesktop size={15} stroke={1.8} />,
  },
  {
    value: 'tablet',
    label: 'Tablet',
    icon: <IconDeviceTablet size={15} stroke={1.8} />,
  },
  {
    value: 'mobile',
    label: 'Mobile',
    icon: <IconDeviceMobile size={15} stroke={1.8} />,
  },
];

export function DashboardLayoutPreview({
  value,
  onChange,
}: {
  value: DashboardBreakpoint;
  onChange: (value: DashboardBreakpoint) => void;
}) {
  return (
    <SegmentedControl
      value={value}
      onChange={(next) => onChange(next as DashboardBreakpoint)}
      data={PREVIEW_OPTIONS.map((option) => ({
        value: option.value,
        label: (
          <Group component="span" gap={6} wrap="nowrap">
            {option.icon}
            <span>{option.label}</span>
          </Group>
        ),
      }))}
      aria-label="Layout preview"
    />
  );
}
