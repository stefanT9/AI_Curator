---
starter_id: next
package_manager: npm
project_name: artswipe
hints:
  language_family: js
  team_size: solo
  deployment_target: vercel
  ci_provider: github-actions
  ci_default_flow: auto-deploy-on-merge
  bootstrapper_confidence: verified
  path_taken: custom
  quality_override: false
  self_check_answers:
    typed: true
    from_official_starter: false
    conventions: true
    docs_current: false
    can_judge_agent: false
  has_auth: true
  has_payments: false
  has_realtime: false
  has_ai: true
  has_background_jobs: true
---

## Why this stack

Read this before acting on it: ArtSwipe is brownfield. The PRD describes an AI
enrichment change to a Next.js 16 + Supabase app that already runs on Vercel with
green CI, so this hand-off confirms the stack in place rather than proposing a new
one. Do not scaffold over the working tree. A solo developer, a three-week window,
and an explicit avoid on replacing Next.js reduced the JS candidate set to one real
option: Astro, Vite, Vue and SvelteKit all fail the avoid, and T3 keeps Next.js only
by trading Supabase auth and Postgres for NextAuth and Drizzle. Next.js clears all
four agent-friendly gates, is the registry's most bootstrapper-confident JS card, and
defaults to Vercel, matching the live deployment. Auth, AI and background work are in
scope; payments and realtime are PRD non-goals. The five-point self-check returned
three not-true, including recognising stack-inconsistent agent output. No quality gate
was overridden; the compensation is AGENTS.md, which already pins Next.js 16 docs and
flags the version traps.
