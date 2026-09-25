# Games

RT Mastery is one study engine with several game formats on top of it. This
document records the formats that have been designed, why each one survives a
class of exactly ten, and the honest flaw in each — so that a format is not
rebuilt from scratch, and so that the shared plumbing is designed against real
candidates rather than imagined ones.

Everything in the table below is now built except Caseload, which is deliberately
set aside, and The Liar’s Table and Consult Service, which are not.

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

**7. A round never gets easier as it goes, and no format orders its own.**

The user's words were "3 questions in a row that were all 3 level types". The
cause was a flat shuffle: a four-option question, then a matching grid, then a
select-all reads as the difficulty jumping about, whatever the badge says. A
round now walks up through the shapes — four-option, select-all, grid, ordering
list, write-in — and within one shape the student's weakest question comes
first.

This is not a per-format decision. `buildViews` in `src/app.js` is the only
thing allowed to build a run's `views` array, and `test/levels.mjs` reads the
source and fails the build if anything else does, so a new format cannot start
a round without the ordering rule. Pick the questions however the format wants;
hand them to `buildViews` and it decides the order.

*What this costs, stated once.* Shape is the first key, so where a chapter has
exactly one question of a shape there is nothing left to sort and it lands in
the same position in every round it is drawn into. In the present bank that is
exactly one question: Ch 7's single ordering list at Recognise. Measured over
2000 rounds it is drawn into 283 of them and sits last in all 283. Every other
shape group has two or more members and moves across two to twelve positions.
A student who backs out of Ch 7 rounds before the end therefore always skips
that one item; it cannot cost her the chapter, since 80% of Ch 7's 51 Recognise
questions is 41 and 50 are reachable without it. The only way to give it an
early position is to let a round get easier as it goes, which is the rule
itself.

Two other consequences worth knowing. The shape ramp does nothing at Recall:
every question a chapter can serve at level 3 is a write-in, so the round is one
shape group and the order is purely weakest-first. And the ramp is a property of
the round as it was BUILT — Adapted Equipment re-serves a single question a
level down in place, which the student bought on purpose (see `adaptDown`).

*The live round is the one exception, deliberately.* A room-paced round is not a
study session: the next question depends on what the other nine phones just did,
two of its four sources are questions the ROOM chose and may never be refused or
reordered, and its length is not known when it starts — in Buy Time a correct
answer adds seconds to the shared clock. There is no list to sort. A ratchet was
built and measured against the alternative over all 243 level spreads and all
four live formats: it removes every backward step in a room that is not playing,
at the cost of a third of the round's shape variety and 1166 repeated questions
in 972 rounds, and it evaporates the moment the room starts feeding the pool
(99.7% of rounds still whipsaw). What the live round guarantees instead is that
it never shows a widget the student has not already met in that chapter's own
practice, except on a question the room itself put in the pool. The full
reasoning is at `nextLiveQuestion` in `src/app.js`; `test/levels.mjs` pins the
branch order, the pool's FIFO and the fact that a pool question is never
filtered, so a ramp cannot be added here without turning those red.

**8. A cross-chapter round says which chapters it reached, and on which rung its
answers land.**

Ghost Duel, The Standing Order and Three Certainties serve one level, and
chapters sit on different rungs, so a round drawn from every chapter would
either mix shapes or file its records on a rung the chapter card does not read.
It runs at the level the most chapters can fill the round from and draws only
from those chapters — and it **says so on its own card**. A format that quietly
narrows its pool is telling the student something untrue about what she just
played.

That buys the chapter's own rung for the two uncapped modes and not for the
third. Three Certainties stops at level 2 — `certStrip` has no bet bar for a
write-in, so a level-3 round would leave the student unable to bet at all on the
one round that is only about betting. A chapter standing at Recall is therefore
drawn into a Discriminate round, and its answers are filed under `qid@2`, a key
`chapterMastery(ch, 3)` does not read. The work is real and counts on the
overall bar; that chapter's card does not move. This is the cap, not a defect,
and it is not silent: `crossReach` names the chapters that have climbed past the
round on the mode's own card, by the same rule as the sentence above.

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
| ~~The Standing Order~~ | **built** | 1 doc, 60s cache | only the holder is ever named |
| ~~The Supply Closet~~ | **built** | zero extra ops | purchases are private |
| ~~Field Day~~ | **built** | zero extra ops | the racers are chapters, not students |
| ~~Three Certainties~~ | **built** | 1 write/round | calibration is personal, not ranked |
| ~~Beat the Forecast~~ | **built** | reuses the room doc | private per-student handicap |
| ~~The Walk-Through~~ | **built** | same as Buy Time | cooperative, no ranking |

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

This design found a real gap in what is already shipped: `serve()` only
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

### Field Day — lane racing, safest design here  *(built)*

Five lanes on the projector, one per chapter. Every correct answer in the room
moves the lane its question belongs to, and `q.chapter` is already stamped on
every question. **The racers are chapters, not students — there is no order of
students to be last in, because the object simply does not exist.**

