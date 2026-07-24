import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractJson, buildDecisionGenPrompt, generateDecisionCandidate } from './decisionGenService';

const FEW_SHOT_EXAMPLE = {
  decision: 'Example Decision',
  level: 'Operational' as const,
  description: 'An example.',
  nature: 'Traditional' as const,
  offensiveAction: false,
  excludes: [],
  impacts: { cash: { type: 'absolute' as const, schedule: { default: -10000 } } },
};

describe('extractJson', () => {
  it('parses a clean JSON object', () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it('strips a <think>...</think> reasoning block before parsing', () => {
    expect(extractJson('<think>reasoning here</think>{"a": 1}')).toEqual({ a: 1 });
  });

  it('strips markdown code fences', () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it('ignores stray prose before and after the JSON object', () => {
    expect(extractJson('Sure, here is the decision:\n{"a": 1}\nHope that helps!')).toEqual({ a: 1 });
  });

  it('balance-matches nested braces correctly', () => {
    expect(extractJson('{"a": {"b": 1}, "c": 2}')).toEqual({ a: { b: 1 }, c: 2 });
  });

  it('throws when no JSON object is present', () => {
    expect(() => extractJson('no json here')).toThrow();
  });

  it('throws when braces are unbalanced', () => {
    expect(() => extractJson('{"a": 1')).toThrow();
  });
});

describe('buildDecisionGenPrompt', () => {
  it('includes the theme/level/nature hints in the user message when provided', () => {
    const { user } = buildDecisionGenPrompt(
      { theme: 'space piracy', level: 'Strategic', nature: 'Dirty', offensive: true },
      [],
      FEW_SHOT_EXAMPLE,
    );
    expect(user).toContain('space piracy');
    expect(user).toContain('Strategic');
    expect(user).toContain('Dirty');
    expect(user).toContain('target.');
  });

  it('lists existing decision names to avoid in the user message', () => {
    const { user } = buildDecisionGenPrompt({}, ['Bot Attack', 'New Factory'], FEW_SHOT_EXAMPLE);
    expect(user).toContain('Bot Attack');
    expect(user).toContain('New Factory');
  });

  it('embeds the few-shot example in the system message', () => {
    const { system } = buildDecisionGenPrompt({}, [], FEW_SHOT_EXAMPLE);
    expect(system).toContain('Example Decision');
  });
});

function mockFetchContent(content: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ choices: [{ message: { content } }] }),
  });
}

describe('generateDecisionCandidate', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.resetAllMocks();
  });

  it('returns success with a clamped decision when the model outputs valid JSON on the first try', async () => {
    global.fetch = mockFetchContent(JSON.stringify({
      decision: 'Generated Decision',
      level: 'Operational',
      description: 'A generated test decision.',
      nature: 'Traditional',
      offensiveAction: false,
      excludes: [],
      impacts: { cash: { type: 'absolute', schedule: { default: -20000 } } },
      legalRisks: [],
    })) as any;

    const result = await generateDecisionCandidate({}, [], FEW_SHOT_EXAMPLE as any);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.decision.decision).toBe('Generated Decision');
      expect(result.attempts).toBe(1);
    }
  });

  it('retries on a schema-invalid response and succeeds on a later attempt', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: '{"decision": 123}' } }] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          choices: [{
            message: {
              content: JSON.stringify({
                decision: 'Second Try Decision',
                level: 'Strategic',
                description: 'Worked the second time.',
                nature: 'Grey Area',
                offensiveAction: false,
                excludes: [],
                impacts: { cash: { type: 'absolute', schedule: { default: -30000 } } },
              }),
            },
          }],
        }),
      }) as any;

    const result = await generateDecisionCandidate({}, [], FEW_SHOT_EXAMPLE as any);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.decision.decision).toBe('Second Try Decision');
      expect(result.attempts).toBe(2);
    }
  });

  it('returns failure with the last raw output after exhausting all attempts', async () => {
    global.fetch = mockFetchContent('this is not json at all') as any;

    const result = await generateDecisionCandidate({}, [], FEW_SHOT_EXAMPLE as any);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.attempts).toBe(3);
      expect(result.raw).toBe('this is not json at all');
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('treats a candidate with no viable impacts (all fields hallucinated) as a failed attempt', async () => {
    global.fetch = mockFetchContent(JSON.stringify({
      decision: 'Empty Decision',
      level: 'Operational',
      description: 'Nothing real here.',
      nature: 'Traditional',
      offensiveAction: false,
      excludes: [],
      impacts: { totallyMadeUpField: { type: 'absolute', schedule: { default: 1 } } },
    })) as any;

    const result = await generateDecisionCandidate({}, [], FEW_SHOT_EXAMPLE as any);

    expect(result.success).toBe(false);
  });
});
