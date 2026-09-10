import { createApp } from "./app";
import { runExpiry } from "./cron";
import type { Env } from "./env";

const app = createApp();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runExpiry(env.BUCKET));
  },
} satisfies ExportedHandler<Env>;
