# Generated better-auth schema — do not edit

`src/lib/server/db/auth.schema.ts` is **generated output**, not source. It is
produced by:

```bash
pnpm auth:schema   # npx auth@1.7.5 generate --config src/lib/server/auth.ts --output src/lib/server/db/auth.schema.ts --yes
pnpm format        # the generated file is Prettier-formatted before commit
```

The tables it declares (`user`, `session`, `account`, `verification`,
`two_factor`, `passkey`, `organization`, `member`, `invitation`) are owned by
the library. Its next upgrade, its migrations and its recovery flows assume the
schema it generates. Hand edits silently break those assumptions.

## Change workflow

1. Upgrade better-auth (or change `src/lib/server/auth.ts`).
2. `pnpm auth:schema` — regenerate the file. Do not patch it by hand.
3. `pnpm format`, then review the diff like any other code change.
4. `pnpm db:generate --name <change>` for the migration, and review the SQL.
5. Commit the generated schema **and** the migration together.
6. `pnpm auth:check` must be green.

## Application fields on an auth table

Declare them in `auth.ts` with the official option, never in the generated file:

```ts
user: {
  additionalFields: {
    defaultLang: { type: 'string', required: false, input: false }
  }
}
```

`additionalFields` is part of the library's model, so regeneration reproduces
the column. `input: false` keeps the field server-managed; the app reads and
writes it through its own service.

## Allowed official options that change DATA FORMAT only (H2)

These change what is stored inside a column, never the schema. They are the
only two exceptions allowed by the secrets decision register (§0.1, H2-A):

| Option                             | Effect                                                                                                                                                                                                               | Rollback                                                                                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account.encryptOAuthTokens: true` | OAuth access/refresh/id tokens are stored as `$ba$<version>$<hex>` envelopes (XChaCha20-Poly1305) instead of plaintext. Legacy plaintext rows keep working and are rewritten on the next sign-in/refresh.            | Turning it off makes old ciphertext unreadable by the API (tokens must be re-issued by signing in again, or restore a pre-encryption dump). Keep it on; rotate the keyring instead. |
| `BETTER_AUTH_SECRETS`              | Versioned keyring for the auth secret: `"2:<new>,1:<old>"`, newest first. New writes use the first entry; `$ba$1$…` stays readable while version 1 remains listed. It also keys session cookies/JWT and 2FA secrets. | Removing a version makes values written under it unreadable (fail-closed). Rotate forward: prepend a new version, wait, then retire the old one (RUNBOOK §3.1).                     |

`verification.storeIdentifier` is registered as a later option; it is not
enabled. Everything else that changes storage semantics is out of bounds.

## Exclusions (H3): never do these

- Hash the session token ourselves, or wrap the adapter to do it.
- Hash backup codes ourselves, or replace the two-factor plugin's storage.
- Write a custom 2FA `challenge` hook that bypasses the plugin's gate.
- Hand-edit this file or a generated auth table (columns, indexes, constraints,
  triggers).

`pnpm auth:check` fails on the first two structural cases (migration SQL and
source customization). The last two are reviewed by the drift check and by the
migration scan; a hand edit to this file is reported as drift.

## CI

`.github/workflows/auth-schema.yml` runs both guards:

```bash
pnpm auth:check:migrations   # SQL scan + H3 source scan (no network, no CLI)
pnpm auth:check              # regenerates to a temp file and diffs
```

A failed run means: regenerate with `pnpm auth:schema`, or revert the migration
statement that touched an auth table. The baseline (`drizzle/0000_baseline.sql`)
is the generated initial schema and is exempt from the SQL scan; every later
migration is checked.
