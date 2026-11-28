--------------------------- MODULE PermissionFlow ---------------------------
(***************************************************************************)
(* The permission flow of a child's tool call (extensions/core-adapter),   *)
(* order-dependent: the judge (clear, refuse, owner, unsure, a word it     *)
(* must not use, timeout, read rounds), the rules file (remember), the     *)
(* ask to the parent (present, away, restarted, closed), the owner's       *)
(* answer, the 15-minute ask deadline, a run that ends while its ask is    *)
(* open, the parked answer of such an ask, and the protected-target route  *)
(* check. A model of the rules, not of the code: it can drift (see         *)
(* SKILL.md, "After an intended change").                                  *)
(*                                                                         *)
(* P1 RunsAuthorised: a call runs only on a clear verdict (and, for a      *)
(*    protected target, with the ask dir still there), an allow rule, or   *)
(*    the owner's yes (one ask, one run: an allow once is not carried).    *)
(* P2 AnswerOnlyForItsCall: an answer applies only to the call it was      *)
(*    asked for (ask n; the park key has the hash of the input).           *)
(* P3 AskEnds: every ask ends (answer, gone, timeout; an away owner means *)
(*    the deadline) and the child is told; an ask never stays open with    *)
(*    nobody waiting for it, and a waiting child always has an open ask.   *)
(***************************************************************************)
EXTENDS Integers

CONSTANTS
  MaxTry,                  \* attempts of call 1 (the other call gets one)
  MaxRounds,               \* judge read rounds before a refusal
  MaxAsks,                 \* asks (ask.md numbers) in a run of the model
  Limit                    \* clock ticks to the ask deadline (DEFAULT_ASK_TIMEOUT_MS)

Calls == {1, 2}            \* a call is its input hash: call 2 is the one on a protected target
Prot == {2}
TryMax(c) == IF c = 1 THEN MaxTry ELSE 1   \* the second attempt is only needed on the call that is asked, parked and asked again
Verdicts == {"clear", "refuse", "owner", "other", "timeout"}   \* unsure and invalid_verdict take the same branch as refuse
Parents == {"present", "away", "restarted", "closed"}
Ends == {"allow", "deny", "timeout", "gone"}

VARIABLES
  parent,                  \* the parent session: owner there, owner away, restarted (dialogs lost, not yet re-adopted), closed (ask dir gone)
  phase,                   \* per call: "idle" | "judging" | "toask" | "waiting" | "ended" | "ran" | "refused"
  tries, rounds,           \* per call: attempts made, judge read rounds
  rule,                    \* per call: the rules file allows it (remember)
  askSt, askOf, nAsks,     \* ask n: "none" | "open" | one of Ends; the call it was asked for; asks made
  cur, age,                \* the open ask (0 = none), ticks since it opened
  runEnded, first,         \* the child's run ended with its ask open; the next ask is the first of a resumed run
  parked,                  \* the owner's answer to the ask of an ended run: call, value, source ask (call 0 = none)
  runs                     \* history: every run of a call, with what authorised it

vars == <<parent, phase, tries, rounds, rule, askSt, askOf, nAsks, cur, age, runEnded, first, parked, runs>>

NoPark == [call |-> 0, val |-> "deny", src |-> 0]

\* the park key: launch, tool, cwd and the hash of the whole input (childaskpark.ts parkKey)
KeyMatches(pc, c) == pc = c

Init ==
  /\ parent = "present"
  /\ phase = [c \in Calls |-> "idle"]
  /\ tries = [c \in Calls |-> 0]
  /\ rounds = [c \in Calls |-> 0]
  /\ rule = [c \in Calls |-> FALSE]
  /\ askSt = [n \in 1..MaxAsks |-> "none"]
  /\ askOf = [n \in 1..MaxAsks |-> 0]
  /\ nAsks = 0
  /\ cur = 0
  /\ age = 0
  /\ runEnded = FALSE
  /\ first = FALSE
  /\ parked = NoPark
  /\ runs = {}

Finished(c) == phase[c] \in {"idle", "ran", "refused"}

Record(c, via, verdict, ask) ==
  [call |-> c, via |-> via, verdict |-> verdict, ask |-> ask, try |-> tries[c], parent |-> parent]

\* tool_call handler: an allow rule runs the call; else the judge looks (classifier.ts)
Attempt(c) ==
  /\ ~runEnded /\ Finished(c) /\ tries[c] < TryMax(c)
  /\ tries' = [tries EXCEPT ![c] = @ + 1]
  /\ rounds' = [rounds EXCEPT ![c] = 0]
  /\ IF rule[c]
       THEN /\ phase' = [phase EXCEPT ![c] = "ran"]
            /\ runs' = runs \cup {[call |-> c, via |-> "rule", verdict |-> "-", ask |-> 0, try |-> tries[c] + 1, parent |-> parent]}
       ELSE /\ phase' = [phase EXCEPT ![c] = "judging"]
            /\ runs' = runs
  /\ UNCHANGED <<parent, rule, askSt, askOf, nAsks, cur, age, runEnded, first, parked>>

\* the judge asks to read a file: one more round, up to MaxRounds (classifier.ts read rounds)
JudgeRead(c) ==
  /\ phase[c] = "judging" /\ rounds[c] < MaxRounds
  /\ rounds' = [rounds EXCEPT ![c] = @ + 1]
  /\ UNCHANGED <<parent, phase, tries, rule, askSt, askOf, nAsks, cur, age, runEnded, first, parked, runs>>

\* a read request past the last round is a refusal
JudgeReadAtCap(c) ==
  /\ phase[c] = "judging" /\ rounds[c] = MaxRounds
  /\ phase' = [phase EXCEPT ![c] = "refused"]
  /\ UNCHANGED <<parent, tries, rounds, rule, askSt, askOf, nAsks, cur, age, runEnded, first, parked, runs>>

\* the judge's final answer and what the gate does with it (index.ts tool_call, judgeRefusalText): only clear runs, owner asks, anything else refuses
\* (remote-asks: a protected allow with a judge-first danger goes on to the main judge, and a model-mode write verdict no longer asks; both stay one answer here: run needs the judge's clear and, on call 2, the route; the judge's retry is one more attempt of the same call)
JudgeAnswer(c, v) ==
  /\ phase[c] = "judging"
  /\ \/ /\ v = "clear"
        /\ IF c \in Prot /\ parent = "closed"
             THEN \* protected target: no ask dir means no route to the parent, the child counts as away
                  /\ phase' = [phase EXCEPT ![c] = "refused"]
                  /\ runs' = runs
             ELSE /\ phase' = [phase EXCEPT ![c] = "ran"]
                  /\ runs' = runs \cup {Record(c, "clear", v, 0)}
     \/ /\ v = "owner"
        /\ phase' = [phase EXCEPT ![c] = "toask"]
        /\ runs' = runs
     \/ /\ v \notin {"clear", "owner"}
        /\ phase' = [phase EXCEPT ![c] = "refused"]
        /\ runs' = runs
  /\ UNCHANGED <<parent, tries, rounds, rule, askSt, askOf, nAsks, cur, age, runEnded, first, parked>>

\* decideByDialog, child branch: a missing ask dir is gone (the child never creates it); the first ask of a resumed run meets the parked answer
AskOpen(c) ==
  /\ phase[c] = "toask" /\ cur = 0 /\ ~runEnded
  /\ \/ /\ parent = "closed"
        /\ phase' = [phase EXCEPT ![c] = "refused"]
        /\ UNCHANGED <<askSt, askOf, nAsks, cur, age, first, parked, runs>>
     \/ /\ parent # "closed" /\ first /\ parked.call # 0 /\ KeyMatches(parked.call, c)
        /\ parked' = NoPark /\ first' = FALSE
        /\ IF parked.val = "allow"
             THEN /\ phase' = [phase EXCEPT ![c] = "ran"]
                  /\ runs' = runs \cup {Record(c, "parked", "-", parked.src)}
             ELSE /\ phase' = [phase EXCEPT ![c] = "refused"]
                  /\ runs' = runs
        /\ UNCHANGED <<askSt, askOf, nAsks, cur, age>>
     \/ /\ parent # "closed" /\ nAsks < MaxAsks /\ ~(first /\ parked.call # 0 /\ KeyMatches(parked.call, c))
        /\ parked' = NoPark /\ first' = FALSE   \* the first ask of the resumed run ends the parked answer's life
        /\ nAsks' = nAsks + 1
        /\ askSt' = [askSt EXCEPT ![nAsks + 1] = "open"]
        /\ askOf' = [askOf EXCEPT ![nAsks + 1] = c]
        /\ cur' = nAsks + 1 /\ age' = 0
        /\ phase' = [phase EXCEPT ![c] = "waiting"]
        /\ runs' = runs
  /\ UNCHANGED <<parent, tries, rounds, rule, runEnded>>

\* the child's end of an ask: it is told (ran or refused), or, with its run ended, nobody is waiting
Close(end) ==
  LET n == cur
      c == askOf[n]
  IN /\ askSt' = [askSt EXCEPT ![n] = end]
     /\ cur' = 0
     /\ phase' = IF runEnded THEN phase
                 ELSE [phase EXCEPT ![c] = IF end = "allow" THEN "ran" ELSE "refused"]
     /\ runs' = IF ~runEnded /\ end = "allow" THEN runs \cup {Record(c, "owner", "-", n)} ELSE runs

\* the owner's answer in the parent's dialog (answerChildAsk); with the run ended the answer is parked, once, for exactly that call (reportChildAsk)
OwnerAnswer(end) ==
  /\ cur # 0 /\ parent = "present" /\ end \in {"allow", "deny"}
  /\ Close(end)
  /\ parked' = IF runEnded THEN [call |-> askOf[cur], val |-> end, src |-> cur] ELSE parked
  /\ UNCHANGED <<parent, tries, rounds, rule, nAsks, askOf, age, runEnded, first>>

\* the ask dir is gone (the starting session ended): the child's gone check ends the wait within one interval, not at the deadline
Gone ==
  /\ cur # 0 /\ parent = "closed"
  /\ Close("gone")
  /\ UNCHANGED <<parent, tries, rounds, rule, nAsks, askOf, age, runEnded, first, parked>>

\* the deadline: the child stops waiting with its own text and the parent's dialog is aborted; nothing is parked, nothing counts towards the repeat stop
Timeout ==
  /\ cur # 0 /\ age = Limit
  /\ Close("timeout")
  /\ UNCHANGED <<parent, tries, rounds, rule, nAsks, askOf, age, runEnded, first, parked>>

\* time passes while an ask is open, but not past the check that a closed parent owes
Tick ==
  /\ cur # 0 /\ age < Limit /\ parent # "closed"
  /\ age' = age + 1
  /\ UNCHANGED <<parent, phase, tries, rounds, rule, askSt, askOf, nAsks, cur, runEnded, first, parked, runs>>

\* the parent session: owner away / back, restart (memory-only parks are lost, the watch re-adopts the ask dirs), close
ParentStep ==
  /\ \E p \in Parents:
       /\ p # parent /\ parent # "closed"
       /\ \/ p \in {"present", "away"} /\ parent \in {"present", "away"}
          \/ p = "restarted" /\ parent \in {"present", "away"}
          \/ p = "present" /\ parent = "restarted"
          \/ p = "closed"
       /\ parent' = p
       /\ parked' = IF p = "restarted" THEN NoPark ELSE parked
  /\ UNCHANGED <<phase, tries, rounds, rule, askSt, askOf, nAsks, cur, age, runEnded, first, runs>>

\* the child's run ends while its ask is open: the dialog stays, nobody waits on it (closeChildAsk)
EndRun ==
  /\ ~runEnded /\ cur # 0 /\ phase[askOf[cur]] = "waiting"
  /\ runEnded' = TRUE
  /\ phase' = [phase EXCEPT ![askOf[cur]] = "ended"]
  /\ UNCHANGED <<parent, tries, rounds, rule, askSt, askOf, nAsks, cur, age, first, parked, runs>>

\* a resume with the ask settled: the next ask is the first of the resumed run
Resume ==
  /\ runEnded /\ cur = 0 /\ parent # "closed"
  /\ runEnded' = FALSE /\ first' = TRUE
  /\ phase' = [c \in Calls |-> IF phase[c] = "ended" THEN "idle" ELSE phase[c]]
  /\ UNCHANGED <<parent, tries, rounds, rule, askSt, askOf, nAsks, cur, age, parked, runs>>

\* remember: the owner adds an allow rule to a permission file
RuleAdd(c) ==
  /\ ~rule[c]
  /\ rule' = [rule EXCEPT ![c] = TRUE]
  /\ UNCHANGED <<parent, phase, tries, rounds, askSt, askOf, nAsks, cur, age, runEnded, first, parked, runs>>

Next ==
  \/ \E c \in Calls: Attempt(c) \/ JudgeRead(c) \/ JudgeReadAtCap(c) \/ AskOpen(c) \/ RuleAdd(c)
  \/ \E c \in Calls, v \in Verdicts: JudgeAnswer(c, v)
  \/ OwnerAnswer("allow") \/ OwnerAnswer("deny") \/ Gone \/ Timeout \/ Tick
  \/ ParentStep \/ EndRun \/ Resume

Spec == Init /\ [][Next]_vars /\ WF_vars(Tick) /\ WF_vars(Timeout) /\ WF_vars(Gone)

TypeOK ==
  /\ parent \in Parents
  /\ phase \in [Calls -> {"idle", "judging", "toask", "waiting", "ended", "ran", "refused"}]
  /\ askSt \in [1..MaxAsks -> {"none", "open"} \cup Ends]
  /\ cur \in 0..MaxAsks /\ age \in 0..Limit

\* P1: every run has its authority; a clear verdict needs the judge's own clear, and on a protected target a route to the parent
RunsAuthorised ==
  \A r \in runs:
    /\ r.via = "clear" => r.verdict = "clear" /\ ~(r.call \in Prot /\ r.parent = "closed")
    /\ r.via = "rule" => rule[r.call]
    /\ r.via \in {"owner", "parked"} => r.ask # 0
    \* the owner's run follows the owner's yes on its ask (a timeout or a gone parent is never an allow)
    /\ r.via = "owner" => askSt[r.ask] = "allow"
    \* an allow once is not carried: one ask, one run
    /\ \A q \in runs: (r.ask # 0 /\ r.ask = q.ask) => (r.call = q.call /\ r.try = q.try)

\* P2: an answer applies only to the call its ask was for
AnswerOnlyForItsCall ==
  \A r \in runs: r.via \in {"owner", "parked"} => askOf[r.ask] = r.call

\* P3 (safety half): a waiting child has its ask open, and an open ask is the one a waiting child waits on or one an ended run left open
WaitingHasOpenAsk ==
  \A c \in Calls: phase[c] = "waiting" => cur # 0 /\ askOf[cur] = c /\ askSt[cur] = "open"

\* P3 (liveness half): every ask ends
AskEnds == \A n \in 1..MaxAsks: askSt[n] = "open" ~> askSt[n] # "open"
=============================================================================