Steps are flat, one per correct answer regardless of level, so a Level 1 student
moves a lane exactly as far as a Level 3 student. Lane positions are five
integers on the room document already being written, so it costs nothing extra.
Nothing per-student is projected at any point — that absence is the design.

**As built, the setback card is a Focus card and it does not set anything back.**
A lane losing ground because the room missed questions would mean one student’s
wrong answer cost everybody else, and rule 2 does not allow that. Focus keeps
the useful half: it names the chapter the room is getting wrong most and makes
it worth double for the next five clears. Same spectacle, same reteach cue, no
penalty. A miss still moves nothing at all; it only feeds the tally.

### Beat the Forecast — the private handicap  *(built)*

Before the round the app privately tells each student what it expects from them,
computed from their own Leitner history: *"the app expects 5 of 9 from you."*
Only they see it. The scoreboard shows **nothing but margin** — how far you beat
your own number — so the weakest student in the room can genuinely win, while
the strongest, sitting at a forecast of 8, has almost nowhere to climb.

All ten answer different questions simultaneously, roughly 90 distinct items, so
nobody can compare cards. The tenth hole is "defend it": the box-3 question each
student has gone longest without seeing, worth double, so the strong students
finally have something to lose.

**That fix is how it was built, and it is enforced by the data model rather
than by discipline.** The room document holds two integers for the whole class
— what the class was expected to get and what it actually got — and nothing
per student. There is literally nothing for the projector to leak. A test
asserts the stored game state has exactly four keys and that no per-student
number appears anywhere on the wire.

The wall shows one dial for the room. A student sees their own margin on their
own phone, and it is never sent anywhere else.

Each question is charged the expectation stamped on it **when it was served**,
never recomputed afterwards: the Leitner box moves the instant an answer lands,
so computing it late charges a student an expectation based on knowledge they
proved in that very answer — which inflates it on a hit, deflates it on a miss,
and quietly shrinks every margin toward zero.

### Three Certainties — confidence betting  *(built)*

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

**Both traps the review found were real, and both are handled.** The flag that
gates Leitner demotion reads as a mode name, so a naive build would have
silently disabled the punishment mechanic — it now asks whether a run feeds the
boxes, which Three Certainties does. And a single round of three Certains can
only report 0 / 33 / 67 / 100%, so the tally accumulates across every round ever
played and no verdict is offered until there are nine; before that the screen
says plainly that one round is too few to say anything true.

### The Standing Order — a rotating bounty  *(built)*

One mark, held by one student, huntable solo or in class. **Fall short and
nothing is written, nothing is shown, nobody is told.** Only the holder is ever
named.

The rate is correct answers per hour with the denominator clamped to a minute.
That clamp is what makes a solo run and one snatched between classes comparable
on one mark: without it a lucky forty-second sprint posts a rate nobody can
reach and the whole thing dies that afternoon.

**As built, the mark eases rather than rotating.** The design handed it to a
random student from the top ten, which at n=10 is everybody. Easing reaches the
same place without a scheduler or a roster read: the mark holds full height for
three days, then drops a tenth a day and never below 40%. So the weakest student
in the room still holds it inside a fortnight without ever beating anyone — the
bar came down to meet them, and they cleared it themselves rather than being
handed a title. Losing it is as private as failing: the former holder is not
told either.

### The Walk-Through — accessibility audit as Battleship  *(built)*

A facility floor plan with hidden barriers instead of ships: *Stairs only*, *No
curb cut*, *Narrow doorway*, *Heavy door*, *No signage*, *No transfer space*,
*Uncontrolled noise*, *Glare and low light*. Thirty named areas from the main
entrance to the pool hoist.

A student picks the area they want to survey **before** they are asked anything,
and a correct answer is what buys them the look. Getting it wrong leaves that
area unsurveyed and costs the room nothing. The class audits one building
together, so there is no ranking of any kind, and the end screen is a report of
what the building gets wrong — not of who found it.

**The hidden layout never leaves the server.** It is drawn server-side at create
and the projection sends only what has actually been surveyed; if the plan rode
along on the wire, anyone with a phone could read the answers out of a network
tab. A test asserts it appears in neither the create response nor any poll.

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

**Ghost Duel** *(solo — built)* — *"You vs. Maya — Ch. 4, APIE — 7
questions."* Same seven for both, played whenever. You lock your answer and
**only then** does the ghost slide up. Both wrong means nobody scores and it
becomes a shared Blind Spot, knocked down two Leitner boxes for both.

*It was blocked, and the fix was to remove the opponent.* At exactly ten with a
full round robin, rank is unambiguous, and by week three the bottom two are 0–3
publicly every Monday — and those are the two who most need to keep playing.
Blunting the ladder removed the hook, so there was no version that kept the
motivation and dropped the harm.

**As built, the ghost is your own last attempt.** Same lock-then-reveal moment,
same Blind Spot, and nobody to come last to. The latest attempt is kept rather
than the best, so a student can see themselves slip as well as improve — a ghost
that only ever gets better is a ghost that lies.

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
presentation and grading (`prep`, `serve`, `grade`, `renderBody`), **round
ordering (`buildViews`)**, the level ladder, Leitner scheduling, and XP.
