import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { NOTIFICATIONS_KEY } from '~queries/notifications';

/**
 * Mutation that refreshes every notification query afterwards (also on
 * failure, since a 404/409 means the configuration changed underneath us).
 * Errors are toasted by the global mutation handler.
 */
export function useNotificationMutation<TInput, TResult>(
  mutationFn: (input: TInput) => Promise<TResult>,
  options: {
    success?: string | ((result: TResult) => string | null);
    onSuccess?: (result: TResult, input: TInput) => void;
  } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (result, input) => {
      const message =
        typeof options.success === 'function'
          ? options.success(result)
          : options.success;
      if (message) toast.success(message);
      options.onSuccess?.(result, input);
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}
