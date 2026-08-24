# Repository Guidelines

## Project Structure & Module Organization

- `entrypoints/`: WXT entrypoints for the background worker, side panel, options page, and extractor test page.
- `src/domain/`: shared contracts and errors.
- `src/application/`: summary orchestration and task state.
- `src/extractors/`: webpage, video, PDF, and discussion-site extraction.
- `src/integrations/`: Kimi, web-session, and OpenAI-compatible providers.
- `src/platform/chrome/`: storage, permissions, and browser-specific helpers.
- `src/shared/`: cross-cutting helpers (logging, abort handling, filename sanitization, image link processing).
- `src/ui/`: React views, components, and shared styles.
- `tests/unit/` and `tests/integration/`: Vitest suites; shared fixtures live in `tests/support/`.
- `public/`: packaged static assets.

Keep provider APIs, extraction logic, and UI concerns within their existing boundaries. Register specialized extractors before the generic webpage fallback.

## Build, Test, and Development Commands

Use the pinned `pnpm@11.9.0` package manager:

```bash
pnpm install       # install dependencies
pnpm dev           # start WXT development mode
pnpm test          # run all Vitest tests once
pnpm test:watch    # run tests interactively
pnpm lint          # run ESLint
pnpm typecheck     # run strict TypeScript checks
pnpm build         # create the production extension
pnpm check         # lint, typecheck, test, and build
pnpm zip           # create a distributable archive
```

When `pnpm` is unavailable, use `corepack pnpm <command>`.

## Coding Style & Naming Conventions

Follow the existing TypeScript style: two-space indentation, double quotes, semicolons, and trailing commas in multiline structures. Use `camelCase` for functions and variables, `PascalCase` for classes/components/types, and kebab-case filenames such as `task-state.ts`. ESLint uses the recommended JavaScript and TypeScript rules; intentionally unused parameters must begin with `_`.

## Testing Guidelines

Vitest test files use `*.test.ts`. Add focused unit tests beside the affected subsystem and integration tests for cross-layer workflows. Mock browser and provider boundaries rather than real credentials or live services. There is no numeric coverage threshold; behavioral regressions and failure paths should be covered. Run `pnpm check` before submitting.

## Commit & Pull Request Guidelines

History follows Conventional Commit-style prefixes such as `feat:`, `fix:`, `refactor:`, and `docs:`. Keep commits scoped and imperative. Pull requests should explain behavior changes, list verification commands, link relevant issues, and include screenshots for side-panel or options-page changes. Update architecture or manual QA docs when contracts or browser workflows change.

## Security & Configuration

Never commit tokens, cookies, `.env` files, Chrome profiles, source maps, captured page content, model output, or unredacted network traces. Preserve optional host-permission boundaries and keep session credentials in the documented Chrome storage keys or request-local memory.
