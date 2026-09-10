# Ranking evaluation corpus — seed workflow

This directory holds the card images for the ranking evaluation corpus. The
corpus itself is authored in [`../seed.sql`](../seed.sql).

> **In progress — this document describes the corpus as it is being replaced.**
> The images are no longer committed placeholders: they are ~1000 real
> public-domain artworks fetched from the Art Institute of Chicago by
> `npm run db:seed:fetch`, pinned in [`corpus.json`](corpus.json), and
> **gitignored**. A fresh clone therefore has an empty image directory until
> that command is run once.
>
> ```bash
> npm run db:seed:fetch   # one-time after a clone; re-run tops up, never restarts
> npm run db:reset        # per-reset, as before
> ```
>
> `seed.sql` is not yet regenerated from the manifest — that is Phase 4 of the
> `real-artwork-corpus` change — so until then `db:reset` seeds rows that point
> at the deleted placeholders. The full rewrite of this file lands with Phase 4.

## Local development only

The corpus is for the **local development database only**. It writes directly
into `auth.users` / `auth.identities` and seeds three accounts that share one
weak password. It must **never** be run against a linked or production project.

## The whole workflow, in one command

With the local stack running:

```bash
npm run db:reset
```

That is `supabase db reset` followed by `npm run db:seed:images`. Both halves are
required — the sections below say why, and either can be run on its own.

## Applying the corpus

`supabase/seed.sql` is not a migration. It is applied automatically at the end
of `supabase db reset`, after every migration:

```bash
npx supabase db reset
```

## Uploading the images

`seed.sql` is pure SQL and cannot create Storage objects, so the placeholder
images are a separate step:

```bash
npm run db:seed:images
```

which runs:

```bash
npx supabase storage cp --experimental --local -r \
  supabase/seed-assets/00000000-0000-4000-8000-000000000001 \
  ss:///artworks/00000000-0000-4000-8000-000000000001
```

The directory is named after the seeded artist's UUID, so this uploads each PNG
to exactly the `image_path` the seed rows reference. The whole `supabase storage`
command group is gated behind `--experimental` and refuses to run without it.

Verify the upload:

```bash
npx supabase storage ls --experimental --local ss:///artworks/00000000-0000-4000-8000-000000000001
```

## Re-run the upload after every reset

`supabase db reset` clears Storage objects along with the database. The image
upload is therefore **part of the reset workflow, not one-time setup** — which is
exactly why `db:reset` chains the two. If you run `npx supabase db reset` by hand,
run `npm run db:seed:images` after it, or the corpus renders as broken images.

## Seeded logins

All three share the password `seedpassword`:

| Role           | Email                                |
| -------------- | ------------------------------------ |
| Artist         | `seed-artist@artswipe.local`         |
| Warm collector | `seed-collector-warm@artswipe.local` |
| Cold collector | `seed-collector-cold@artswipe.local` |

The warm collector carries eight likes, all in the Blue abstraction cluster. The
cold collector has no likes. See
[`judgment.md`](../../context/changes/ranking-eval-corpus/judgment.md) for how to
use these to judge a tag-match ordering.
