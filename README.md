This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Admin accounts

Sign-in is email/password via Supabase Auth (`signInWithPassword`). There is
no self-service signup and no automated password-reset-by-email — both are
deliberate, to avoid depending on Imperial's mail deliverability (see
`specs/attendance-payment-chasing/tasks.md`, Backlog). Admin access is
additionally gated by the `admin_allowlist` table — having a Supabase Auth
account alone isn't enough; the account's email must also be on that list.

**Creating a new admin account:**

```bash
node scripts/create-admin.ts someone@ic.ac.uk
```

Requires `SUPABASE_SECRET_KEY` and `NEXT_PUBLIC_SUPABASE_URL` in `.env.local`.
This creates the Supabase Auth user (pre-confirmed, no confirmation email)
and adds the email to `admin_allowlist`. It prints a randomly generated
password once — share it out-of-band (in person, group chat), **never by
email**. If you need to re-run this for an email that already has an
account, it will fail; use the dashboard instead (see below).

**Resetting a forgotten password / re-provisioning an existing account:**

There is no in-app flow for this — do it manually via the Supabase
dashboard: **Authentication → Users**, find the account, use the "..." menu
to reset the password, then share the new password with that admin
out-of-band.

**Removing admin access:**

Delete the row from `admin_allowlist` (via the dashboard's SQL editor or
Table Editor). This takes effect immediately, on their very next request —
`requireAdmin()` re-checks the allowlist on every call, not just at login —
without needing to also delete or disable their Supabase Auth account.

## Mock data

`scripts/seed-mock-data.sql` seeds a realistic dataset for exploring the UI:
products, 5 sessions (past + one upcoming), 12 people covering the interesting
cases (a free-trial-only newcomer, ordinary unpaid debt, debt waived by a
session pass, debt covered by a term pass, an exempt member, a provisional
walk-in identity, an unmatched purchase for the manual-match queue), and a
run of the real chase-email generator on top of it. Safe to re-run — every
row has a fixed UUID and every statement is `ON CONFLICT`-safe. Run it via
the Supabase SQL editor or `mcp__supabase__execute_sql`.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
