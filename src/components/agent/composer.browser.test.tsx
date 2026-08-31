import { MantineProvider } from '@mantine/core';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import type { AppListItem } from '~server/apps';
import type { WorkflowListItem } from '~server/workflows';
import { Composer } from './composer';

const apps: AppListItem[] = [
  {
    id: 'app-notes',
    slug: 'team-notes',
    name: 'Team Notes',
    description: 'Shared notes',
    status: 'deployed',
    capabilities: null,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  },
  {
    id: 'app-tasks',
    slug: 'tasks',
    name: 'Tasks',
    description: null,
    status: 'draft',
    capabilities: null,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  },
];

const crowdedApps: AppListItem[] = [
  ...Array.from({ length: 10 }, (_, index) => ({
    ...apps[1]!,
    id: `app-team-${index}`,
    slug: `team-${index}`,
    name: `Team ${index}`,
  })),
  apps[0]!,
];

const workflows: WorkflowListItem[] = [
  {
    id: 'workflow-digest',
    slug: 'nightly-digest',
    name: 'Nightly Digest',
    description: 'Send a daily summary',
    status: 'deployed',
    pinned: false,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  },
  {
    id: 'workflow-backup',
    slug: 'team-backup',
    name: 'Team Backup',
    description: 'Archive the team workspace',
    status: 'draft',
    pinned: false,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  },
];

test('allows only one asynchronous submission at a time', async () => {
  let finish: ((accepted: boolean) => void) | undefined;
  const onSubmit = vi.fn<() => Promise<boolean>>(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={onSubmit} />
    </MantineProvider>,
  );
  const input = screen.getByPlaceholder('Message the Agent…');
  await input.fill('Send once');
  const send = screen.getByRole('button', { name: 'Send' });

  await send.click();
  await expect.element(send).toBeDisabled();
  input
    .element()
    .dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );

  expect(onSubmit).toHaveBeenCalledOnce();
  finish?.(true);
  await expect.element(input).toHaveTextContent('');
});

test('shows only non-empty resource categories before drilling down', async () => {
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={vi.fn<() => void>()} workflows={workflows} />
    </MantineProvider>,
  );
  const input = screen.getByPlaceholder('Message the Agent…');
  await input.fill('Run @');

  const menu = screen.getByRole('listbox', { name: 'Apps and Workflows' });
  const workflowCategory = screen.getByRole('option', {
    name: /Workflows.*2/,
  });
  await expect.element(menu).toBeVisible();
  await expect.element(workflowCategory).toBeVisible();
  await expect
    .element(screen.getByRole('option', { name: /Apps/ }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole('option', { name: /Nightly Digest/ }))
    .not.toBeInTheDocument();

  await workflowCategory.click();
  await expect
    .element(screen.getByRole('option', { name: /Nightly Digest/ }))
    .toBeVisible();
  await expect
    .element(screen.getByRole('option', { name: /Team Backup/ }))
    .toBeVisible();
  await screen
    .getByRole('option', { name: 'Back to Apps and Workflows' })
    .click();
  await expect.element(workflowCategory).toBeVisible();

  await screen.rerender(
    <MantineProvider>
      <Composer onSubmit={vi.fn<() => void>()} apps={apps} />
    </MantineProvider>,
  );
  await expect
    .element(screen.getByRole('option', { name: /Apps.*2/ }))
    .toBeVisible();
  await expect.element(workflowCategory).not.toBeInTheDocument();
});

test('shows a compact empty state when there are no mentionable resources', async () => {
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={vi.fn<() => void>()} />
    </MantineProvider>,
  );
  const input = screen.getByPlaceholder('Message the Agent…');
  await input.fill('Ask @');

  await expect
    .element(screen.getByText('No Apps or Workflows yet'))
    .toBeVisible();
  await expect.element(screen.getByRole('option')).not.toBeInTheDocument();
});

