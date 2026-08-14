import { MantineProvider } from '@mantine/core';
import { useState } from 'react';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import { DashboardGridStage } from './dashboard-grid-stage';

function Harness() {
  const [editing, setEditing] = useState(false);

  return (
    <MantineProvider>
      <button type="button" onClick={() => setEditing((value) => !value)}>
        {editing ? 'Exit edit mode' : 'Enter edit mode'}
      </button>
      <DashboardGridStage editing={editing} previewBreakpoint="desktop">
        {() => <iframe title="Widget runtime" srcDoc="<p>Widget content</p>" />}
      </DashboardGridStage>
    </MantineProvider>
  );
}

test('keeps the widget iframe mounted while edit chrome toggles', async () => {
  const screen = await render(<Harness />);
  const originalFrame = screen.container.querySelector('iframe');
  expect(originalFrame).toBeTruthy();

  await screen.getByRole('button', { name: 'Enter edit mode' }).click();
  expect(screen.container.querySelector('iframe')).toBe(originalFrame);
  expect(
    screen.container.querySelector('[data-preview-active="true"]'),
  ).toBeTruthy();

  await screen.getByRole('button', { name: 'Exit edit mode' }).click();
  expect(screen.container.querySelector('iframe')).toBe(originalFrame);
  expect(
    screen.container.querySelector('[data-preview-active="true"]'),
  ).toBeNull();
});
