# Games

RT Mastery is one study engine with several game formats on top of it. This
document records the formats that have been designed, why each one survives a
class of exactly ten, and the honest flaw in each — so that a format is not
rebuilt from scratch, and so that the shared plumbing is designed against real
candidates rather than imagined ones.

**Buy Time** and **The Supply Closet** are built. Everything else is a design, not a
promise.

---

## The rules every format has to obey

These are not style preferences. Each one has already killed or reshaped a
concept.

**1. The class has exactly ten students, and they all know each other.**

Ten is small enough that a plain leaderboard names a specific person as last,
every week, in front of everyone — and that person is by definition the one who
most needs to keep playing. Every format here either has no ranking, ranks
something other than students, or ranks against a private baseline. A format
that cannot do one of those three does not ship.

Ten is also small enough to be an asset: one truth plus nine student-written
lies is exactly a ten-option question, and a ten-person round robin is five
pairings a week with no byes.

**2. Nothing a student gets wrong may cost anybody else anything.**

Scoring is one-sided wherever a shared objective exists. A struggling student
must never be blameable for a group outcome.

**3. The instructor says one sentence.**

She reads out a four-letter room code. That is the entire instruction, and it
has to stay that way no matter how many formats exist. She does not explain
which game, students do not choose, and nobody is talked through a menu.

**4. Free tier, permanently.**

Firestore Spark is 50k reads / 20k writes per **day**, shared by every format.
Cloudflare Workers free is 100k requests/day. A live room is already read by
about eleven pollers every four seconds. Any format that adds a Firestore
operation per poll is disqualified; formats that keep their state inside the
room document already being written are free.

**5. It has to degrade when the classroom wifi dies.**

Buy Time sets the bar: the clock is on her laptop and every student's Leitner
state is local, so a dead network degrades to "shout your number when you clear
one" and a tally on the whiteboard. A format that becomes unplayable offline is
worth less than its score suggests.

**6. Retrieval, not recognition.**

The flashcard app this replaced failed because recognising an answer feels like
knowing it. Anything that lets a student coast on recognition is a regression,
however fun it is.

---

## Shipped

### Buy Time — one clock the whole class keeps alive

A countdown on the projector. Every correct answer buys the room seconds;
nothing anyone gets wrong ever costs the room anything. Each phone serves that
student their own questions at their own level, so nobody gets something out of
their depth, and the level difference is paid privately in XP rather than
publicly on the board.

A missed question drops anonymously into an **Open Pool**, shown on the
projector as topic tags only — *"Relaxation ×2, APIE Evaluation ×3"*. Anyone can
hunt a pool question for double value, so the strongest students spend the back
half attacking exactly what the room is weakest on, and nobody knows whose miss
produced any entry. No student may bank more than 60% of the target, so a run
cannot finish without most of the room contributing.

**Known flaw:** the last stretch of the round is unprepared live reteaching of
whatever survived in the pool. The app aims the instructor precisely at material
she may not be ready to teach cold. The end screen presents the pool as a
"teach these next" list rather than as a demand.

---

## Designed, not built

Build sizes are relative to this codebase, which already has the live-room
layer, the level ladder, Leitner scheduling, and six question types.

| Format | Build | Firestore | Straggler-safe by |
|---|---|---|---|
| The Standing Order | small | 1 doc, 60s cache | only the holder is ever named |
| ~~The Supply Closet~~ | **built** | zero extra ops | purchases are private |
| Field Day | medium | zero extra ops | the racers are chapters, not students |
| Three Certainties | medium | ~10 writes/round | calibration is personal, not ranked |
| Beat the Forecast | medium | reuses the room doc | private per-student handicap |
| The Walk-Through | large | same as Buy Time | cooperative, no ranking |

### The Supply Closet — the token shop  *(built)*

Budget is earned at **one token per question attempted, not per question
correct**, so purchasing power tracks effort and the student who is behind is by
construction the one attempting most. Teacher-issued grants are one write to the
student document the dashboard already touches.

Six tokens, not eighteen — this is one semester, not thousands of rounds:

