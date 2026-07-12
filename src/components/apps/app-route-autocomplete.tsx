import {
  Autocomplete,
  Stack,
  Text,
  type AutocompleteProps,
  type OptionsFilter,
} from '@mantine/core';
import type { AppRoute } from '~server/apps/manifest';

export type AppRouteAutocompleteProps = Omit<
  AutocompleteProps,
  'data' | 'filter' | 'renderOption'
> & {
  routes: readonly AppRoute[];
};

/**
 * Free-text app path input enhanced with routes declared by the live app.
 * Selecting a dynamic template inserts it verbatim so the user can replace its
 * `$param` segments before saving.
 */
export function AppRouteAutocomplete({
  routes,
  ...props
}: AppRouteAutocompleteProps) {
  const descriptions = new Map(
    routes.map((route) => [route.path, route.description]),
  );
  const filter: OptionsFilter = ({ options, search, limit }) => {
    const needle = search.trim().toLocaleLowerCase();
    return options
      .filter((option) => {
        if ('group' in option) return false;
        const path = String(option.value);
        const description = descriptions.get(path) ?? '';
        return `${path}\n${description}`.toLocaleLowerCase().includes(needle);
      })
      .slice(0, limit);
  };

  return (
    <Autocomplete
      {...props}
      data={routes.map((route) => route.path)}
      filter={filter}
      limit={8}
      maxDropdownHeight={280}
      renderOption={({ option }) => (
        <Stack gap={1} py={2}>
          <Text ff="monospace" fw={500} size="sm">
            {option.value}
          </Text>
          <Text c="dimmed" size="xs">
            {descriptions.get(String(option.value))}
          </Text>
        </Stack>
      )}
    />
  );
}
