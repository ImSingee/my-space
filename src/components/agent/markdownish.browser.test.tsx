import { MantineProvider } from '@mantine/core';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import { Markdownish } from './markdownish';

test('keeps code block lines aligned without applying inline code decoration', async () => {
  const screen = await render(
    <MantineProvider>
      <div style={{ width: 300 }}>
        <Markdownish
          text={[
            'Use `hatch workflow list`:',
            '',
            '```sh',
            'hatch workflow list',
            'hatch workflow get <id>',
            `hatch workflow deploy --message "${'long command '.repeat(20)}"`,
            '```',
          ].join('\n')}
        />
      </div>
    </MantineProvider>,
  );
  const pre = screen.container.querySelector('pre')!;
  const code = pre.querySelector('code')!;
  const inline = screen.container.querySelector('p code')!;
  const style = getComputedStyle(code);
  const preStyle = getComputedStyle(pre);
  const text = code.firstChild!;
  const lineStart = (offset: number) => {
    const range = document.createRange();
    range.setStart(text, offset);
    range.setEnd(text, offset + 1);
    return range.getBoundingClientRect().left;
  };

  expect(lineStart(0)).toBeCloseTo(
    lineStart(text.textContent!.indexOf('\n') + 1),
    1,
  );
  expect(style.fontSize).toBe(preStyle.fontSize);
  expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)');
  expect(style.paddingLeft).toBe('0px');
  expect(pre.scrollWidth).toBeGreaterThan(pre.clientWidth);
  expect(pre.getBoundingClientRect().width).toBeLessThanOrEqual(300);
  expect(getComputedStyle(inline).paddingLeft).not.toBe('0px');
  expect(getComputedStyle(inline).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
});
