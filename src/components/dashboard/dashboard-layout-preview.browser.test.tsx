import { MantineProvider } from '@mantine/core';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { DashboardLayoutPreview } from './dashboard-layout-preview';

test('keeps every layout selectable when its canvas must be scaled', async () => {
  const screen = await render(
    <MantineProvider>
      <DashboardLayoutPreview value="mobile" onChange={() => {}} />
    </MantineProvider>,
  );

  await expect
    .element(screen.getByRole('radio', { name: /Desktop/ }))
    .toBeEnabled();
  await expect
    .element(screen.getByRole('radio', { name: /Tablet/ }))
    .toBeEnabled();
  await expect
    .element(screen.getByRole('radio', { name: 'Mobile', exact: true }))
    .toBeEnabled();
});

test('changes to a selected larger preview', async () => {
  const onChange = vi.fn<(value: string) => void>();
  const screen = await render(
    <MantineProvider>
      <DashboardLayoutPreview value="mobile" onChange={onChange} />
    </MantineProvider>,
  );

  await expect
    .element(screen.getByRole('radio', { name: 'Tablet', exact: true }))
    .toBeEnabled();
  await screen.getByText('Tablet', { exact: true }).click();
  expect(onChange).toHaveBeenCalledWith('tablet');
});