test('inserts a Workflow from the category menu and submits ordered content', async () => {
  const onSubmit = vi.fn<() => Promise<boolean>>(async () => true);
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={onSubmit} apps={apps} workflows={workflows} />
    </MantineProvider>,
  );
  const input = screen.getByPlaceholder('Message the Agent…');
  await input.fill('Run @');

  const appCategory = screen.getByRole('option', { name: /Apps.*2/ });
  const workflowCategory = screen.getByRole('option', {
    name: /Workflows.*2/,
  });
  await expect.element(appCategory).toHaveAttribute('aria-selected', 'true');
  await userEvent.keyboard('{ArrowDown}');
  await expect
    .element(workflowCategory)
    .toHaveAttribute('aria-selected', 'true');
  await userEvent.keyboard('{Enter}');
  const workflow = screen.getByRole('option', { name: /Nightly Digest/ });
  await expect.element(workflow).toHaveAttribute('aria-selected', 'true');
  await userEvent.keyboard('{Enter}after review');
  await expect.element(screen.getByText('@Nightly Digest')).toBeVisible();

  await screen.getByRole('button', { name: 'Send' }).click();
  expect(onSubmit).toHaveBeenCalledWith({
    content: [
      { type: 'text', text: 'Run ' },
      {
        type: 'workflow',
        id: 'workflow-digest',
        name: 'Nightly Digest',
      },
      { type: 'text', text: ' after review' },
    ],
    images: [],
    files: [],
  });
});

test('returns from a resource category with listbox keyboard navigation', async () => {
  const screen = await render(
    <MantineProvider>
      <Composer
        onSubmit={vi.fn<() => void>()}
        apps={apps}
        workflows={workflows}
      />
    </MantineProvider>,
  );
  const input = screen.getByPlaceholder('Message the Agent…');
  await input.fill('Run @');

  const workflowCategory = screen.getByRole('option', {
    name: /Workflows.*2/,
  });
  await userEvent.keyboard('{ArrowDown}{Enter}');

  const firstWorkflow = screen.getByRole('option', {
    name: /Nightly Digest/,
  });
  const back = screen.getByRole('option', {
    name: 'Back to Apps and Workflows',
  });
  await expect.element(firstWorkflow).toHaveAttribute('aria-selected', 'true');
  await expect
    .element(input)
    .toHaveAttribute('aria-activedescendant', firstWorkflow.element().id);

  await userEvent.keyboard('{ArrowUp}');
  await expect.element(back).toHaveAttribute('aria-selected', 'true');
  await expect
    .element(input)
    .toHaveAttribute('aria-activedescendant', back.element().id);

  await userEvent.keyboard('{Enter}');
  await expect.element(workflowCategory).toBeVisible();
  await expect.element(back).not.toBeInTheDocument();
  await expect.element(input).toHaveAttribute('aria-expanded', 'true');
});

test('globally searches and groups Apps before Workflows', async () => {
  const screen = await render(
    <MantineProvider>
      <Composer
        onSubmit={vi.fn<() => void>()}
        apps={apps}
        workflows={workflows}
      />
    </MantineProvider>,
  );
  const input = screen.getByPlaceholder('Message the Agent…');
  await input.fill('Compare @team');

  const menu = screen.getByRole('listbox', { name: 'Apps and Workflows' });
  await expect
    .element(screen.getByRole('option', { name: /Team Notes/ }))
    .toBeVisible();
  await expect
    .element(screen.getByRole('option', { name: /Team Backup/ }))
    .toBeVisible();
  expect(menu.element().textContent).toMatch(
    /Apps.*Team Notes.*Workflows.*Team Backup/s,
  );
});

test('searches Workflows by name or slug but not id or description', async () => {
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={vi.fn<() => void>()} workflows={workflows} />
    </MantineProvider>,
  );
  const input = screen.getByPlaceholder('Message the Agent…');

  await input.fill('Run @nightly-digest');
  await expect
    .element(screen.getByRole('option', { name: /Nightly Digest/ }))
    .toBeVisible();

  await input.fill('Run @workflow-digest');
  await expect
    .element(screen.getByText('No matching Apps or Workflows'))
    .toBeVisible();
  await expect
    .element(screen.getByRole('option', { name: /Nightly Digest/ }))
    .not.toBeInTheDocument();

  await input.fill('Run @daily summary');
  await expect
    .element(screen.getByText('No matching Apps or Workflows'))
    .toBeVisible();
  await expect
    .element(screen.getByRole('option', { name: /Nightly Digest/ }))
    .not.toBeInTheDocument();
});

