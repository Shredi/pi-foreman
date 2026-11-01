# Prompting Claude Haiku 5.5

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5
Checked: 2026-11-01

Own-words digest. Prompts written for Haiku 4.5 carry over without edits. Read `claude.md` for the shared techniques.

## Effort and thinking

The effort setting takes over from the old thinking budget (`budget_tokens`). Thinking is switched on out of the box and its tokens count against `max_tokens`, so keep headroom.

- `low`: the cheapest, quickest tier, suited to chat, short tool tasks and simple high-volume jobs. Inside long agent prompts it skips searches, quits early or omits checks more often than the other tiers.
- `medium`: the default. Fits most work, agentic coding included.
- `high`: for knowledge work, longer agent runs and tight instruction following.
- `xhigh` and `max`: adopt them only after you measure a quality gain, and benchmark Sonnet 5.5 against them first.

To get less thinking, lower the effort; telling the model in prose not to think did nothing. `thinking: disabled` is accepted at `low`, `medium` and `high` only. At `xhigh` in a multi-turn chat the model can put its entire answer inside the thinking block and return nothing visible, so watch for empty replies. Changing effort per message (beta) leaves the cache intact, provided adaptive thinking is on.

## Search

Supply the current date, either in the system prompt or in the search tool description. Render it a single time when the conversation begins and repeat it unchanged on every later request; when a new day arrives, state the new date in the latest turn. The model sometimes has to be pushed to search, above all at low effort or under a long system prompt. A brief note placed after the date lifted the search rate on questions whose answers had changed, at a cost of roughly 0-3 percent more searches. With a short system prompt at medium, leave the note out. A blanket rule such as "search for any present-day fact" backfires: searches fired on half of the prompts that needed none, and answers got no better.

## JSON output with your own tools

When thinking is off and structured outputs are on, a required tool call may be skipped. Three ways out: turn on adaptive thinking, remove `output_config.format` for requests where a tool has to run, or force the call with `tool_choice`. If thinking must stay disabled, a single added system-prompt line raised the share of complete, valid JSON at low and medium.

## Early stopping and verification

- Under a lengthy coding-agent system prompt at `low`, the model now and then quits and returns the task unfinished. Put wording against early stopping in the system prompt. Moving to medium effort cut early stops by about half, but output tokens more than doubled.
- At low and medium it can claim a change is finished without having run any check. A system-prompt paragraph that asks for verification makes checking more frequent, for more tokens and better outcomes.

## Mid-turn user messages

A user message embedded in a tool result, or a system message directly after one, may be judged untrusted and dropped. Keep user text out of tool results altogether. Append it as a text block following the final tool result in that same user message. Harness notices belong in their own mid-conversation system message, not in that block.

## Chatbots and reasoning text

- To hold a chatbot to its system prompt when users push back or keep asking, add wording to the prompt on top of your other injection defences, and pick `high` effort if sticking to instructions matters most.
- Replies show reasoning-style text more often with thinking disabled or at low effort. Move to adaptive thinking and `medium`.

## Refusals

Refusal categories: cyber, frontier LLM, bio, general harms. No server-side fallback exists, and a retry typically gets refused again.
