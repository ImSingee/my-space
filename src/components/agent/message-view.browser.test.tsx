import { Box, MantineProvider } from '@mantine/core';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import { MessageView } from './message-view';
import type { ChatMessage } from './types';

function renderMessage(message: ChatMessage, width?: number) {
  return render(
    <MantineProvider>
      <Box data-testid="message-shell" w={width}>
        <MessageView message={message} />
      </Box>
    </MantineProvider>,
  );
}

test('shows a persisted model error even when the reply has no content', async () => {
  const screen = await renderMessage({
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage: 'OpenAI API error (402): 402 status code (no body)',
  });

  await expect
    .element(
      screen.getByRole('note', {
        name: "The Agent couldn't complete this reply",
      }),
    )
    .toBeVisible();
  await expect
    .element(
      screen.getByText('OpenAI API error (402): 402 status code (no body)'),
    )
    .toBeVisible();
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

test('renders the terminal error after partial assistant content', async () => {
  const screen = await renderMessage({
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: 'Partial answer before the provider failed.',
      },
    ],
    stopReason: 'error',
    errorMessage: 'Provider connection closed.',
  });

  const partial = screen.getByText(
    'Partial answer before the provider failed.',
  );
  const notice = screen.getByRole('note');
  await expect.element(partial).toBeVisible();
  await expect.element(notice).toBeVisible();
  expect(
    partial.element().compareDocumentPosition(notice.element()) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test('does not present an aborted reply as an error', async () => {
  const screen = await renderMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'Work stopped here.' }],
    stopReason: 'aborted',
    errorMessage: 'Request was aborted',
  });

  await expect.element(screen.getByText('Work stopped here.')).toBeVisible();
  expect(document.querySelector('[role="note"]')).toBeNull();
  expect(
    document.body.textContent?.includes(
      "The Agent couldn't complete this reply",
    ),
  ).toBe(false);
});

test('uses a useful fallback when an error has no detail', async () => {
  const screen = await renderMessage({
    role: 'assistant',
    content: [],
    stopReason: 'error',
  });

  await expect
    .element(screen.getByText('The model provider returned an unknown error.'))
    .toBeVisible();
});

test('wraps long and multiline provider errors inside a narrow message', async () => {
  const longToken = `provider-${'x'.repeat(320)}`;
  const error = `First line\n${longToken}`;
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: error,
    },
    320,
  );

  const detail = screen.getByText(error);
  await expect.element(detail).toBeVisible();

  const detailElement = detail.element();
  const shell = screen.getByTestId('message-shell').element();
  expect(getComputedStyle(detailElement).whiteSpace).toBe('pre-wrap');
  expect(getComputedStyle(detailElement).overflowWrap).toBe('anywhere');
  expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth);
});