test('inserts an App mention inline and submits ordered content', async () => {
  const onSubmit = vi.fn<() => Promise<boolean>>(async () => true);
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={onSubmit} apps={apps} />
    </MantineProvider>,
  );
  const input = screen.getByPlaceholder('Message the Agent…');
  await input.fill('Please update @team');

  const menu = screen.getByRole('listbox', { name: 'Apps and Workflows' });
  await expect.element(menu).toBeVisible();
  await expect
    .element(screen.getByRole('option', { name: /Team Notes/ }))
    .toBeVisible();
  await userEvent.keyboard('{Enter}');
  await expect.element(screen.getByText('@Team Notes')).toBeVisible();
  await expect.element(input).toHaveAttribute('aria-expanded', 'false');

  await userEvent.keyboard('before launch');
  await screen.getByRole('button', { name: 'Send' }).click();
  expect(onSubmit).toHaveBeenCalledWith({
    content: [
      { type: 'text', text: 'Please update ' },
      {
        type: 'app',
        id: 'app-notes',
        name: 'Team Notes',
        slug: 'team-notes',
      },
      { type: 'text', text: ' before launch' },
    ],
    images: [],
    files: [],
  });
});

test('searches the full App list with a multi-word query', async () => {
  const onSubmit = vi.fn<() => Promise<boolean>>(async () => true);
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={onSubmit} apps={crowdedApps} />
    </MantineProvider>,
  );
  const input = screen.getByPlaceholder('Message the Agent…');
  const notes = screen.getByRole('option', { name: /Team Notes/ });
  await input.fill('Ask @Team');
  await expect.element(notes).toBeInTheDocument();

  await userEvent.keyboard(' Notes');
  await expect.element(notes).toBeVisible();
  await userEvent.keyboard('{Enter}');
  await expect.element(screen.getByText('@Team Notes')).toBeVisible();

  await screen.getByRole('button', { name: 'Send' }).click();
  expect(onSubmit).toHaveBeenCalledWith({
    content: [
      { type: 'text', text: 'Ask ' },
      {
        type: 'app',
        id: 'app-notes',
        name: 'Team Notes',
        slug: 'team-notes',
      },
      { type: 'text', text: ' ' },
    ],
    images: [],
    files: [],
  });
});

test('submits literal text when the resource menu has no matches', async () => {
  const onSubmit = vi.fn<() => Promise<boolean>>(async () => true);
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={onSubmit} apps={apps} />
    </MantineProvider>,
  );
  const input = screen.getByPlaceholder('Message the Agent…');
  await input.fill('Summarize @missing');

  await expect
    .element(screen.getByRole('listbox', { name: 'Apps and Workflows' }))
    .toBeVisible();
  await expect
    .element(screen.getByText('No matching Apps or Workflows'))
    .toBeVisible();
  await expect.element(input).toHaveAttribute('aria-expanded', 'true');
  await expect.element(input).not.toHaveAttribute('aria-activedescendant');

  await userEvent.keyboard('{Enter}');
  expect(onSubmit).toHaveBeenCalledWith({
    content: [{ type: 'text', text: 'Summarize @missing' }],
    images: [],
    files: [],
  });
  await expect.element(input).toHaveTextContent('');
});

