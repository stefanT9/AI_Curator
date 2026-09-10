# Ranking evaluation corpus — seed workflow

This directory holds the placeholder card images for the ranking evaluation
corpus (roadmap **F-01**). The corpus itself is authored in
[`../seed.sql`](../seed.sql).

## Local development only

The corpus is for the **local development database only**. It writes directly
into `auth.users` / `auth.identities` and seeds three accounts that share one
weak password. It must **never** be run against a linked or production project.

## Applying the corpus

`supabase/seed.sql` is not a migration. It is applied automatically at the end
of `supabase db reset`, after every migration:

```
npx supabase db reset
```

## Uploading the images

`seed.sql` is pure SQL and cannot create Storage objects, so the placeholder
images are a separate step. With the local stack running:

```
npx supabase storage cp --local -r \
  supabase/seed-assets/00000000-0000-4000-8000-000000000001 \
  ss:///artworks/00000000-0000-4000-8000-000000000001
```

The directory is named after the seeded artist's UUID, so this uploads each PNG
to exactly the `image_path` the seed rows reference.

Verify the upload:

```
npx supabase storage ls ss:///artworks/00000000-0000-4000-8000-000000000001
```

## Re-run the upload after every reset

`supabase db reset` clears Storage objects along with the database. The image
upload is therefore **part of the reset workflow, not one-time setup** — re-run
the `storage cp` command above after every `db reset`, or the corpus renders as
broken images.

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
