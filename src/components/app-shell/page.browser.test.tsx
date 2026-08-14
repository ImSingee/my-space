import { MantineProvider } from '@mantine/core';
import { useState } from 'react';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import { Page } from './page';

function Harness() {
  const [hideHeader, setHideHeader] = useState(false);

  return (
    <MantineProvider>
      <button type="button" onClick={() => setHideHeader((hidden) => !hidden)}>
        Toggle header
      </button>
      <Page
        title="My Dashboard"
        description="Dashboard description"
        actions={<button type="button">Page action</button>}
        hideHeader={hideHeader}
      >
        <iframe title="Widget runtime" srcDoc="<p>Widget content</p>" />
      </Page>
    </MantineProvider>
  );
}

test('hides the standard header without remounting page content', async () => {
  const screen = await render(<Harness />);
  const originalFrame = screen.container.querySelector('iframe');
  expect(originalFrame).toBeTruthy();
  expect(screen.container.querySelector('h2')?.textContent).toBe(
    'My Dashboard',
  );

  await screen.getByRole('button', { name: 'Toggle header' }).click();

  const headerlessPage = screen.container.querySelector('[data-headerless]');
  const body = originalFrame?.parentElement;
  expect(headerlessPage).toBeTruthy();
  expect(screen.container.querySelector('h2')).toBeNull();
  expect(screen.container.textContent).not.toContain('Dashboard description');
  expect(screen.container.textContent).not.toContain('Page action');
  expect(screen.container.querySelector('iframe')).toBe(originalFrame);
  expect(getComputedStyle(headerlessPage!).paddingTop).toBe('0px');
  expect(getComputedStyle(body!).marginTop).toBe('0px');

  await screen.getByRole('button', { name: 'Toggle header' }).click();

  expect(screen.container.querySelector('h2')?.textContent).toBe(
    'My Dashboard',
  );
  expect(screen.container.querySelector('iframe')).toBe(originalFrame);
});
