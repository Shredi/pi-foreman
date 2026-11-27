---------------------------- MODULE ReviewGates ----------------------------
(***************************************************************************)
(* The review gates of extensions/core-adapter as a state machine: the     *)
(* finish verdict, the drop of a deleted checkout (D189b), `mark V`, the reviewer-launch repeat refusal (D203) and the *)
(* V line on a tier rise (D164), and the words of an ended dialog episode  *)
(* (D159 rule c). It is the model of the same rules the TypeScript walk    *)
(* test/review-gates-generator.test.ts checks on the real code; this file  *)
(* is a model, so it can drift from the code (see SKILL.md, "After an      *)
(* intended change").                                                      *)
(*                                                                         *)
(* The dialog rule uses time stamps, as the code does (one tick per       *)
(* event, so no two times tie). Its invariants use history variables      *)
(* (`ghostAns`, `ghostRst`) that record what happened without any time    *)
(* stamp: a rule is checked against the events, not against the           *)
(* mechanism's own numbers.                                                *)
(***************************************************************************)
EXTENDS Integers

CONSTANT MaxSteps          \* the bound: at most this many events from the start

Checkouts == {1, 2}
Since == 0                 \* the dialog episode starts before the first event

VARIABLES
  now,                     \* event counter, the clock
  seen, gone,              \* per checkout: has a gate entry; deleted
  last, revised, hasPass,  \* per checkout: last verdict, work since it, a counted PASS ever
  vLine, tier,             \* ledger V line: "none" | "open" | "closed"; tier: "trivial" | "standard"
  ansAt, rstAt,            \* dialog: time of the last stored answer, of the last restart
  ghostAns, ghostRst       \* history: an answer, a restart happened inside the episode

vars == <<now, seen, gone, last, revised, hasPass, vLine, tier, ansAt, rstAt, ghostAns, ghostRst>>

NoAns == -2
StaleAns == -1             \* an answer stored before the episode began

Init ==
  /\ now = 0
  /\ seen = [c \in Checkouts |-> FALSE]
  /\ gone = [c \in Checkouts |-> FALSE]
  /\ last = [c \in Checkouts |-> "none"]
  /\ revised = [c \in Checkouts |-> FALSE]
  /\ hasPass = [c \in Checkouts |-> FALSE]
  /\ vLine = "none"
  /\ tier = "trivial"
  /\ ansAt \in {NoAns, StaleAns}
  /\ rstAt = 0
  /\ ghostAns = FALSE
  /\ ghostRst = FALSE

(***************************************************************************)
(* Derived rules.                                                          *)
(***************************************************************************)
Stands(c) == last[c] = "pass" /\ ~revised[c]

\* reviewgates.ts goneDropped: an entry whose checkout no longer exists is dropped, whatever its state
Dropped(c) == seen[c] /\ gone[c]

Kept == {c \in Checkouts : seen[c] /\ ~Dropped(c)}
Finish == Kept /= {} /\ \A c \in Kept : Stands(c)                      \* combined(): the finish verdict is a PASS
VAccept == (\E c \in Kept : hasPass[c]) /\ (\A c \in Kept : last[c] /= "fail")   \* reviewgates.ts vAccepts: mark V
LaunchRefused(c) == Stands(c) /\ VAccept                                   \* index.ts reviewer launch: a repeat of passed work is refused only while V is accepted

\* childblocked.ts clearOf: a restart comes first, then an answer at or after the episode start
Words ==
  IF rstAt > Since THEN "restart"
  ELSE IF ansAt >= Since THEN "answered"
  ELSE "none"

(***************************************************************************)
(* Actions; each stands for one step of the code no other actor interrupts.*)
(***************************************************************************)
Tick == now < MaxSteps /\ now' = now + 1

\* a build in the checkout (gatesRevise at a builder's work, a builder launch included; a builder end changes no gate)
Build(c) ==
  /\ Tick /\ ~gone[c]
  /\ seen' = [seen EXCEPT ![c] = TRUE]
  /\ revised' = [revised EXCEPT ![c] = TRUE]
  /\ UNCHANGED <<gone, last, hasPass, vLine, tier, ansAt, rstAt, ghostAns, ghostRst>>

\* a review verdict PASS in the checkout (gatesVerdict)
Pass(c) ==
  /\ Tick /\ ~gone[c]
  /\ seen' = [seen EXCEPT ![c] = TRUE]
  /\ last' = [last EXCEPT ![c] = "pass"]
  /\ revised' = [revised EXCEPT ![c] = FALSE]
  /\ hasPass' = [hasPass EXCEPT ![c] = TRUE]
  /\ UNCHANGED <<gone, vLine, tier, ansAt, rstAt, ghostAns, ghostRst>>

\* a review verdict FAIL in the checkout
Fail(c) ==
  /\ Tick /\ ~gone[c]
  /\ seen' = [seen EXCEPT ![c] = TRUE]
  /\ last' = [last EXCEPT ![c] = "fail"]
  /\ revised' = [revised EXCEPT ![c] = FALSE]
  /\ UNCHANGED <<gone, hasPass, vLine, tier, ansAt, rstAt, ghostAns, ghostRst>>

\* the checkout is deleted (its `exists` check turns false)
Delete(c) ==
  /\ Tick
  /\ gone' = [gone EXCEPT ![c] = TRUE]
  /\ UNCHANGED <<seen, last, revised, hasPass, vLine, tier, ansAt, rstAt, ghostAns, ghostRst>>

\* the verifier item is marked: accepted only when VAccept, then the ledger script closes the line
MarkV ==
  /\ Tick
  /\ vLine' = IF VAccept /\ vLine = "open" THEN "closed" ELSE vLine
  /\ UNCHANGED <<seen, gone, last, revised, hasPass, tier, ansAt, rstAt, ghostAns, ghostRst>>

\* the tier rises above trivial: ledgercall.ts withVItem appends V once (D164), also when V is closed
TierRise ==
  /\ Tick
  /\ tier' = "standard"
  /\ vLine' = IF vLine = "none" THEN "open" ELSE vLine
  /\ UNCHANGED <<seen, gone, last, revised, hasPass, ansAt, rstAt, ghostAns, ghostRst>>

\* the owner answers the dialog: a stored checkpoint answer
Answer ==
  /\ Tick
  /\ ansAt' = now + 1
  /\ ghostAns' = TRUE
  /\ UNCHANGED <<seen, gone, last, revised, hasPass, vLine, tier, rstAt, ghostRst>>

\* the session restarts: its start time moves past the episode start
Restart ==
  /\ Tick
  /\ rstAt' = now + 1
  /\ ghostRst' = TRUE
  /\ UNCHANGED <<seen, gone, last, revised, hasPass, vLine, tier, ansAt, ghostAns>>

Next ==
  \/ \E c \in Checkouts : Build(c) \/ Pass(c) \/ Fail(c) \/ Delete(c)
  \/ MarkV \/ TierRise \/ Answer \/ Restart

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* The rules, stated on the events (history variables), not on time stamps.*)
(***************************************************************************)
\* A drop is justified: dropped exactly when the checkout was deleted (and has an entry)
DropJustified == \A c \in Checkouts : Dropped(c) <=> (seen[c] /\ gone[c])

\* The finish verdict passes only when no existing checkout with unreviewed work is kept
NoUnreviewedFinish == Finish => \A c \in Checkouts : (seen[c] /\ ~Stands(c)) => gone[c]

\* D203: when mark V is refused, a new review launch is allowed (never both refused)
VRefusedAllowsLaunch == ~VAccept => \A c \in Checkouts : ~LaunchRefused(c)

\* V closes only after a counted PASS exists
VClosedNeedsPass == vLine = "closed" => \E c \in Checkouts : hasPass[c]

\* V line exists exactly when the tier rose above trivial
VLineFollowsTier == (vLine /= "none") <=> (tier = "standard")

\* Dialog words (D159 c): "answered" only with an answer inside the episode and no restart; a restart wins over any answer
DialogWords ==
  /\ (Words = "answered") => (ghostAns /\ ~ghostRst)
  /\ ghostRst => Words = "restart"
  /\ (ghostAns /\ ~ghostRst) => Words = "answered"
  /\ (~ghostAns /\ ~ghostRst) => Words = "none"

\* later revisions or a tier rise never reopen a closed V line
VStaysClosed == [][vLine = "closed" => vLine' = "closed"]_vars
=============================================================================
