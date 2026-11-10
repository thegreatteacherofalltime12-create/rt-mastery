# Deploying RT Mastery

Everything here runs on free tiers. No credit card is required for either service.

| Service | Free allowance | What this app uses |
|---|---|---|
| Cloudflare Workers | 100,000 requests/day; static assets unmetered | A class of 30 will not come close |
| Firebase Firestore (Spark) | 50k reads / 20k writes / 1 GiB per day | One write per completed round, one read per dashboard load |

Writes are deliberately batched per round rather than per answer — that is what keeps this inside
the free tier.

---

## 1. Firebase — project `DojoMojo`

1. Open the [Firebase console](https://console.firebase.google.com/) and select the **DojoMojo**
   project.
2. **Build → Firestore Database → Create database.** Pick **production mode** and a region close to
   you (`nam5` is fine for the US).
3. Leave the security rules locked down. The browser never talks to Firestore directly — only the
   Worker does, using a service account, which bypasses rules. Locked rules are correct here.
4. **Project settings → Service accounts → Generate new private key.** This downloads a JSON file.

   > Keep this file out of the repo. `.gitignore` already excludes common key patterns, but do not
   > save it inside the project folder at all.

From that JSON you need three values:

| JSON field | Used as |
|---|---|
| `project_id` | `FIREBASE_PROJECT_ID` |
| `client_email` | `FIREBASE_CLIENT_EMAIL` |
| `private_key` | `FIREBASE_PRIVATE_KEY` |

If `project_id` is not literally `dojomojo`, update the value in `wrangler.toml`.

---

## 2. Cloudflare

```bash
npm install
npx wrangler login
```

That opens a browser to authorise. A free Cloudflare account is enough.

Set the secrets:

```bash
npx wrangler secret put FIREBASE_CLIENT_EMAIL
npx wrangler secret put FIREBASE_PRIVATE_KEY
```

For `FIREBASE_PRIVATE_KEY`, paste the **entire** value including the
`-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines. The Worker handles both real
newlines and the `\n` escapes that appear in the JSON file.

There is no instructor PIN. The dashboard was gated by one until 2026-11-06; it now opens for
anyone who has the address, which is a deliberate choice — see **The dashboard is open** below.

One more, for the dashboard's **Message Project Manager** tab (the instructor's line to Matt's
Admin Hub):

```bash
npx wrangler secret put HUB_KEY
```

Paste this app's project key from the Admin Hub's own setup. It stays on the Worker: the dashboard
talks only to this Worker, which calls the hub itself. Until it
is set, the tab says "not connected yet" and everything else works as before. The tab costs no
Firestore reads or writes.

---

## 3. Deploy

```bash
npm run deploy
```

This builds `dist/` and pushes the Worker. You get a URL like:

```
https://rt-mastery.<your-subdomain>.workers.dev
```

That is the link to give students. The dashboard is at `/dashboard.html` on the same URL.

Check it is wired up:

```bash
curl https://rt-mastery.<your-subdomain>.workers.dev/api/health
```

---

## 4. Give it to the class

1. Pick a class code, e.g. `RT101`.
2. Send students the link and the code. That is all they need — no accounts, no install.
3. Open `/dashboard.html`. It finds the class itself; there is nothing to type.

Students who skip the class code still get the full game; their progress just stays on their own
device and will not appear on your dashboard.

---

## The dashboard is open

There is no instructor sign-in. `/dashboard.html` opens for anyone who reaches it, and the same
is true of the routes behind it: `/api/classes`, `/api/class`, `/api/grant` and `/api/setup` all
answer without credentials. A PIN gated them until 2026-11-06; it was removed deliberately, to
get an instructor straight to her class without typing anything.

Know what that means before copying this setup. Anyone with the address can read the roster -
student names, progress, weakest topics, exam scores - and can hand out tokens or open the second
half of the semester. The addresses are not published or linked from the student page, so in
practice it is the obscurity of the URL that keeps it quiet, and a URL is not a secret: it travels
in shared screens, bookmarks and chat messages.

If you need it closed again, the PIN it used to use is in the history of this repo
(`git log -- worker/index.js`, around 2026-11-06); `pinOk` and its call sites are what to restore.
## Local development

```bash
npm run dev
```

Serves at `http://localhost:5173` with a stubbed `/api/progress` that logs to the console, so the
sync path can be tested without deploying.

To test against the real Worker locally:

```bash
npm run preview     # wrangler dev
```

Create a `.dev.vars` file (already gitignored) for local secrets:

```
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
HUB_KEY=...
```

`node test/live-server.mjs` needs none of this: it runs the real Worker against a fake Firestore
and a fake Admin Hub, so the dashboard and its message tab can be tried without any setup.

---

## No-server fallback

If deployment is ever blocked or you need something immediately:

```bash
npm run build
```

`dist/standalone.html` is the entire game in one self-contained file — no server, no network. It can
be emailed, uploaded to Canvas, or opened from a USB stick. Progress saves to that browser only and
does not reach the dashboard.

---

## Troubleshooting

**`token exchange failed: 400`** — the private key is malformed. Re-run
`wrangler secret put FIREBASE_PRIVATE_KEY` and paste the whole PEM block, including both header
lines.

**`firestore write failed` / 403** — the Firestore database has not been created yet (step 1.2), or
`FIREBASE_PROJECT_ID` in `wrangler.toml` does not match the service account's project.

**Dashboard shows no class** — it lists classes from `/api/classes`, which only returns a class once
a student has played in it. An empty roster means nobody has started yet, not a broken dashboard.

**Message tab says `not connected yet`** — `HUB_KEY` was never set on this Worker. Run
`wrangler secret put HUB_KEY`. If it says the hub "did not recognise this app", the key is set but
does not match the one the Admin Hub holds for RT Mastery.

**Students' progress is not appearing** — they must enter a class code on the welcome screen, and it
must match the one you type into the dashboard. Codes are normalised to lowercase with dashes, so
`RT 101` and `rt-101` are the same class.
