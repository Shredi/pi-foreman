// A fake judge for a rig that wants to pin which judge-first label (`danger-<name>`) a call was sent under: the registry records every prompt it is asked
// (the label is in the request text) and answers with `reply` (default: a refusal).
import { r11Rig } from "./_r11rig.ts";

export const REFUSE_REPLY = JSON.stringify({ verdict: "refuse", reason: "stub refuses" });

export function labelJudge(reply: string = REFUSE_REPLY): { prompts: string[]; registry: Record<string, unknown> } {
  const prompts: string[] = [];
  const registry = {
    find: () => ({ id: "m" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async (_m: unknown, req: { messages?: { content?: string }[] }) => {
      prompts.push(req.messages?.[0]?.content ?? "");
      return { role: "assistant", content: [{ type: "text", text: reply }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" };
    },
  };
  return { prompts, registry };
}

/** An r11Rig whose judge records the labels it is asked about (a config `review` model is set; `gate` merges into the gate config). */
export async function labelRig(t: Parameters<typeof r11Rig>[0], opts: { child?: boolean; gate?: Record<string, unknown>; reply?: string } = {}) {
  const j = labelJudge(opts.reply);
  const roles = Object.fromEntries(["explorer", "builder", "reviewer"].map((r) => [r, { model: `fake/${r}` }]));
  const config = { presence: { enabled: false }, gate: opts.gate ?? {}, providers: { fake: { review: { model: "m" }, roles } } };
  const r = await r11Rig(t, {}, { child: opts.child, ctx: { hasUI: false, mode: "json", modelRegistry: j.registry }, config });
  return { r, prompts: j.prompts };
}
