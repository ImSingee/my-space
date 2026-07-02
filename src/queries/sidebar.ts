import { queryOptions } from '@tanstack/react-query';
import { listSidebarItems } from '~server/sidebar';

export const sidebarItemsQueryOptions = queryOptions({
  queryKey: ['sidebar', 'items'],
  queryFn: () => listSidebarItems(),
});
