import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { SessionsPanel } from './sessions-panel';

type SessionFixture = {
  id: string;
  title: string;
  appId: null;
  providerId: null;
  modelId: null;
  messageCount: number;
  updatedAt: string;
};

const fixtures = vi.hoisted(() => ({
  sessions: [] as SessionFixture[],
}));

vi.mock('~queries/agent', () => ({
  sessionsQueryOptions: {
    queryKey: ['test-agent-sessions'],
    queryFn: async () => fixtures.sessions,
  },
  sessionQueryOptions: (sessionId: string) => ({
    queryKey: ['test-agent-session', sessionId],
    queryFn: async () => null,
  }),
}));

vi.mock('~server/agent-sessions', () => ({
  deleteSession: vi.fn<
    (input: { data: { id: string } }) => Promise<{ ok: boolean }>
  >(async () => ({ ok: true })),
  renameSession: vi.fn<
    (input: { data: { id: string; title: string } }) => Promise<{ ok: boolean }>
  >(async () => ({ ok: true })),
}));

function session(id: string, title: string, updatedAt: string): SessionFixture {
  return {
    id,
    title,
    appId: null,
    providerId: null,
    modelId: null,
    messageCount: 2,
    updatedAt,
  };
}

async function renderPanel(selected: string | null = null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onSelect = vi.fn<(id: string | null) => void>();
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <div style={{ width: 260, height: 600 }}>
          <SessionsPanel selected={selected} onSelect={onSelect} />
        </div>
      </MantineProvider>
    </QueryClientProvider>,
  );
  return { screen, onSelect };
}

beforeEach(() => {
  fixtures.sessions = [];
});

test('groups chats by their existing updated-at order', async () => {
  const now = dayjs();
  fixtures.sessions = [
    session(
      'today-new',
      'Latest chat',
      now.startOf('day').hour(12).toISOString(),
    ),
    session(
      'today-old',
      'Morning chat',
      now.startOf('day').hour(8).toISOString(),
    ),
    session(
      'yesterday',
      'Yesterday chat',
      now.subtract(1, 'day').toISOString(),
    ),
    session('week', 'Earlier this month', now.subtract(8, 'day').toISOString()),
  ];

  const { screen, onSelect } = await renderPanel('today-new');

  await expect
    .element(screen.getByRole('heading', { name: 'Today', level: 2 }))
    .toBeVisible();
  await expect
    .element(screen.getByRole('heading', { name: 'Yesterday', level: 2 }))
    .toBeVisible();
  await expect
    .element(
      screen.getByRole('heading', {
        name: 'Previous 30 Days',
        level: 2,
      }),
    )
    .toBeVisible();

  const sections = [...document.querySelectorAll('section')].map((element) =>
    element.textContent?.replaceAll('Chat options', '').trim(),
  );
  expect(sections).toEqual([
    'TodayLatest chatMorning chat',
    'YesterdayYesterday chat',
    'Previous 30 DaysEarlier this month',
  ]);

  await screen.getByRole('button', { name: 'Morning chat' }).click();
  expect(onSelect).toHaveBeenCalledWith('today-old');
});