- **Adapted Equipment** — serve this item one level down
- **Chart Review** — on a write-in, the first letter and the character count
- **Consult** — drop two wrong options
- **Documentation** — a miss does not drop your Leitner box by two
- **Co-Treat** — credit your next live clear to a classmate
- **Inservice** — next round pays 1.5× XP

**Token use never appears on the projector, with one exception: Co-Treat, whose
entire effect is to credit someone else.** The only publicly visible token in
the game is an act of help.

This design found a real gap in what is already shipped: `servedLevel()` only
steps a question down when it physically cannot be written in, so a student
auto-promoted to Level 3 has **no way back down** if they are drowning. Adapted
Equipment gives them one, privately, with nobody told.

**Two things changed between design and build.** Chart Review was going to reveal
the hint on a write-in, but the hint is already free on every write-in — selling it
back would have made the hardest level harder for the students least able to afford
the token. It gives the first letter and the character count instead, which is
strictly additive. And Co-Treat does not ask who to credit: the server picks whoever
has cleared least, so nobody has to choose a classmate in front of the class and the
help always lands where it is needed most.

Earning is one token per question **attempted**. The skill tree is the second XP
sink: six nodes across Assessment, Implementation and Evaluation, buying permanent
competence rather than more consumables. Teacher grants are one atomic increment on
the student document, claimed by difference so a grant is never applied twice and
never lost to an offline phone.

### Field Day — lane racing, safest design here

Five lanes on the projector, one per chapter. Every correct answer in the room
moves the lane its question belongs to, and `q.chapter` is already stamped on
every question. **The racers are chapters, not students — there is no order of
students to be last in, because the object simply does not exist.**

Steps are flat, one per correct answer regardless of level, so a Level 1 student
moves a lane exactly as far as a Level 3 student. Setback cards name the chapter
with the most misses, handing the instructor a reteach cue that arrives as
spectacle rather than as a grade. Lane positions are five integers on the room
document already being written, so it costs nothing extra.

### Beat the Forecast — the private handicap

Before the round the app privately tells each student what it expects from them,
computed from their own Leitner history: *"the app expects 5 of 9 from you."*
Only they see it. The scoreboard shows **nothing but margin** — how far you beat
your own number — so the weakest student in the room can genuinely win, while
the strongest, sitting at a forecast of 8, has almost nowhere to climb.

All ten answer different questions simultaneously, roughly 90 distinct items, so
nobody can compare cards. The tenth hole is "defend it": the box-3 question each
student has gone longest without seeing, worth double, so the strong students
finally have something to lose.

**Fix required before the first run:** projecting individual margins replaces
"I'm behind" (which has an excuse built in) with "I fell short of what the
system, knowing my whole history, predicted I could do" — which does not.
Students decode the margin back to a forecast within two holes. **Project only
team totals; keep every individual margin on the student's own phone.**

### Three Certainties — confidence betting

A fixed budget of **3 Certain · 4 Fairly Sure · 3 Guess** across ten questions,
spent before the timer ends.

```
CERTAIN      +50 / −80
FAIRLY SURE  +20 / −25
GUESS         +5 /  −5
```

Being confident and wrong hurts more than anything else on the board.
Afterwards: *"You spent CERTAIN 3 times. You were right once. Certain should
mean nine times in ten."* Every confident miss is forced back to Leitner box 0
and returns tagged **"you were sure about this."**

This attacks the exact failure behind the flashcards. Most of its value works
**without** a live classroom, so it is shippable solo-first; only the projector
calibration slide needs everyone present.

**Two implementation traps found in review:** the `practice` flag in
`finishRun()` gates box demotion, so a naive build silently disables the
punishment mechanic; and a single round of three Certains can only report 0 /
33 / 67 / 100%, so the calibration verdict must accumulate across rounds or it
is reporting three coin flips as a measurement.

### The Standing Order — a rotating bounty

One mark, held by one student, huntable solo or in class. **Fall short and
nothing is written, nothing is shown, nobody is told.** Only the holder is ever
named.

A happy accident of n=10: picking the mark at random from the top ten means the
top ten is *everybody*, so the weakest student in the room will hold the
Standing Order within a fortnight without ever beating anyone.

### The Walk-Through — accessibility audit as Battleship

