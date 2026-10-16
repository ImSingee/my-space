import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import {
  createModel,
  updateModel,
  type ProviderWithModels,
} from '~server/providers';
import { ProvidersPanel } from './providers-panel';

vi.mock('~server/providers', () => ({
  createModel: vi.fn<typeof createModel>(),
  updateModel: vi.fn<typeof updateModel>(),
  createProvider: vi.fn<() => void>(),
  updateProvider: vi.fn<() => void>(),
  deleteProvider: vi.fn<() => void>(),
  deleteModel: vi.fn<() => void>(),
}));

const mocks = vi.hoisted(() => ({
  list: vi.fn<() => Promise<ProviderWithModels[]>>(),
}));
vi.mock('~queries/agent', () => ({
  providersQueryOptions: {
    queryKey: ['agent', 'providers'],
    queryFn: mocks.list,
  },
}));

test('custom model creation sends images by default and editing persists the image choice', async () => {
  const provider: ProviderWithModels = {
    id: 'provider',
    name: 'Custom endpoint',
    apiType: 'openai-responses',
    baseUrl: 'https://example.test/v1',
    enabled: true,
    sortOrder: 0,
    models: [],
  };
  mocks.list.mockImplementation(async () => structuredClone([provider]));
  vi.mocked(createModel).mockImplementation(async ({ data }) => {
    provider.models.push({
      id: 'model',
      modelId: data.modelId,
      name: data.name,
      reasoning: data.reasoning ?? false,
      input: data.input ?? [],
      contextWindow: data.contextWindow ?? 128000,
      maxTokens: data.maxTokens ?? 8192,
      enabled: true,
      sortOrder: 0,
    });
    return { id: 'model' };
  });
  vi.mocked(updateModel).mockImplementation(async ({ data }) => {
    const model = provider.models[0]!;
    if (data.input !== undefined) model.input = data.input;
    return { ok: true };
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const screen = await render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <ModalsProvider>
          <ProvidersPanel onAddProvider={() => {}} />
        </ModalsProvider>
      </QueryClientProvider>
    </MantineProvider>,
  );
  await screen.getByRole('button', { name: 'Add model', exact: true }).click();
  await userEvent.fill(
    screen.getByRole('textbox', { name: 'Model ID' }),
    'gpt-6.1-sol',
  );
  await expect
    .element(screen.getByRole('switch', { name: /^Image input/ }))
    .toBeChecked();
  await screen
    .getByRole('dialog')
    .getByRole('button', { name: 'Add model', exact: true })
    .click();
  await expect.poll(() => provider.models[0]?.input).toEqual(['text', 'image']);

  for (const enabled of [false, true]) {
    await screen.getByRole('button', { name: 'Edit model' }).click();
    await screen.getByRole('switch', { name: /^Image input/ }).click();
    await screen.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(() => provider.models[0]?.input)
      .toEqual(enabled ? ['text', 'image'] : ['text']);
    await screen.getByRole('button', { name: 'Edit model' }).click();
    const imageInput = screen.getByRole('switch', { name: /^Image input/ });
    await expect
      .poll(() => (imageInput.element() as HTMLInputElement).checked)
      .toBe(enabled);
    await screen.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  client.clear();
});
