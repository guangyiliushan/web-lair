## What changed

<!-- Batch id + one sentence per area. Link the plan section (notes are outside
     git; quote the section id, e.g. "plan §5.2 P1 / T1.1"). -->

## Verification

<!-- Copy the commands and their real exit codes. "Ran the tests" is not a
     verification statement. -->

| Command                                             | Result |
| --------------------------------------------------- | ------ |
| `pnpm check`                                        |        |
| `pnpm lint`                                         |        |
| `pnpm exec vitest run --project server`             |        |
| `pnpm exec vitest run --project client`             |        |
| `pnpm build`                                        |        |
| `deploy/verify-image.sh <tag>` (image changes only) |        |

## Residuals / registered items

<!-- What is deliberately not done, why, and where it is registered. Never leave
     this empty because "nothing" — a batch that changed nothing has no PR. -->

- [ ]

## Safety

- [ ] No secret, token, key or `.env` value appears in the diff, logs or this description.
- [ ] No schema change without the coordination note (`notes/coordination/m6/`) approval.
- [ ] Destructive operations (delete/purge/reset) are called out above with their rollback.
