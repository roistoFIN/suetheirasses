/**
 * Client for the local llama.cpp inference server (see the `llm` service in
 * docker-compose.yml, model mounted from `./models/`) — generates narrated "annual
 * report" flavor text for a rival's active decisions. This module does real network
 * I/O, so (per the two-layer architecture in CLAUDE.md) it's only ever called from
 * `GameEngine`, never from the pure `GameLoop`.
 *
 * Deliberately best-effort: the game must be fully playable with this service down,
 * unreachable, or the model still loading — every call falls back to the caller-
 * supplied static text (`DecisionDefinition.competitorsView`) on any error or timeout.
 */

const LLM_URL = process.env.LLM_URL || 'http://localhost:8080';
const REQUEST_TIMEOUT_MS = 8_000;

/** In-memory cache keyed by `${decisionName}#${elapsedYears}` — same decision/age combo
 * is asked for repeatedly (every player who opens that rival's Full Filing), and the
 * flavor text has no reason to vary per requester, so one generation covers everyone
 * for the life of the process. */
const cache = new Map<string, string>();

export interface AnnualReportBlurbRequest {
  decisionName: string;
  description: string;
  elapsedYears: number;
  /** Used verbatim if the LLM call fails or times out. */
  fallback: string;
}

export async function generateAnnualReportBlurb(req: AnnualReportBlurbRequest): Promise<string> {
  const cacheKey = `${req.decisionName}#${req.elapsedYears}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const text = await requestBlurb(req);
    cache.set(cacheKey, text);
    return text;
  } catch {
    return req.fallback;
  }
}

async function requestBlurb({ decisionName, description, elapsedYears }: AnnualReportBlurbRequest): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${LLM_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content:
              'You write a single-sentence corporate press-release blurb for a company\'s ' +
              'annual report, describing one strategic move in vague, upbeat corporate PR ' +
              'jargon. Never mention numbers, dollar amounts, or percentages. Output ONLY ' +
              'the sentence itself — no quotes, no preamble, no explanation.',
          },
          {
            role: 'user',
            // Qwen3 only honors the /no_think switch when it's on the user turn, not the
            // system prompt (confirmed live: system-prompt placement still emitted a
            // <think> block every time) — see sanitize()'s doc comment for what happens
            // if a think block ever leaks through anyway.
            content: `Move: "${decisionName}" — ${description}. It has been running for ${elapsedYears} year(s). Write the blurb. /no_think`,
          },
        ],
        max_tokens: 80,
        temperature: 0.9,
        stop: ['\n'],
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM server responded with status ${response.status}`);
    }

    const data: any = await response.json();
    const raw: string = data?.choices?.[0]?.message?.content ?? '';
    const text = sanitize(raw);
    if (!text) throw new Error('Empty LLM response');
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

/** Strips Qwen3's optional `<think>...</think>` reasoning block and surrounding quotes/whitespace.
 * Also defensively drops everything from an unclosed `<think>` tag onward — this was a real,
 * reported bug: `/no_think` in the system prompt didn't actually suppress the model's reasoning
 * mode, and the `stop: ['\n']` sequence then truncated generation right after `<think>\n`, before
 * the closing tag, so the well-formed-pair regex alone let a bare "<think>" leak through as if it
 * were real blurb text (and get cached forever under `requestBlurb`'s cache key). `/no_think` now
 * lives on the user turn instead, where it's actually honored — this second strip stays as a
 * defense-in-depth backstop in case a think block (complete or truncated) ever shows up again. */
function sanitize(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .trim();
}
