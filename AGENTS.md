# Repository Guidelines

## Project Structure & Module Organization

This is a Bun-based TypeScript monorepo. Apps live in `apps/`: `electron` is the primary desktop client, `cli` contains command-line entry points, and `viewer`/`webui` are Vite frontends. Shared packages live in `packages/`: `shared` holds most agent, source, config, and session logic; `server-core` and `server` run the backend; `session-tools-core` defines agent tools; `ui` contains reusable React components. Static and tool assets are mostly under `apps/electron/resources` and `apps/viewer/public`. Tests sit next to code in `__tests__/` folders or as `*.test.ts`; document-tool smoke tests are Python files in `apps/electron/resources/scripts/tests/`.

## Build, Test, and Development Commands

- `bun install`: install workspace dependencies.
- `bun run electron:dev`: run the desktop app in development mode.
- `bun run server:dev`: run the backend with debug settings.
- `bun run typecheck:all`: typecheck all main packages and apps.
- `bun test`: run the default Bun test suite.
- `bun run test:shared:all`: run focused shared-package tests.
- `bun run test:doc-tools`: run Python smoke tests for document tooling.
- `bun run validate:dev`: run typechecks plus shared and document-tool tests.
- `bun run lint`: run repository lint checks.

## Coding Style & Naming Conventions

Use TypeScript and ESM modules. Follow the existing local style: 2-space indentation, descriptive names, and no unnecessary comments. Keep provider-specific logic behind `@craft-agent/shared/agent/backend`; do not import Claude or Pi backends directly from Electron main code. In UI code, use existing styled wrappers and design tokens; lint rules reject raw Radix dropdown imports, hardcoded z-index values, and nonstandard shadow utilities.

## Testing Guidelines

Prefer small Bun tests close to the code they cover, named `*.test.ts` or placed in `__tests__/`. Add or update the narrowest test that would fail for the bug or behavior you changed. For document conversion scripts, use the Python unittest smoke tests and run `bun run test:doc-tools`.

## Commit & Pull Request Guidelines

Use clear, descriptive commit messages; a short prefix such as `docs:`, `fix:`, or `refactor:` is useful when it clarifies scope. Branch names should follow the existing pattern: `feature/add-new-tool`, `fix/resolve-auth-issue`, `refactor/simplify-agent-loop`, or `docs/update-readme`. Pull requests should include a summary, the reason for the change, testing performed, linked issues when relevant, and screenshots for UI changes.

## Security & Configuration Tips

Copy `.env.example` to `.env` for local credentials and never commit secrets. Keep permission, source-auth, path, and platform checks centralized; existing ESLint rules intentionally guard those boundaries.
