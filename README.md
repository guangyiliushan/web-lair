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
pnpm ops jobs dev   # terminal 2 - the worker (3s tick)
```

`pnpm ops jobs dev` is the same drain tick on a loop; it never overlaps two ticks,
prints only the ticks that did something, and stops cleanly on Ctrl+C.

- `pnpm ops jobs drain` runs a single tick instead of a loop.
- `pnpm ops jobs dev --interval 1000` polls faster while debugging.
- Both use `--env-file=.env`, so provider keys (`AI_DEEPSEEK_KEY`, …) reach the
  job exactly like they do from the production timer.

## Ops CLI

运维命令不在 `package.json` 里，也不再一个命令一个 alias。唯一入口是
`bin/lair`，清单在 `scripts/manifest.ts`：

```sh
pnpm ops                          # 分组帮助
pnpm ops db                       # 单组帮助
pnpm ops db verify-baseline       # 执行；参数原样透传
pnpm ops storage migrate --print  # 只打印将执行的命令行
pnpm ops deploy post              # 部署后置钩子（迁移 → 校验 → 幂等修复）
```

容器内没有 pnpm/tsx，所以部署脚本与 RUNBOOK 用 `node bin/lair <group> <cmd>`。
清单里 `runtime=tsx` 的命令会触达 `$lib`，只能在装有 devDependencies 的宿主机执行；
`node scripts/check-entries.ts` 校验清单、文件、部署钩子、文档与 `package.json`
五方一致，CI 在构建前跑它。

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.
