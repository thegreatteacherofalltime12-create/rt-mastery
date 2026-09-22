# RT Mastery

A mastery-based study game for a **Therapeutic Recreation** course at Lindenwood University.

Students were handed flashcards and retained almost nothing — flashcards let you *recognise* an answer
without *knowing* it, and there is no consequence for guessing. RT Mastery replaces recognition with
retrieval: every question must be answered correctly three separate times before it locks in, and
missing one knocks it back down so it returns almost immediately.

In deployment it carries **229 questions** across five chapters, authored from the course material —
142 of them flagged as likely exam questions.

> **On content:** the course question banks are the instructor's material and are kept private. This
> repository contains the engine, the infrastructure, and a sample chapter (`content/ch-example.json`)
> that demonstrates all six question types — so the project builds, runs, and is playable the moment
> you clone it. Drop your own `content/ch*.json` files in and they are picked up automatically.

```
Phone-first web app  ·  No login, no app install  ·  Free to run
```

---

## What it does

| | |
|---|---|
| **Mastery map** | Five chapter "zones", all open from the start. Each shows live mastery and is marked cleared at 80%. |
| **Spaced repetition** | Leitner boxes — right answers promote a question, a wrong answer drops it two boxes so it comes straight back. |
| **Six question types** | Multiple choice, select-all, matching, ordering, fill-in-the-blank, and clinical scenarios. Choices are shuffled every time, so position can't be memorised. |
| **Final boss** | 25 questions, all chapters, 15 minutes, no feedback until the end. Unlocks only at 80% across the board. |
| **Exam prep** | Timed runs scoped to whatever an upcoming exam covers. Configured by the instructor in one JSON file. |
| **Weak-topic tracking** | The app surfaces each student's weakest topics, and the dashboard rolls that up across the whole class. |
| **Instructor dashboard** | Who has studied, how far they've got, best exam score, and what the class as a whole is failing — so it can be re-taught. |

Students identify themselves with a name and a class code. No accounts, no passwords, no barrier
between opening the link and answering the first question.

---

## Architecture

```
┌──────────────────────┐
│  Browser (phone)     │  vanilla JS, no framework, no build step for the app itself
│  · game engine       │  progress mirrored to localStorage so it works offline
│  · localStorage      │
└──────────┬───────────┘
           │  POST /api/progress   (one batched write per completed round)
           ▼
┌──────────────────────┐
│  Cloudflare Worker   │  serves dist/ as static assets (unmetered on the free plan)
│  · RS256 JWT signing │  mints a Google service-account token with Web Crypto
│  · /api/progress     │  no Firebase credentials ever reach the browser
│  · /api/class        │  instructor roster, gated by a server-checked PIN
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  Firestore           │  classes/{classCode}/students/{studentId}
└──────────────────────┘
```

**Design decisions worth calling out**

- **Writes are batched per round, not per answer.** A class of 30 doing several rounds a day lands in
  the low hundreds of writes — comfortably inside Firestore's free tier, which a per-answer write
  would blow through.
- **Credentials stay server-side.** The Worker signs a service-account JWT with `crypto.subtle`
  (RS256) and exchanges it for an access token, caching it per isolate. The browser never sees a
  Firebase key, so there are no client-side security rules to get wrong.
- **The game degrades gracefully.** Everything works with no backend at all — the API call is
  fire-and-forget and failures are non-blocking. A student with no class code, no signal, or blocked
  storage still gets the full game.
- **Content is data, not code.** Chapters are plain JSON validated at build time; a typo fails the
  build instead of the game. The instructor can add a chapter or an exam without touching JavaScript.

---

## Running it

```bash
npm install
npm run dev          # build + serve at http://localhost:5173
```

`npm run dev` starts a local server with a stubbed `/api/progress`, so the sync path can be exercised
without deploying anything.

### Build outputs

```bash
npm run build
```

| File | Purpose |
|---|---|
| `dist/index.html` | the game |
| `dist/dashboard.html` | instructor view |
| `dist/standalone.html` | **single self-contained file** — no server needed. Email it, drop it in an LMS, or open it from a USB stick. |

---

## Deploying

See **[DEPLOY.md](DEPLOY.md)** for the full walkthrough. Short version:

```bash
npx wrangler login
npx wrangler secret put FIREBASE_CLIENT_EMAIL
npx wrangler secret put FIREBASE_PRIVATE_KEY
npx wrangler secret put INSTRUCTOR_PIN
npm run deploy
```

Runs entirely on free tiers — Cloudflare Workers (100k requests/day, static assets unmetered) and
Firebase Spark (50k Firestore reads / 20k writes per day). No card required.

---

## Adding content

See **[AUTHORING.md](AUTHORING.md)**. Chapters are JSON files in `content/`; exams are entries in
`content/exams.json`. Run `npm run build` and the validator will tell you about any mistake before
students ever see it.

---

## Project layout

```
content/          chapter question banks + exam definitions (JSON)
src/              game client — index.html, app.js, styles.css, dashboard.html
worker/           Cloudflare Worker: API + Firestore integration
build.js          bundles + validates content, emits dist/
dev-server.js     local static server with a stubbed API
```

---

## Licence

Code is MIT (see [LICENSE](LICENSE)).

Course question banks are the instructor's own material and are not distributed in this repository.
The sample chapter is MIT along with the rest of the code. This project is not affiliated with or
endorsed by Lindenwood University.
