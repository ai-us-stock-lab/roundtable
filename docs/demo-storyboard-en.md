# Demo Recording Storyboard (about 60–90 seconds)

Goal: help a first-time viewer understand in about a minute that Roundtable brings several AI CLIs into one workspace, lets them challenge one another, and lets them change files only after the user approves each diff.

Use real model calls for the final recording. Keep the session list hidden, mount only the clean temporary git repository created by `scripts/demo/workspace.mjs`, and wait for UI state changes instead of fixed model delays.

---

## Shot 1 · Open a workbench (~10s)

- Click **+ Workbench**.
- Select Claude and Codex, then mount the temporary demo repository.
- Click **Start chatting**.
- Narration: “Bring your AI CLIs into one shared chat. Roundtable rides the subscriptions you already pay for, so there are no extra model API fees.”

## Shot 2 · Multi-model chat and relay (~20s)

- Ask: “Should this project add tests or write docs first? One line each, under 20 words.”
- Wait until both models answer.
- Click **Let them talk** for two rounds and show the models responding to one another.
- Narration: “They do more than answer independently. Let them challenge each other, and Roundtable stops the relay once nobody has anything new to add.”

## Shot 3 · Change a file in isolation (~25s)

- Ask Codex to append the specified one-line description to the README.
- Click **Build** and wait for the live output and diff card.
- Expand the README diff and hold on the added line.
- Narration: “Ask an agent to change the code for real. It works in an isolated copy, so your project stays untouched until you approve the diff.”

## Shot 4 · Review and apply (~15s)

- Click **Apply** for README.md.
- Hold on the applied state.
- Show the sanitized `git status` and `git diff` proof, confirming the change landed without an automatic commit.
- Narration: “Only approved changes reach your working tree, and commits are still yours to make. If the change is wrong, discard the isolated copy.”

## Outro · Escalate important decisions (~5s)

- Return to the full workbench or briefly open **+ Meeting**.
- Narration: “Use the workbench for everyday collaboration, then escalate important decisions to a structured committee—the same AI team, with two levels of rigor.”

---

## One-line README copy

> Bring Claude Code and Codex into one local workspace: chat together, challenge each other, change code in isolation, and approve every diff yourself.

## Editing notes

- Remove model wait time while preserving the visible send-to-result transition.
- Give the expanded diff and applied state an extra beat.
- Never show API keys, private paths, unrelated session titles, or sensitive filenames.
