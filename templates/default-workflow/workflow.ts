import { defineWorkflow } from '@hatch/workflow';
import { z } from 'zod';

/**
 * A Hatch workflow runs a periodic / repetitive task. It is triggered manually,
 * on a cron schedule, or via webhook, and every run is recorded in the run
 * inspector. Define the trigger input with zod (it drives the manual-run form
 * and validation) and split the body into `ctx.step(...)` calls for observable,
 * optionally-retried units of work.
 */
export default defineWorkflow({
  input: z.object({
    name: z.string().min(1).describe('Who to greet'),
    times: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(1)
      .describe('How many greetings to produce'),
  }),
  run: async (ctx, input) => {
    const greeting = await ctx.step('build-greeting', () => {
      return Array.from(
        { length: input.times },
        () => `Hello, ${input.name}!`,
      ).join('\n');
    });

    ctx.log(greeting);

    return { greeting, count: input.times };
  },
});
