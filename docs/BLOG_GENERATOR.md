# Blog generator

Daily job that writes one post for the Turbo Station blog. Runs as a pm2
`cron_restart` (`0 10 * * *` UTC), does one pass and exits — `stopped` is its
normal resting state, not a failure.

- Service: `services/blog-generator.js`
- Store: `services/blog-api.js` on `127.0.0.1:3300`, SQLite at `db/blog.db`
- Consumer: `next/app/blog/**` in the `turbo_station` repo (see the
  `next-public-pages` note in that repo's vault for the rendering/SEO half)
- Logs: `logs/blog-generator-out.log`

## Pipeline

1. **Config gate** — `GET /config`; `enabled: 0` skips the day.
2. **Once-a-day guard** — skips if `gen_runs` already has a `published`/`held`
   row for today. `--force` overrides.
3. **Topic** — see below.
4. **Write → review** — `claude -p` writes, a second adversarial `claude -p`
   editor either approves or **holds the day**. Two attempts, then it gives up
   and publishes nothing. A hold is a healthy outcome, not a bug.
5. **Cover** — `generateCoverImage()` shells out to the higgsfield CLI. Strictly
   **fail-soft**: any error returns null and the post is created text-only.
6. **Store** — posted as a draft unless `config.autopublish` is on, and the topic
   is written to the `covered_topics` ledger.

## Topic discovery

Two sources, in order:

1. **`SEED_TOPICS`** — a hand-picked list in the service, taken in order because
   these are the highest-value queries we know of. Deduped against
   `covered_topics` by slug.
2. **`pickTopic()` → `topicDiscoveryPrompt()`** — once every seed is covered, the
   model proposes 8 new topics. It sees the covered *titles* (not just slugs) so
   it can avoid paraphrases that would slugify differently but answer the same
   question. `parseTopicCandidates()` treats the reply as untrusted: non-strings
   dropped, whitespace normalised, length capped, slug-collisions collapsed.

`--topic "<tema>"` bypasses both.

> **Why this exists.** Discovery used to be the seed list and nothing else. When
> the last seed was covered the job logged `backlog exhausted` and exited — every
> day from **2026-07-27 to 2026-08-19**. 24 days, no post, no alert, and nobody
> noticed until someone asked why the blog had stopped. If you change this path,
> keep the property that a normal day can never end in "no source of topics".

Only a genuinely empty discovery result records
`gen_runs.status = 'skipped', reason = 'no_topic_available'`. Seeing that reason
on consecutive days means discovery itself is broken (model erroring, or every
proposal already covered) and is worth investigating.

## Internal links: code decides, the editor does not

Whether `/blog/<slug>` exists is a **fact**, not a judgement call, so
`sanitizeInternalLinks` decides it deterministically and runs **before** the
editor. Every internal link that reaches the editor is therefore valid by
construction, and the editor prompt explicitly says so.

The operator-triggered `--revise` path loads the published-slug set and applies
the same sanitiser before both editor review and storage. If that lookup fails,
blog links fail closed and are unwrapped instead of being trusted.

It used to police this too, and it was worse at it: the writer prompt tells the
model to link 1-2 published posts, the editor prompt rejected "rotas
inexistentes (as únicas válidas são /, /blog e /#contato)", and the two
contradicted each other. Once dynamic topic discovery started producing posts
again, that held **two consecutive days** (2026-08-21 and 2026-08-22) over links
to posts that exist.

Rules:

- **`VALID_STATIC_ROUTES` is the allowlist of non-blog routes**, and it is
  verified against production: `/`, `/blog`, `/faq`, `/#contato`,
  `/parceiro/ganhe-com-estacoes`. `/contato`, `/sobre` and `/estacoes` are 404.
  Add a route only after confirming it serves 200.
- The sanitiser covers **all** internal links, not just `/blog/`. It used to only
  look at `/blog/`, so an invented `/contato` sailed through it.
- Relative internal destinations are canonicalised to root-relative paths
  before validation (`faq` becomes `/faq`); invalid relatives are unwrapped.
  Schemed and protocol-relative external links are preserved unchanged.
- Only the bare canonical post path counts. A trailing slash, a query or an
  extra segment gets unwrapped, on purpose: only the exact path is provably real.
- External links and images are untouched.
- **Never reintroduce a route check into the editor prompt.** There is a test
  asserting the old string does not come back.

## Content bar enforced in the prompts

The writer prompt and the editor prompt must stay in sync — the editor rejects
what the writer is told to avoid. Current bar:

- 1400-1800 words (editor rejects under ~1200)
- at least 2 question-shaped `##` headings answered by a self-contained
  paragraph, which is what the article route turns into `FAQPage` schema
- at least one external source named (ANEEL, Inmetro, ABVE, the state Detran,
  the manufacturer's manual); no invented numbers, laws or deadlines
- **no `- **Lead-in.** explanation` bullets** and at most one "não é X, é Y"
  antithesis — the two most recognisable AI tells in the published posts
- no closing "Resumo"/"Conclusão" section that just restates the article
- no em dash anywhere (`stripDashes()` is the safety net)
- home charging and public/destination charging are complementary, never rivals

## Operational notes

- **The higgsfield CLI loses its credentials silently.** `~/.config/higgsfield/credentials.json`
  disappears, `higgsfield account status` starts exiting non-zero, and because
  cover generation is fail-soft every post from then on is created with no cover
  and no error anywhere. Re-auth with `higgsfield auth login` (interactive device
  login), then backfill with `--regen-cover <slug>`.
- **Nothing publishes itself** while `config.autopublish = 0`. Drafts wait for
  the Publicar button on `/dashboard/settings/blog`.
- Useful flags: `--dry`, `--force`, `--topic <tema>`, `--revise <slug>`,
  `--humanize <slug>`, `--regen-cover <slug>`.

## Tests

```bash
npm run test:blog     # node --test test/test-blog-topic-discovery.js
```

Covers the parser against malformed model output, seed-before-discovery
ordering, dedup against the ledger, and the failure modes that must return
`null` rather than throw (the daily job has to record a skip, not lose the run).
