import { MantineProvider } from '@mantine/core';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { appTheme } from '~/ui/theme';
import { DashboardOptionsMenu } from './dashboard-options-menu';

test('opens dashboard editing from the options menu', async () => {
  const onEdit = vi.fn<() => void>();
  const screen = await render(
    <MantineProvider theme={appTheme}>
      <DashboardOptionsMenu
        onEdit={onEdit}
        onRename={() => {}}
        onEditDescription={() => {}}
        onDelete={() => {}}
        deleteDisabled={false}
      />
    </MantineProvider>,
  );

  await expect
    .element(screen.getByRole('button', { name: 'Edit dashboard' }))
    .not.toBeInTheDocument();

  await screen.getByRole('button', { name: 'Dashboard options' }).click();
  const edit = screen.getByRole('menuitem', { name: 'Edit dashboard' });
  await expect.element(edit).toBeVisible();
  await edit.click();

  expect(onEdit).toHaveBeenCalledOnce();
});
