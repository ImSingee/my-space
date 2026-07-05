# Hatch

**Describe an app. Get an app.**

Hatch is a self-hosted, AI-native personal app platform. Tell the built-in
agent what you want in plain language and it designs, codes, and deploys a
real working app — UI, API, and its own private database — onto your server
in minutes. Then you keep talking to make it better.

No boilerplate, no hosting setup, no glue scripts. Just the tools you always
wished existed, built for an audience of one: you.

## How it works

1. **Ask.** Open the agent chat and describe the tool: "a habit tracker with
   a streak widget", "watch this price and chart the history", "a read-later
   box I can fill from my phone".
2. **Watch it ship.** The agent scaffolds the app, writes the code,
   provisions a database, and deploys a versioned release you can open right
   away at its own clean URL.
3. **Iterate forever.** "Make the chart weekly." "Add dark mode." Every
   change becomes a new deployment — and if you liked it better before, one
   click rolls it back.

## What you get

- **Real apps, not chat demos.** Each app is an independent full-stack
  application: a fast web UI, a typed API backend, and a dedicated Postgres
  database. Apps keep running on their own — the chat is just how you build
  them.
- **Versioned deployments.** Every deploy is recorded with a release note and
  build log. Browse the full history and roll back to any earlier version
  instantly from the app's manage page.
- **Dashboards and widgets.** Apps ship live widgets you pin to personal
  dashboards. Drag, resize, and arrange them on a responsive grid; widgets
  adapt to their size, refresh on demand, or auto-refresh on an interval you
  pick.
- **Automations.** Schedule cron jobs that call your app on time, and expose
  webhook endpoints so the outside world — phone shortcuts, other services,
  IoT gadgets — can push data in securely.
- **Workflows.** For headless recurring tasks, build a workflow instead of an
  app: trigger it on a schedule, from a webhook, or manually with an
  auto-generated form, and audit every run step by step — status, duration,
  and logs included.
- **Browser scripts.** Apps can publish Tampermonkey userscripts that extend
  other websites with your own logic. Install them from a private link that
  auto-updates every time you redeploy.
- **Files, key-value storage, and secrets.** Apps get file storage and a
  built-in key-value store for tokens and config. Values marked secret stay
  masked in the UI.
- **Your space, arranged your way.** Pin apps, dashboards, and workflows to
  the sidebar — even multiple shortcuts per app, each deep-linking to a
  specific screen. Rename apps and their URLs whenever you like.
- **Private by design.** Hatch is single-tenant and self-hosted: your data,
  your server, your AI provider keys. App backends run sandboxed with scoped
  database access.

## Run it

All you need is Docker. From the folder containing `docker-compose.yml`:

```bash
echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)" > .env
docker compose up -d
```

Then open [http://localhost:3700](http://localhost:3700) and:

1. **Create your account** — sign-up is open on first launch so the owner
   (you) can register.
2. **Lock the door** — once your account exists, close registration for good:

   ```bash
   echo 'HATCH_ALLOW_SIGNUP=false' >> .env
   docker compose up -d
   ```

3. **Connect your AI** — go to **Settings → Providers** and add your model
   provider API key.
4. **Build your first app** — open the agent and ask for something you have
   always wanted.

Everything persists in Docker volumes (your apps, their databases, and their
files), and `docker compose up -d` pulls the latest release whenever you want
to upgrade. Set `HATCH_PORT` in `.env` to serve on a different port.

## Ideas to try

- "Build a habit tracker with a streak widget I can pin to my dashboard."
- "Track the price of this product every hour and chart the history."
- "Make a bookmarks app with a webhook so I can save links from my phone."
- "Create a workflow that pulls my RSS feeds every morning and files new
  items into my reading app."
- "Publish a userscript that adds keyboard shortcuts to my favorite forum and
  logs what I read into an app."

## License

Hatch is source-available under the
[Auditable Commercial License (ACL) v1.0](https://www.auditablelicense.org/) —
read, run, and modify it for your own use; no redistribution or hosted-service
offerings. Each released version automatically converts to Apache 2.0 four
years after its release. See [LICENSE.md](LICENSE.md) for the full terms.
