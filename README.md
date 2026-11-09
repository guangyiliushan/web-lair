# sv

Everything you need to build a Svelte project, powered by [`sv`](https://github.com/sveltejs/cli).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project
npx sv create my-app
```

To recreate this project with the same configuration:

```sh
# recreate this project
pnpm dlx sv@0.15.3 create --template minimal --types ts --add prettier eslint vitest="usages:unit,component" playwright tailwindcss="plugins:typography,forms" sveltekit-adapter="adapter:auto" drizzle="database:postgresql+postgresql:postgres.js+docker:yes" better-auth="demo:password,github" mdsvex paraglide="languageTags:en, zh-CN, ja+demo:yes" storybook mcp="ide:claude-code,cursor,gemini,opencode,vscode,other+setup:local" --install pnpm web
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Background jobs in development

Anything that only _enqueues_ work — requesting a translation, "generate summary",
running a job from `/admin/jobs` — inserts a `job_runs(status='queued')` row. The
web process never runs it: in production a systemd timer starts
`node jobs/drain.ts` once a minute (`deploy/systemd/web-lair-drain.timer`).

`vite dev` has no timer, so in development run the worker in a second terminal:

```sh
pnpm dev        # terminal 1 - the app
pnpm jobs:dev   # terminal 2 - the worker (3s tick)
```

`jobs:dev` is the same drain tick on a loop; it never overlaps two ticks,
prints only the ticks that did something, and stops cleanly on Ctrl+C.

- `pnpm jobs:drain` runs a single tick instead of a loop.
- `pnpm jobs:dev --interval 1000` polls faster while debugging.
- Both use `--env-file=.env`, so provider keys (`AI_DEEPSEEK_KEY`, …) reach the
  job exactly like they do from the production timer.

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.
