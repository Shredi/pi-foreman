// `foreman_hold`: the foreman marks that it waits for the owner on purpose (D109). The finish gate then accepts a turn end that it would
// refuse for a missing review (the pause branch, index.ts ceremonyFinishGate); the live file says `blockedOn` owner, kind `hold`, so the
// sidebar shows "Needs you". The mark ends at the owner's next message, at a builder launch or a project edit, or with `{off:true}`.
// The hold is no way past the review: owner input, a builder launch or a project edit ends it, so work done after the hold meets the gate again;
// the final finish after real work still needs the review.
export const HOLD_TOOL = "foreman_hold";
export const HOLD_NOTE_MAX = 200;

export const HOLD_DESCRIPTION = `Mark this session as waiting for the owner on purpose. Use it when your work stops at a point only the owner can pass (a decision, a login, a manual step) and nothing is left for you to do meanwhile. Reason: the finish check asks for the review before a session ends its turn, and a session that waits for the owner has no finished work to review. While the mark stands, your turn may end without that review, and the sidebar shows "Needs you". The mark ends by itself at the owner's next message, at a builder launch or at a project edit; \`${HOLD_TOOL}({off: true})\` ends it earlier. It is a mark for waiting, not a finish: the final finish after real work still needs the reviewer PASS. Pass \`note\`: one line saying what the owner has to do or decide.`;

export const HOLD_SET_TEXT = "Hold set: this session waits for the owner. Your turn may end now without the review check, and the sidebar shows \"Needs you\". The hold ends at the owner's next message, at a builder launch or at a project edit. The final finish after real work still needs the reviewer PASS.";
export const HOLD_OFF_TEXT = "Hold ended: the finish check applies again.";
export const HOLD_NONE_TEXT = "No hold was set; nothing changed.";
export const HOLD_NEEDS_NOTE_TEXT = `${HOLD_TOOL}: pass note, one line saying what the owner has to do or decide (or {off: true} to end a hold).`;
