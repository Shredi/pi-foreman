// Harness bookkeeping for the `ask_user_question` tool, keyed on the tool name and independent of the package that
// registers it (@juicesharp/rpiv-ask-user-question, bundled). An answer to a dialog is never filed as `ruling-<n>.md`.

export const ASK_USER_TOOL = "ask_user_question";

/** Whether a result is an owner answer: not an error, not cancelled (Esc, no UI, invalid questions). */
export function askAnswered(details: unknown, isError: boolean): boolean {
  if (isError) return false;
  const d = (details ?? {}) as { cancelled?: unknown; error?: unknown };
  return d.cancelled === false && (d.error === undefined || d.error === null);
}

/** Whether a result is an owner answer with at least one answered question (an empty `answers` is not). */
export function askAnsweredSome(details: unknown, isError: boolean): boolean {
  if (!askAnswered(details, isError)) return false;
  const answers = ((details ?? {}) as { answers?: unknown }).answers;
  return Array.isArray(answers) && answers.length > 0;
}
