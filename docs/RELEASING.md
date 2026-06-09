# Releasing brownbot publicly

This branch makes the **working tree** clean of personal data. It does **not** clean
git history — the owner's data still lives in older commits reachable from `main`.
Publishing this repo as-is would leak that history. Do one of the two below.

> Rule of thumb: never `git push` this repo's existing history to a public remote.
> Publish a fresh tree instead.

---

## Option A — Fresh public repo from a clean tree (recommended)

Simplest and safest. You get a brand-new repo whose entire history is one commit
containing exactly today's clean files. Nothing personal can leak because no old
commit is carried over.

```bash
# 0. Start from the merged, anonymized state.
git checkout main && git pull          # after this branch's PR is merged

# 1. Make an orphan branch — no parent, no history.
git checkout --orphan public
git add -A
git commit -m "Initial public release"

# 2. Sanity check: there must be exactly ONE commit, and zero personal data.
git log --oneline                      # expect a single line
git grep -niE 'manav|indira|thaker|brownmanbrain|indiralondono' -- . ':!*example*' || echo "clean"
#   (the only allowed hit is the github.com/manavpthaker/brownbot URL in README)

# 3. Create the empty public repo on GitHub (no README/license/gitignore), then:
git remote add public git@github.com:<you>/brownbot.git   # the NEW public repo
git push public public:main

# 4. Done. Delete the local orphan branch when you're satisfied.
git checkout main && git branch -D public
```

Before flipping the repo to public, also confirm:
- `.env`, `config/profile.json`, `*.db`, and the generated `context/` files are **not**
  tracked (they're gitignored — `git ls-files | grep -E '\.env$|profile\.json$|\.db$'`
  must be empty).
- No `mcp-servers.json` with live tokens is committed (`git ls-files | grep mcp-servers`).
- GitHub → repo → Settings → **Secret scanning** is on after you publish.

---

## Option B — Rewrite history in place (only if you must keep commit history)

Use this only if the commit history itself has value worth preserving. It's slower,
riskier, and every collaborator must re-clone afterward. Use
[`git-filter-repo`](https://github.com/newren/git-filter-repo) (not `filter-branch`).

```bash
pip install git-filter-repo
git clone --mirror git@github.com:manavpthaker/brownbot.git brownbot-scrub
cd brownbot-scrub

# 1. Drop files that only ever held personal data, across ALL history.
git filter-repo --invert-paths \
  --path context/shared/milo-mp-profile.md \
  --path context/seeds/milo-facts.json \
  --path-glob 'context/admin/*' \
  --path-glob 'context/personal/*' \
  --path-glob 'context/finance/*' \
  --path-glob 'context/job-search/*' \
  --path-glob 'context/grapevines/*' \
  --path-glob 'context/health/*' \
  --path SECOND-BRAIN-ROADMAP.md --path BUILDDOC.md --path TIER1-PLAN.md

# 2. Redact remaining strings (names, paths, emails) from surviving blobs.
cat > /tmp/replacements.txt <<'EOF'
Manav==>the owner
Indira==>the partner
Milo==>the assistant
brownmanbrain==>YOUR_USERNAME
indiralondono@gmail.com==>partner@example.com
EOF
git filter-repo --replace-text /tmp/replacements.txt

# 3. Verify NOTHING personal survives anywhere in history:
git grep -niE 'manav|indira|thaker|brownmanbrain|indiralondono' $(git rev-list --all) || echo "clean"
```

Then push the rewritten history to a **new** remote (don't force-push over a repo
others have cloned), rotate any credential that ever touched a commit, and have
everyone re-clone.

**Caveat:** Option B is only as good as the replacement list. A name in a commit
message, a screenshot, or a path you forgot will survive. Option A can't have that
problem because it starts from zero history — which is why it's the default.

---

## After publishing (either option)

1. **Rotate every secret** that was ever in a tracked file or a commit you're unsure
   about: `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, Google OAuth client/refresh tokens,
   `LINKEDIN_SESSION_COOKIE`, Supabase keys, `BROWSER_BRIDGE_TOKEN`. History scrubs
   don't un-leak a key that was already pushed somewhere.
2. Turn on **Secret scanning** and **Push protection** in repo settings.
3. Update the launch content's repo link if the public repo lives at a new path.
4. Smoke-test the published tree on a clean machine: `npm install && npm run onboard:dry`.
