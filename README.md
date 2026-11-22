# Intra-turn Board

[日本語](README.ja.md)

Intra-turn Board is an agent skill for Claude Code and Codex. It opens a local whiteboard in your browser where you think through a request with the AI on sticky notes, without waiting for each turn to finish:

- **While you type** a note, the board underlines the words the AI would otherwise decide on its own. Click an underline to set what you mean before you send it.
- **While the AI replies**, it stops at the decisions that are yours to make and leaves them as blanks. Fill a blank and the AI writes the rest; change your answer later and it rewrites from there.

The board runs inside the session you launch it from, so replies use everything you and the agent have already discussed.

## Requirements

- macOS with Node.js 22 or later (Linux should work but is untested)
- [Claude Code](https://code.claude.com/) or [Codex CLI](https://github.com/openai/codex), signed in
- A TypeSafe API key for Jev ([docs](https://docs.typesafe.ai/)), which decides which words to underline
- [envchain](https://github.com/sorah/envchain) (recommended) to keep the API key in your keychain

Without the TypeSafe key the board still works, but it picks underlines with a simple local rule that is noticeably worse.

## Install

Install the skill with the [skills](https://github.com/vercel-labs/skills) CLI. `-g` makes it available in every project.

```sh
# Claude Code
npx skills add asonas/intra-turn-board -g -a claude-code

# Codex
npx skills add asonas/intra-turn-board -g -a codex
```

Installed skills do not update themselves. To get a new version, run:

```sh
npx skills check    # see whether an update is available
npx skills update -g
```

If you want to change the skill yourself, clone the repository and link it instead. Then `git pull` updates it.

```sh
git clone https://github.com/asonas/intra-turn-board.git
cd intra-turn-board
ln -s "$PWD/.agents/skills/intra-turn-board" ~/.claude/skills/intra-turn-board   # Claude Code
ln -s "$PWD/.agents/skills/intra-turn-board" ~/.codex/skills/intra-turn-board    # Codex
```

## Store the TypeSafe API key

We recommend envchain, so the key lives in your keychain and is handed only to the board's server, not to your shell or the agent session.

```sh
envchain --set typesafe TYPESAFE_API_KEY
```

envchain asks for the value and stores it under the namespace `typesafe`.

## Use

Start a session in your project and talk with the agent as usual. When you want to think something through together, invoke the skill:

- Claude Code: type `/intra-turn-board`
- Codex: ask Codex to use the `intra-turn-board` skill

Ask the agent to launch the server through envchain so the board can use Jev, for example: "start the board with `envchain typesafe`". The board opens in your default browser.

On the board:

1. Click an empty spot to place a note, and write your request.
2. Underlined words show what the AI would assume. Click one to choose or type your own answer.
3. Press the send button. The reply appears next to the note, connected by a line.
4. Fill the blanks in the reply. The AI continues once all of them are filled.
5. Select a passage in a reply to ask a follow-up about it.

When you are done, press the 「まとめて終える」 (wrap up) button in the header. The AI summarizes the board (what was decided, what is still open, next steps, and the key points of each note) into a Markdown file under `intra-turn-board/` in your working directory (the folder ignores itself in git), and the board closes. In Claude Code the agent is notified, reads the summary and continues the conversation from it. In Codex, mention it in your next message and the agent reads the latest summary.

Drag the background to move around. The board itself is not saved; closing or reloading the page clears it, so wrap up before you leave if you want to keep the result.

## What it sends where, and what it costs

- **Replies** fork your current agent session (`claude -p --resume … --fork-session` or `codex exec fork`). With Claude Code signed in to a Claude plan, these calls draw from your plan's usage limits like any other `claude -p` call. A reply typically takes about 10 seconds.
- **At launch**, the server reads your user and assistant messages from the session transcript and asks a lighter model (Sonnet for Claude Code, gpt-6.2-sol for Codex) to list the open questions and decided facts. The board uses this list for questions that fit your conversation. This takes about 10 seconds and does not block the board.
- **Underline judgements** send the note text and its candidate words to TypeSafe's API. Each judgement takes about 150 ms and costs a fraction of a cent.
- **The Japanese dictionary** for finding candidate words (Kuromoji, about 18 MB) is downloaded from jsDelivr when the page opens.

The server listens only on `127.0.0.1` and requires a random token in the URL. Every model call is logged to the server's output with its latency and token usage.

## Status

This is an early prototype. Underline judgement is tuned for Japanese notes. Plans and measurements are tracked in [GitHub Issues](https://github.com/asonas/intra-turn-board/issues).

## Background

The interactions follow Bruce Liu's work on going beyond turn-taking in human-AI interaction ([thesis](https://escholarship.org/uc/item/28d8b7wd)): showing the AI's assumptions while the user types (feedforward) and leaving blanks in the AI's reply for the user to fill.