A facility floor plan with hidden barriers instead of ships: *Stairs Only*, *No
Curb Cut*, *Narrow Doorway*. Tonally the best fit for RT of anything here, and
the only one needing genuinely new UI. Large build.

---

## Designed but never costed

These three hit output limits during the costing pass and were never run to
ground. They are recorded so the ideas are not lost, not because they are ready.

**The Liar's Table** *(live)* — scored highest for engagement of sixteen
concepts. Everyone sees a question stem with no options and types a convincing
**wrong** answer; the real answer is shuffled among the nine lies; everyone
picks the truth, then the options flip over one at a time showing who wrote each
lie and who fell for it. +100 for finding truth, +75 per classmate your lie
caught, and **zero, never negative, for being fooled.** One truth plus nine lies
is exactly ten options — this format only works at this class size.

*Honest flaw:* nine students spend each round crafting and seriously considering
plausible falsehoods about material they are about to be examined on, and
nothing records who wrote which lie — so a misconception a student invented
themselves is the one thing spaced repetition cannot route back to them.
Throughput is also low, roughly ten questions per period.

**Ghost Duel** *(async head-to-head)* — *"You vs. Maya — Ch. 4, APIE — 7
questions."* Same seven for both, played whenever. You lock your answer and
**only then** does the ghost slide up. Both wrong means nobody scores and it
becomes a shared Blind Spot, knocked down two Leitner boxes for both.

*Blocked, not merely flawed:* at exactly ten with a full round robin, rank is
unambiguous, and by week three the bottom two are 0–3 publicly every Monday.
Blunting the ladder removes the hook, so there is no version that keeps the
motivation and drops the harm. **The ladder needs redesigning before this is
buildable.**

**Consult Service** *(peer teaching)* — after missing a question twice a student
may request a consult anonymously, including the wrong answer they picked. It
surfaces only to classmates who have mastered that question. The reply form is
not "the answer is C" but two fields: *"Why someone would pick that one"* and
*"Why it's actually this one."* The explainer's name is attached. A consult
counts as **Landed** only when the requester passes the re-attempt.

*Honest flaw:* it dies in week three without course credit attached. Three
people opting out starves the board, and a request sitting unanswered for four
days leaves that student worse off than if the feature had never shipped.

---

## Considered and set aside

**Caseload** — a semester-long roleplay where each student is therapist of
record for one named client through Assess → Plan → Implement → Evaluate. It
scored highest of any concept for retention, for a real reason: it forces theory,
interventions, APIE, communication and groups into one problem, and that
interleaving is substantially better on a delayed test.

Set aside because it is a semester-long bet that **fails invisibly**. If the
Planning gate is even slightly soft, students scroll past the story to the four
buttons and it is the existing quiz with reading overhead — and that will not be
apparent until week six. It is also the largest writing job here. Worth
revisiting as a summer project, not as a bet on a live semester.

---

## What this list demands of the shared plumbing

The formats above are deliberately not all shaped like Buy Time. Anything built
as shared infrastructure has to survive all of them:

- **Not every format has a countdown.** Ghost Duel and Consult Service are
  async; The Standing Order runs for days. `endsAtMs` cannot be assumed.
- **Not every format has a shared pool.** Field Day tracks five lane integers;
  Three Certainties tracks a per-student budget. The `pool` array is Buy Time's,
  not the room's.
- **Not every format is simultaneous.** Ghost Duel is turn-based against a
  recording; The Liar's Table has distinct write / pick / reveal stages with
  different UI per stage.
- **At least one has an economy.** The Supply Closet needs per-student token
  balances and teacher-issued grants, which live on the student document rather
  than the room.
- **Scoring direction differs.** Buy Time is strictly non-negative; Three
  Certainties is explicitly punishing. Shared scoring helpers must not assume
  one.

The practical consequence: `target`, `cleared`, `endsAtMs`, `pool`, `allHands`,
`perStudentCap` and the `won` state are **Buy Time's fields, not the room's**.
The room owns identity and lifecycle — code, class, which format, what stage,
who is present, when it was made. Format state belongs to the format.

What every format genuinely shares, and should therefore never fork: question
presentation and grading (`prep`, `serve`, `grade`, `renderBody`), the level
ladder, Leitner scheduling, and XP.
