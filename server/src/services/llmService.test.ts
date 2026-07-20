import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateAnnualReportBlurb } from './llmService';

function makeRequest(overrides: Partial<Parameters<typeof generateAnnualReportBlurb>[0]> = {}) {
  return {
    decisionName: 'Bot Attack',
    description: 'Launch a coordinated cyberattack against a competitor.',
    elapsedYears: 1,
    fallback: 'Executing automated, unprompted server stress-testing protocols on sector peers.',
    ...overrides,
  };
}

function mockFetchOk(content: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ choices: [{ message: { content } }] }),
  });
}

describe('generateAnnualReportBlurb', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns the sanitized LLM response on success', async () => {
    global.fetch = mockFetchOk('  "Aggressively pivoting toward synergistic disruption."  ') as any;

    const text = await generateAnnualReportBlurb(makeRequest({ decisionName: 'Unique Decision A' }));

    expect(text).toBe('Aggressively pivoting toward synergistic disruption.');
  });

  it('strips a Qwen3 <think>...</think> reasoning block before returning', async () => {
    global.fetch = mockFetchOk(
      '<think>the user wants corporate jargon</think>Streamlining core competencies for market alignment.',
    ) as any;

    const text = await generateAnnualReportBlurb(makeRequest({ decisionName: 'Unique Decision B' }));

    expect(text).toBe('Streamlining core competencies for market alignment.');
  });

  it('falls back to the caller-supplied text when the server responds non-OK', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as any;
    const req = makeRequest({ decisionName: 'Unique Decision C' });

    const text = await generateAnnualReportBlurb(req);

    expect(text).toBe(req.fallback);
  });

  it('falls back to the caller-supplied text when the request fails (e.g. connection refused, or the abort timeout firing)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('fetch failed')) as any;
    const req = makeRequest({ decisionName: 'Unique Decision D' });

    const text = await generateAnnualReportBlurb(req);

    expect(text).toBe(req.fallback);
  });

  it('falls back when the response has no usable content', async () => {
    global.fetch = mockFetchOk('') as any;
    const req = makeRequest({ decisionName: 'Unique Decision E' });

    const text = await generateAnnualReportBlurb(req);

    expect(text).toBe(req.fallback);
  });

  it('caches by decisionName + elapsedYears — a repeat request does not call the LLM again', async () => {
    const fetchMock = mockFetchOk('Cached blurb text.');
    global.fetch = fetchMock as any;
    const req = makeRequest({ decisionName: 'Unique Decision F', elapsedYears: 2 });

    const first = await generateAnnualReportBlurb(req);
    const second = await generateAnnualReportBlurb(req);

    expect(first).toBe('Cached blurb text.');
    expect(second).toBe('Cached blurb text.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a different elapsedYears for the same decision as a fresh cache key', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: 'Year one text.' } }] }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: 'Year two text.' } }] }) });
    global.fetch = fetchMock as any;

    const yearOne = await generateAnnualReportBlurb(makeRequest({ decisionName: 'Unique Decision G', elapsedYears: 5 }));
    const yearTwo = await generateAnnualReportBlurb(makeRequest({ decisionName: 'Unique Decision G', elapsedYears: 6 }));

    expect(yearOne).toBe('Year one text.');
    expect(yearTwo).toBe('Year two text.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
