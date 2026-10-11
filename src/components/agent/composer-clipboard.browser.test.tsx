import { MantineProvider } from '@mantine/core';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import {
  composerModelText,
  type ComposerInputPart,
} from '~agent/composer-content';
import { Composer } from './composer';
import { MessageView } from './message-view';

const content: ComposerInputPart[] = [
  { type: 'text', text: 'Review ' },
  { type: 'app', id: 'app-original', name: 'Notes "{draft}"', slug: 'notes' },
  { type: 'text', text: '\n\nthen run ' },
  { type: 'workflow', id: 'workflow-original', name: 'Digest' },
  { type: 'text', text: ' now.' },
];

const modifier = navigator.platform.startsWith('Mac') ? 'Meta' : 'Control';

async function selectEditorContents() {
  await userEvent.keyboard(`{${modifier}>}a{/${modifier}}`);
}

function paste(element: Element, text: string, html?: string) {
  const clipboardData = new DataTransfer();
  clipboardData.setData('text/plain', text);
  if (html) clipboardData.setData('text/html', html);
  element.dispatchEvent(
    new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData,
    }),
  );
}

function selectContents(element: Node) {
  const range = document.createRange();
  range.selectNodeContents(element);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
}

function copySelection(target: Element) {
  const clipboardData = new DataTransfer();
  const event = new ClipboardEvent('copy', {
    bubbles: true,
    cancelable: true,
    clipboardData,
  });
  target.dispatchEvent(event);
  return { clipboardData, handled: event.defaultPrevented };
}

test('restores mixed snapshots from plain text and HTML, submits identities, and copies/cuts the editor selection', async () => {
  const onSubmit = vi.fn<() => Promise<boolean>>(async () => false);
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={onSubmit} />
    </MantineProvider>,
  );
  const input = screen.getByRole('textbox', { name: 'Message the Agent…' });
  await input.click();
  paste(
    input.element(),
    composerModelText(content).replaceAll('\n', '\r\n'),
    '<p>HTML should not replace the snapshots</p>',
  );
  await expect.element(screen.getByText('@Notes "{draft}"')).toBeVisible();
  await expect.element(screen.getByText('@Digest')).toBeVisible();
  await screen.getByRole('button', { name: 'Send' }).click();
  expect(onSubmit).toHaveBeenLastCalledWith({ content, images: [], files: [] });

  await input.click();
  await selectEditorContents();
  const copied = copySelection(input.element());
  expect(copied.clipboardData.getData('text/plain')).toBe(
    composerModelText(content),
  );
  expect(copied.clipboardData.getData('text/html')).toContain(
    'data-type="mention"',
  );
  const clipboardData = new DataTransfer();
  input.element().dispatchEvent(
    new ClipboardEvent('cut', {
      bubbles: true,
      cancelable: true,
      clipboardData,
    }),
  );
  expect(clipboardData.getData('text/plain')).toBe(composerModelText(content));
  await expect.element(input).toHaveTextContent('');
  paste(input.element(), copied.clipboardData.getData('text/plain'));
  await screen.getByRole('button', { name: 'Send' }).click();
  expect(onSubmit).toHaveBeenLastCalledWith({ content, images: [], files: [] });
});

test('replaces the selection with snapshots in one undoable paste and counts only remaining references', async () => {
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={vi.fn<() => void>()} />
    </MantineProvider>,
  );
  const input = screen.getByRole('textbox', { name: 'Message the Agent…' });
  const references = Array.from({ length: 32 }, () => content[3]!);
  await input.click();
  paste(input.element(), composerModelText(references));
  expect(
    input.element().querySelectorAll('[data-type="mention"]'),
  ).toHaveLength(32);
  await selectEditorContents();
  paste(input.element(), composerModelText(content));
  expect(
    input.element().querySelectorAll('[data-type="mention"]'),
  ).toHaveLength(2);
  await userEvent.keyboard(`{${modifier}>}z{/${modifier}}`);
  expect(
    input.element().querySelectorAll('[data-type="mention"]'),
  ).toHaveLength(32);
  await userEvent.keyboard(`{${modifier}>}{Shift>}z{/Shift}{/${modifier}}`);
  expect(
    input.element().querySelectorAll('[data-type="mention"]'),
  ).toHaveLength(2);
});

