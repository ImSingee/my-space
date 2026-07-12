import { MantineProvider } from '@mantine/core';
import { useState } from 'react';
import { userEvent } from 'vitest/browser';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import { AppRouteAutocomplete } from './app-route-autocomplete';

const routes = [
  { path: '/', description: 'Overview' },
  { path: '/settings', description: 'Preferences' },
  { path: '/projects/$projectId', description: 'Project details' },
];

function RouteInput({
  declaredRoutes = routes,
}: {
  declaredRoutes?: typeof routes;
}) {
  const [value, setValue] = useState('');
  return (
    <AppRouteAutocomplete
      routes={declaredRoutes}
      label="Entry point"
      value={value}
      onChange={setValue}
    />
  );
}

test('shows declared paths and descriptions and filters by either', async () => {
  const screen = await render(
    <MantineProvider>
      <RouteInput />
    </MantineProvider>,
  );
  const input = screen.getByRole('combobox', { name: 'Entry point' });

  await input.click();
  await expect.element(screen.getByText('/settings')).toBeVisible();
  await expect.element(screen.getByText('Preferences')).toBeVisible();

  await input.fill('details');
  await expect.element(screen.getByText('/projects/$projectId')).toBeVisible();
  await expect.element(screen.getByText('Project details')).toBeVisible();
  await expect.element(screen.getByText('/settings')).not.toBeInTheDocument();
});

test('inserts a dynamic template with the keyboard and leaves it editable', async () => {
  const screen = await render(
    <MantineProvider>
      <RouteInput />
    </MantineProvider>,
  );
  const input = screen.getByRole('combobox', { name: 'Entry point' });

  await input.fill('details');
  await userEvent.keyboard('{ArrowDown}{Enter}');
  await expect.element(input).toHaveValue('/projects/$projectId');

  await input.fill('/projects/123');
  await expect.element(input).toHaveValue('/projects/123');
});

test('accepts a custom path when no routes are declared', async () => {
  const screen = await render(
    <MantineProvider>
      <RouteInput declaredRoutes={[]} />
    </MantineProvider>,
  );
  const input = screen.getByRole('combobox', { name: 'Entry point' });

  await input.fill('/custom');
  await expect.element(input).toHaveValue('/custom');
});
