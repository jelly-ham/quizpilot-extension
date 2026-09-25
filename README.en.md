# QuizPilot

[中文](README.md)

QuizPilot is an AI study helper for practice questions on the web, as a Chrome extension. One click on a practice, homework or self-test page reads the questions and suggests answers with a confidence score, so you can check your reasoning and find the gaps.

This repository holds the source of the QuizPilot extension and its model adapters. Website: <https://quizpilot.link>

## Features

- Multiple choice, multiple answer, true/false, fill-in, short answer, and questions with pictures
- Reads question text straight from the page; uses a screenshot and a multimodal model only when the text is incomplete or the question is an image or canvas
- Learns an unusual site's question layout once from a screenshot, then reuses it
- The answer panel shows confidence; fill answers in or undo in one click, and it never submits for you
- Assist mode only marks the suggested answer, and you pick it yourself
- Continuous practice: on one-question-per-page quizzes it moves on by itself, stops when you say, and stops before the last question
- Select an area to solve, right-click menu, keyboard shortcuts

## Two ways to use it

- **Free**: add your own model API key (Jev, or any OpenAI-compatible service, local models included). The key stays in your browser, and questions go straight from the browser to the provider you chose, never through our servers. All of that code is in this repository, so you can check it.
- **Credits**: sign in to the hosted service at quizpilot.link and pay per use. Its backend is not in this repository; extensions you build yourself use Free mode only.

## Layout

```
apps/extension      Chrome extension (MV3, Vite + Preact)
  src/content       reading questions (extract), filling in (fill), the on-page answer panel (ui)
  src/background    the answering pipeline, screenshots, continuous mode
  src/popup         toolbar popup
  src/options       settings page
  e2e               end-to-end tests (Playwright, against mocked model APIs)
packages/providers  model adapters: Jev, OpenAI-compatible APIs, routing and review
packages/shared     types and validation shared with the backend
```

## Development

Requires Node.js 22+ and pnpm.

```bash
pnpm install
pnpm --filter @quizpilot/extension dev       # dev mode; load apps/extension/dist in chrome://extensions
pnpm typecheck
pnpm test                                    # unit tests
pnpm --filter @quizpilot/extension test:e2e  # end-to-end tests (needs Playwright's Chromium)
pnpm --filter @quizpilot/extension build
```

The build lands in `apps/extension/dist`. Turn on Developer mode in `chrome://extensions` and choose "Load unpacked".

## Site support

Question reading is not tied to particular sites: the extension infers questions, options and answer controls from the page structure. If a site is read wrong, please open an issue with:

1. The page address (say so if it needs a login);
2. A debug log: Settings → Debugging → turn on "Record a debug log", reproduce the problem, then "Copy log" or "Download log". The log holds questions, options and processing steps, never API keys.

With a fix, please add a test built from that site's real markup in `apps/extension/src/content/extract/*.test.ts`.

## Use it responsibly

QuizPilot is a study aid. Use it only for practice, homework and self-tests where such tools are allowed, and follow the rules of your school, exam body and the website. Do not use it in exams or assessments that prohibit it.

## License and trademark

The code is released under the [GNU AGPL-3.0](LICENSE).

The QuizPilot name and logo are not covered by the license. If you publish a modified version, please give it a different name and icon.