test('keeps over-limit pastes and malformed tokens as text without dropping content', async () => {
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={vi.fn<() => void>()} />
    </MantineProvider>,
  );
  const input = screen.getByRole('textbox', { name: 'Message the Agent…' });
  const text = composerModelText(Array.from({ length: 33 }, () => content[3]!));
  await input.click();
  paste(
    input.element(),
    text,
    '<span data-type="mention" data-id="fake" data-label="Fake">@Fake</span>',
  );
  expect(input.element().querySelector('[data-type="mention"]')).toBeNull();
  await expect.element(input).toHaveTextContent(text);
  await input.fill('');
  const malformed = '@APP{name="Notes" id="app-original"} and @ordinary';
  paste(input.element(), malformed);
  expect(input.element().querySelector('[data-type="mention"]')).toBeNull();
  await expect.element(input).toHaveTextContent(malformed);
});

test('copies exactly the selected message content and restores it in the editor', async () => {
  const onSubmit = vi.fn<() => Promise<boolean>>(async () => true);
  const screen = await render(
    <MantineProvider>
      <MessageView
        message={{
          role: 'user',
          content: [{ type: 'text', text: composerModelText(content) }],
          composerContent: content,
        }}
      />
      <Composer onSubmit={onSubmit} />
    </MantineProvider>,
  );
  const mention = screen.getByText('@Notes "{draft}"').element();
  const fullLabel = document.createRange();
  fullLabel.setStart(mention.firstChild!, 0);
  fullLabel.setEnd(mention.lastChild!, mention.lastChild!.textContent!.length);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(fullLabel);
  expect(copySelection(document.body).clipboardData.getData('text/plain')).toBe(
    composerModelText([content[1]!]),
  );
  selectContents(mention.parentElement!);
  const copied = copySelection(document.body);
  expect(copied.clipboardData.getData('text/plain')).toBe(
    composerModelText(content),
  );
  const input = screen.getByRole('textbox', { name: 'Message the Agent…' });
  await input.click();
  paste(
    input.element(),
    copied.clipboardData.getData('text/plain'),
    copied.clipboardData.getData('text/html'),
  );
  await screen.getByRole('button', { name: 'Send' }).click();
  expect(onSubmit).toHaveBeenCalledWith({ content, images: [], files: [] });

  const range = document.createRange();
  range.setStart(mention.lastChild!, 0);
  range.setEnd(mention.lastChild!, 5);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  expect(document.getSelection()!.toString()).toBe('Notes');
  expect(copySelection(document.body).handled).toBe(false);
});

test('preserves block boundaries when copying snapshots across multiple messages', async () => {
  const screen = await render(
    <MantineProvider>
      <div data-testid="transcript">
        {[content[1]!, content[3]!].map((part, index) => (
          <MessageView
            key={index}
            message={{
              role: 'user',
              content: [{ type: 'text', text: composerModelText([part]) }],
              composerContent: [part],
            }}
          />
        ))}
      </div>
    </MantineProvider>,
  );
  selectContents(screen.getByTestId('transcript').element());
  const text = copySelection(document.body).clipboardData.getData('text/plain');
  expect(text).toBe(
    composerModelText([content[1]!]) +
      '\n\n' +
      composerModelText([content[3]!]),
  );
  const range = document.createRange();
  range.setStart(screen.getByText('@Notes "{draft}"').element().lastChild!, 0);
  range.setEndAfter(screen.getByText('@Digest').element());
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  expect(copySelection(document.body).clipboardData.getData('text/plain')).toBe(
    'Notes "{draft}"\n\n' + composerModelText([content[3]!]),
  );
});

