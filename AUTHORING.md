# Adding and editing content

You do not need to touch any JavaScript. Everything students see comes from the JSON files in
`content/`. After any edit, run:

```bash
npm run build
```

The build **validates everything** and refuses to finish if something is wrong — it will name the
exact question and the exact problem. If the build succeeds, the game is correct.

---

## Setting up an exam

Open `content/exams.json` and edit the `exams` list. Each entry becomes its own button in the
game's Exam Prep screen.

```json
{
  "id": "exam-2",
  "name": "Exam 2 — Chapters 6 & 7",
  "date": "2026-10-14",
  "chapters": ["ch6", "ch7"],
  "topics": [],
  "questionCount": 35,
  "minutes": 40,
  "passMark": 80,
  "note": "Focus on active listening and the group stages."
}
```

| Field | What it does |
|---|---|
| `id` | Short unique id. Letters, numbers, dashes. |
| `name` | What students see. |
| `date` | `YYYY-MM-DD`. Shows a countdown ("6 days away"), and turns red inside 3 days. Leave `""` for none. |
| `chapters` | Which chapters to pull from: `ch2`, `ch3`, `ch4`, `ch6`, `ch7`. |
| `topics` | Optional. Narrow to specific topics — use the exact `topic` value from the questions. `[]` means all topics in those chapters. |
| `questionCount` | How many questions in one run. |
| `minutes` | Time limit. `0` for untimed. |
| `passMark` | Percent needed to pass. |
| `note` | Optional message shown before they start. |

**To narrow an exam to specific topics**, use the topic names exactly as they appear on the
questions — for example `"topics": ["Negative reinforcement", "APIE", "Group Stages"]`.

---

## Adding a new chapter

Create `content/ch5.json` (any id works) following this shape:

```json
{
  "id": "ch5",
  "number": 5,
  "title": "Chapter title students see",
  "subtitle": "One line under the title",
  "icon": "book",
  "color": "violet",
  "questions": [ ... ]
}
```

`color` must be one of: `violet`, `emerald`, `sky`, `amber`, `rose`.

Chapters are ordered by `number`. The new chapter slots into the map automatically and is picked up
by exams that list its id.

---

## Question types

Every question needs `id`, `type`, `topic`, `prompt`, and `explain`.

- `id` — unique across the whole game. Convention: `ch5-01`.
- `topic` — the grouping used for weak-topic tracking. Keep these consistent; students see them.
- `explain` — shown after answering. This is where the teaching happens, so make it count.
- `flag: "test"` — optional. Marks it with a ⭐ "Likely test question" badge.

### Multiple choice — `mc`

```json
{
  "id": "ch5-01", "type": "mc", "topic": "Assessment", "flag": "test",
  "prompt": "What is the best source of knowledge about a client?",
  "choices": ["The medical record", "The client themselves", "Family", "The physician"],
  "answer": 1,
  "explain": "The client themselves. Records and family are secondary sources."
}
```

`answer` is the **index** into `choices`, starting at 0. Choices are shuffled at runtime, so the
position students see changes every time.

### Clinical scenario — `scenario`

Identical to `mc`, but framed as a situation. Use it for "what would you do" questions.

### Select all that apply — `multi`

```json
{
  "type": "multi",
  "prompt": "Select ALL signs of bad stress.",
  "choices": ["Tight muscles", "Increased HR", "Lowered blood pressure"],
  "answer": [0, 1],
  "explain": "Blood pressure goes up, not down."
}
```

`answer` is an array of indexes. Students must get the set exactly right.

### Matching — `match`

```json
{
  "type": "match",
  "prompt": "Match each term to its definition.",
  "pairs": [
    ["Reliability", "Results are reproducible over time"],
    ["Validity", "Measures what you need measured"]
  ],
  "explain": "A scale that reads 5 lbs heavy every time is reliable but not valid."
}
```

Each pair is `[term, definition]`. Terms and definitions are both shuffled.

### Ordering — `order`

```json
{
  "type": "order",
  "prompt": "Put the APIE phases in order.",
  "items": ["Assessment", "Planning", "Implementation", "Evaluation"],
  "explain": "Documentation runs throughout — it is not a separate phase."
}
```

List `items` in the **correct** order. The game scrambles them and guarantees they never start
already solved.

### Fill in the blank — `fill`

```json
{
  "type": "fill",
  "prompt": "Physical activity is called nature's ________.",
  "answer": ["tranquilizer", "tranquiliser"],
  "explain": "Nature's tranquilizer — it undoes the biological effects of stress."
}
```

`answer` is a list of every accepted spelling. Matching ignores case, punctuation, and extra spaces,
so you only need genuine alternatives (British spellings, common abbreviations).

---

## Tuning the difficulty

In `src/app.js`, near the top:

```js
var MASTERY_BOX = 3;   // correct answers needed before a question locks in
var UNLOCK_AT = 0.8;   // fraction of a chapter mastered to unlock the next
var SESSION_SIZE = 12; // questions per practice round
```

Lower `MASTERY_BOX` to 2 to make it gentler; raise `UNLOCK_AT` to 0.9 to make it stricter.

---

## A note on one content discrepancy

`ch2-52` covers the PERMA model. The lecture notes list four items — *Positive Emotions,
Relationships, Meaning, Achievement* — while most textbooks list five, adding **E**ngagement.

The question is graded against **the lecture notes**, since that is what the exam follows. The
explanation flags the textbook version so students recognise Engagement if they meet it elsewhere.
If the course later adopts the five-item model, change `answer` and the first choice to include
Engagement.
