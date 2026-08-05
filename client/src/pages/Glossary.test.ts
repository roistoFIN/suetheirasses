import { describe, it, expect } from 'vitest';
import { LEGAL_TERMS, BUSINESS_TERMS, type GlossaryTerm } from './Glossary';

function expectWellFormed(terms: GlossaryTerm[]) {
  for (const t of terms) {
    expect(t.term.trim()).not.toBe('');
    expect(t.definition.trim()).not.toBe('');
  }
}

function expectAlphabetical(terms: GlossaryTerm[]) {
  const names = terms.map((t) => t.term.toLowerCase());
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  expect(names).toEqual(sorted);
}

describe('LEGAL_TERMS', () => {
  it('is non-empty and every entry is well-formed', () => {
    expect(LEGAL_TERMS.length).toBeGreaterThan(0);
    expectWellFormed(LEGAL_TERMS);
  });

  it('is alphabetized', () => {
    expectAlphabetical(LEGAL_TERMS);
  });

  it('has no duplicate terms', () => {
    const names = LEGAL_TERMS.map((t) => t.term);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('BUSINESS_TERMS', () => {
  it('is non-empty and every entry is well-formed', () => {
    expect(BUSINESS_TERMS.length).toBeGreaterThan(0);
    expectWellFormed(BUSINESS_TERMS);
  });

  it('is alphabetized', () => {
    expectAlphabetical(BUSINESS_TERMS);
  });

  it('has no duplicate terms', () => {
    const names = BUSINESS_TERMS.map((t) => t.term);
    expect(new Set(names).size).toBe(names.length);
  });
});