test('copies collapsed long messages without their expand controls', async () => {
  const lines = Array.from(
    { length: 12 },
    (_, index) => `step ${index + 1}`,
  ).join('\n');
  const longContent: ComposerInputPart[] = [
    ...content,
    { type: 'text', text: `\n${lines}` },
  ];
  const screen = await render(
    <MantineProvider>
      <div data-testid="transcript">
        <MessageView
          message={{
            role: 'user',
            content: [{ type: 'text', text: composerModelText(longContent) }],
            composerContent: longContent,
          }}
        />
        <MessageView message={{ role: 'user', content: lines }} />
      </div>
      <textarea aria-label="Plain text transfer" />
    </MantineProvider>,
  );
  const toggles = screen.getByRole('button', { name: 'Expand message' });
  await expect.element(toggles.nth(1)).toBeVisible();
  expect(toggles.elements()).toHaveLength(2);

  selectContents(screen.getByTestId('transcript').element());
  const copied = copySelection(document.body);
  expect(copied.clipboardData.getData('text/plain')).toBe(
    composerModelText(longContent) + '\n\n' + lines,
  );
  const html = copied.clipboardData.getData('text/html');
  expect(html).not.toContain('<button');
  expect(html).not.toContain('<svg');

  // Without snapshots the browser copies natively and must skip it as well.
  selectContents(toggles.nth(1).element().closest('.mantine-Paper-root')!);
  await userEvent.copy();
  const transfer = screen.getByRole('textbox', { name: 'Plain text transfer' });
  await transfer.click();
  await userEvent.paste();
  await expect.element(transfer).toHaveValue(lines);
});

test('round-trips native browser clipboard through a plain textarea back into the composer', async () => {
  const onSubmit = vi.fn<() => Promise<boolean>>(async () => true);
  const screen = await render(
    <MantineProvider>
      <MessageView
        message={{
          role: 'user',
          content: [{ type: 'text', text: composerModelText(content) }],
          composerContent: content,
        }}
      />
      <textarea aria-label="Plain text transfer" />
      <Composer onSubmit={onSubmit} />
    </MantineProvider>,
  );
  const mention = screen.getByText('@Notes "{draft}"').element();
  selectContents(mention.parentElement!);
  await userEvent.copy();
  const transfer = screen.getByRole('textbox', { name: 'Plain text transfer' });
  await transfer.click();
  await userEvent.paste();
  await expect.element(transfer).toHaveValue(composerModelText(content));
  await selectEditorContents();
  await userEvent.cut();
  await expect.element(transfer).toHaveValue('');
  const input = screen.getByRole('textbox', { name: 'Message the Agent…' });
  await input.click();
  await userEvent.paste();
  expect(
    input.element().querySelectorAll('[data-type="mention"]'),
  ).toHaveLength(2);
  await selectEditorContents();
  await userEvent.cut();
  await expect.element(input).toHaveTextContent('');
  await transfer.click();
  await userEvent.paste();
  await expect.element(transfer).toHaveValue(composerModelText(content));
  await selectEditorContents();
  await userEvent.copy();
  await input.click();
  await userEvent.paste();
  await screen.getByRole('button', { name: 'Send' }).click();
  expect(onSubmit).toHaveBeenCalledWith({ content, images: [], files: [] });
});

test('keeps file attachments ahead of mention text when both appear on the clipboard', async () => {
  const onSubmit = vi.fn<() => Promise<boolean>>(async () => true);
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={onSubmit} />
    </MantineProvider>,
  );
  const input = screen.getByRole('textbox', { name: 'Message the Agent…' });
  await input.click();
  const file = new File(['attached notes'], 'notes.txt', {
    type: 'text/plain',
  });
  const clipboardData = new DataTransfer();
  clipboardData.setData('text/plain', composerModelText(content));
  clipboardData.items.add(file);
  input.element().dispatchEvent(
    new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData,
    }),
  );
  await expect.element(screen.getByText('notes.txt')).toBeVisible();
  await expect.element(input).toHaveTextContent('');
  await screen.getByRole('button', { name: 'Send' }).click();
  expect(onSubmit).toHaveBeenCalledWith({
    content: [],
    images: [],
    files: [
      expect.objectContaining({
        name: 'notes.txt',
        mimeType: 'text/plain',
        size: file.size,
        file,
      }),
    ],
  });
});
