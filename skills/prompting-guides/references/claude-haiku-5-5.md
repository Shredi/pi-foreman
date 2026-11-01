# Prompting Claude Haiku 5.5

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5
Checked: 2026-11-01

Own-words digest. Haiku 4.5 prompts should work unchanged. Read `claude.md` for the shared techniques.

## Effort and thinking

Effort replaces the old thinking budget. Thinking is on by default and counts toward the output limit, so leave room.

- `low`: cheapest and fastest; chat, short tool tasks, simple high-volume work. In long agent prompts it is more likely to skip a search, stop early or skip a check.
- `medium`: the default; most work, including agentic coding.
- `high`: knowledge work, longer agent tasks, strict instruction following.
- `xhigh` and `max`: only with a measured gain; compare with Sonnet 5.5 first.

Lower effort to think less; prose instructions did not stop thinking. Turning thinking off works at `low`, `medium` and `high` only. At `xhigh` in multi-turn chat it may write the whole answer in thinking and end with no visible text, so check for empty replies. The per-message effort change keeps the cache and needs adaptive thinking.

## Search

Give it today's date, in the system prompt or the search tool description, rendered once at conversation start and kept identical afterwards; on a later day put the new date in the newest turn. It sometimes needs a nudge to search, most at low effort and with long system prompts: a short text after the date raised the search rate on changed-answer questions with little extra searching. Skip the nudge with a short system prompt at medium. Avoid "search for any present-day fact": it searched on half the no-search prompts with no accuracy gain.

## JSON output with your own tools

With thinking off plus structured outputs it may skip a needed tool call. Options: use adaptive thinking; drop the output format where a tool must be called; force the tool choice. If thinking must stay off, one system-prompt line improved complete, correct JSON at low and medium.

## Early stopping and verification

- With a long coding-agent system prompt at `low` it sometimes stops early and hands the task back. Add system-prompt text against early stopping. Raising effort to medium roughly halved the early stops but more than doubled output tokens.
- At low and medium it sometimes reports a change done without running a check. A system-prompt paragraph asking for verification makes checks more frequent: more tokens, better results.

## Mid-turn user messages

It may treat a user message inside a tool result, or a system message right after one, as untrusted and ignore it. Never put user text in a tool result. Send it as a text block after the last tool result in the same user message, and harness notices as a separate mid-conversation system message, never in the same block.

## Chatbots and reasoning text

- To keep a chatbot to its system prompt when users argue or keep asking, add system-prompt text alongside your other injection protections, and use `high` effort when instruction following matters most.
- Reasoning-like text in replies appears more with thinking off or at low effort; switch to adaptive thinking and `medium`.

## Refusals

Categories: cyber, frontier LLM, bio, general harms. There is no server-side fallback, and resending usually refuses again.
