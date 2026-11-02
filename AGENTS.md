# Agent notes

## Workflow
- Always commit your changes with a descriptive message after making a code change — don't wait to be asked.
- Keep the build green before committing: `npm run build` (runs `npm run typecheck` + `vite build`).

## Deployment
- Vercel auto-deploys on push to `main`. Pushing is the user's step: `git push origin main`.