test('waits for resource lookup before submitting an unresolved mention', async () => {
  const onSubmit = vi.fn<() => Promise<boolean>>(async () => true);
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={onSubmit} appsLoading />
    </MantineProvider>,
  );
  const input = screen.getByPlaceholder('Message the Agent…');
  const send = screen.getByRole('button', { name: 'Send' });
  await input.fill('Update @team');
  await expect.element(screen.getByText('Loading Apps…')).toBeVisible();
  await expect.element(send).toBeDisabled();

  await userEvent.keyboard('{Enter}');
  expect(onSubmit).not.toHaveBeenCalled();
  await expect.element(input).toHaveTextContent('Update @team');
  await expect.element(screen.getByText('Loading Apps…')).toBeVisible();
  expect(input.element().querySelectorAll('br')).toHaveLength(0);

  await screen.rerender(
    <MantineProvider>
      <Composer onSubmit={onSubmit} apps={apps} />
    </MantineProvider>,
  );
  await expect
    .element(screen.getByRole('option', { name: /Team Notes/ }))
    .toBeVisible();
  await expect.element(send).toBeEnabled();
  await userEvent.keyboard('{Enter}');
  await expect.element(screen.getByText('@Team Notes')).toBeVisible();

  await send.click();
  expect(onSubmit).toHaveBeenCalledWith({
    content: [
      { type: 'text', text: 'Update ' },
      {
        type: 'app',
        id: 'app-notes',
        name: 'Team Notes',
        slug: 'team-notes',
      },
      { type: 'text', text: ' ' },
    ],
    images: [],
    files: [],
  });
});

test('resets the active resource option when the query changes', async () => {
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={vi.fn<() => void>()} apps={apps} />
    </MantineProvider>,
  );
  const input = screen.getByPlaceholder('Message the Agent…');
  await input.fill('Review @t');

  const menu = screen.getByRole('listbox', { name: 'Apps and Workflows' });
  const notes = screen.getByRole('option', { name: /Team Notes/ });
  const tasks = screen.getByRole('option', { name: /Tasks/ });
  await expect.element(menu).toBeVisible();
  await expect.element(input).toHaveAttribute('aria-expanded', 'true');
  await expect
    .element(input)
    .toHaveAttribute('aria-controls', menu.element().id);
  await expect
    .element(input)
    .toHaveAttribute('aria-activedescendant', notes.element().id);

  await userEvent.keyboard('{ArrowDown}');
  await expect.element(tasks).toHaveAttribute('aria-selected', 'true');
  await expect
    .element(input)
    .toHaveAttribute('aria-activedescendant', tasks.element().id);

  await userEvent.keyboard('x');
  await expect
    .element(screen.getByText('No matching Apps or Workflows'))
    .toBeVisible();
  await userEvent.keyboard('{Backspace}');
  await expect.element(notes).toHaveAttribute('aria-selected', 'true');
  await expect
    .element(input)
    .toHaveAttribute('aria-activedescendant', notes.element().id);

  await userEvent.keyboard('{Enter}');
  await expect.element(screen.getByText('@Team Notes')).toBeVisible();
});

test('dismisses resource suggestions when keyboard focus leaves the editor', async () => {
  const onSubmit = vi.fn<() => void>();
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={onSubmit} apps={apps} />
    </MantineProvider>,
  );
  const input = screen.getByPlaceholder('Message the Agent…');
  const menu = screen.getByRole('listbox', { name: 'Apps and Workflows' });
  await input.fill('Review @team');
  await expect.element(menu).toBeVisible();

  await userEvent.keyboard('{Tab}');

  await expect.element(menu).not.toBeInTheDocument();
  await expect.element(input).toHaveAttribute('aria-expanded', 'false');
  await expect.element(input).not.toHaveAttribute('aria-controls');
  await expect.element(input).not.toHaveAttribute('aria-activedescendant');
  await expect
    .element(screen.getByRole('button', { name: 'Attach files' }))
    .toHaveFocus();
  await expect.element(input).toHaveTextContent('Review @team');
  expect(onSubmit).not.toHaveBeenCalled();
});

test('leaves resource popup keystrokes to an active IME composition', async () => {
  const onSubmit = vi.fn<() => void>();
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={onSubmit} apps={apps} workflows={workflows} />
    </MantineProvider>,
  );
  const input = screen.getByPlaceholder('Message the Agent…');
  await input.fill('Review @');

  const appCategory = screen.getByRole('option', { name: /Apps/ });
  await expect
    .element(input)
    .toHaveAttribute('aria-activedescendant', appCategory.element().id);

  const dispatchComposingKey = (key: string) =>
    input.element().dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }),
    );

  dispatchComposingKey('ArrowDown');
  await expect
    .element(input)
    .toHaveAttribute('aria-activedescendant', appCategory.element().id);
  dispatchComposingKey('Enter');
  await expect.element(input).toHaveTextContent('Review @');
  expect(input.element().querySelector('[data-type="mention"]')).toBeNull();
  expect(onSubmit).not.toHaveBeenCalled();
});

