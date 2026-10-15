## What this changes

<!-- One or two lines. Link the issue it fixes, if there is one: Fixes #123 -->

## How it was tested

<!-- What you ran, and on which terminal and OS. For anything visual, add a screenshot or a short recording. -->

## Checklist

- [ ] Edited the modules in `hooks/`, not `hooks/bundle.tsx`, then ran `node tools/bundle.mjs`
- [ ] `npx -p typescript tsc -p .` passes
- [ ] `npx --yes @biomejs/biome@1.9.4 lint hooks tests types tools` passes
- [ ] `claude plugin validate .` and `claude plugin test .` pass
- [ ] No build output committed (no `.js` files next to the `.ts` files in `hooks/` or `tests/`)