test('keeps Shift+Enter as a newline while resource suggestions are open', async () => {
  const onSubmit = vi.fn<() => Promise<boolean>>(async () => true);
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={onSubmit} apps={apps} />
    </MantineProvider>,
  );
  const input = screen.getByPlaceholder('Message the Agent…');
  await input.fill('Review @team');
  await expect
    .element(screen.getByRole('option', { name: /Team Notes/ }))
    .toBeVisible();

  await userEvent.keyboard('{Shift>}{Enter}{/Shift}next line');

  await expect.element(input).toHaveTextContent('Review @teamnext line');
  expect(input.element().querySelectorAll('br')).toHaveLength(1);
  expect(input.element().querySelector('[data-type="mention"]')).toBeNull();
  expect(onSubmit).not.toHaveBeenCalled();
});

test('keeps an inline App draft when submission is rejected', async () => {
  const onSubmit = vi.fn<() => Promise<boolean>>(async () => false);
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={onSubmit} apps={apps} />
    </MantineProvider>,
  );
  const input = screen.getByPlaceholder('Message the Agent…');
  await input.fill('Review @task');
  await screen.getByRole('option', { name: /Tasks/ }).click();
  await userEvent.keyboard('carefully');
  await screen.getByRole('button', { name: 'Send' }).click();

  expect(onSubmit).toHaveBeenCalledOnce();
  await expect.element(screen.getByText('@Tasks')).toBeVisible();
  await expect.element(input).toHaveTextContent('Review @Tasks carefully');
});

test('uses Shift+Enter for a newline and does not submit an IME commit', async () => {
  const onSubmit = vi.fn<() => Promise<boolean>>(async () => true);
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={onSubmit} />
    </MantineProvider>,
  );
  const input = screen.getByPlaceholder('Message the Agent…');
  await input.fill('first line');
  await userEvent.keyboard('{Shift>}{Enter}{/Shift}second line');
  await expect.element(input).toHaveTextContent('first linesecond line');
  expect(input.element().querySelectorAll('br')).toHaveLength(1);
  expect(onSubmit).not.toHaveBeenCalled();

  input.element().dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      isComposing: true,
    }),
  );
  expect(onSubmit).not.toHaveBeenCalled();
});

test('keeps only attachments added while an accepted send is pending', async () => {
  let finish: ((accepted: boolean) => void) | undefined;
  const onSubmit = vi.fn<() => Promise<boolean>>(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={onSubmit} />
    </MantineProvider>,
  );
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('Missing attachment input');
  const attach = (name: string) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([name], name, { type: 'application/octet-stream' }),
    );
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: transfer.files,
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  attach('submitted.bin');
  await expect.element(screen.getByText('submitted.bin')).toBeVisible();
  await screen.getByRole('button', { name: 'Send' }).click();
  attach('new-draft.bin');
  await expect.element(screen.getByText('new-draft.bin')).toBeVisible();

  finish?.(true);
  await expect
    .element(screen.getByText('submitted.bin'))
    .not.toBeInTheDocument();
  await expect.element(screen.getByText('new-draft.bin')).toBeVisible();
  expect(onSubmit).toHaveBeenCalledOnce();
});

test('rejects empty files before they enter the draft', async () => {
  const onSubmit = vi.fn<() => void>();
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={onSubmit} />
    </MantineProvider>,
  );
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('Missing attachment input');
  const transfer = new DataTransfer();
  transfer.items.add(new File([], 'empty.txt', { type: 'text/plain' }));
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: transfer.files,
  });
  input.dispatchEvent(new Event('change', { bubbles: true }));

  await expect.element(screen.getByText('empty.txt')).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: 'Send' }))
    .toBeDisabled();
  expect(onSubmit).not.toHaveBeenCalled();
});
