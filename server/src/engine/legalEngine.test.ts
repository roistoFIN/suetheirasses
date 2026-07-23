import { describe, it, expect } from 'vitest';
import { LegalEngine } from './legalEngine';
import type { AdminVariables, LegalCaseData } from '@suetheirasses/shared';

// ── Helpers ──────────────────────────────────────────────────

function makeAdmin(overrides: Partial<AdminVariables> = {}): AdminVariables {
  return {
    competitiveness: {
      competitivenessWeight_quality_wq: 0.3,
      competitivenessWeight_supply_ws: 0.2,
      competitivenessWeight_loss_wl: 0.15,
      competitivenessWeight_demand_wd: 0.1,
      outrageDemandWeight: 0.5,
    },
    finance: {
      baseFinanceCost: 2000,
      interestRate: 0.05,
      taxRate: 0.2,
      daysSalesOutstanding_DSO: 30,
    },
    legalProcess: {
      scrutinyLegalRiskMultiplier: 0.02,
      legalExposureRatioCap: 0.8,
      semaphoreGreenMax: 0.15,
      semaphoreYellowMax: 0.4,
      buySharesLegalRiskThresholdPercent: 0.05,
    },
    riskGauge: {
      riskWeightLegalExposure_w1: 0.3,
      riskWeightScrutiny_w2: 0.2,
      riskWeightOutrage_w3: 0.25,
    },
    ownership: {
      takeoverThresholdPercent: 0.5,
    },
    depreciation: {
      assetUsefulLifeYears: 10,
      intangibleUsefulLifeYears: 5,
    },
    ...overrides,
  };
}

function makeLegalRiskDef(overrides: Partial<import('@suetheirasses/shared').LegalRiskDefinition> = {}) {
  return {
    name: 'Breach of Contract',
    description: 'Sue for breach',
    probability: { 1: 0.05, 2: 0.1, default: 0.15 },
    impact: {
      type: 'absolute',
      target: 'cash',
      schedule: { 1: 5000, 2: 10000, default: 15000 },
    },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('LegalEngine', () => {
  let engine: LegalEngine;

  beforeEach(() => {
    engine = new LegalEngine();
    engine.setDefinitions([
      {
        decision: 'Water Pumping',
        level: 'Operational',
        description: 'Pump water from competitor territory',
        nature: 'Dirty',
        offensiveAction: true,
        excludes: [],
        impacts: {
          materialCostPerTon: { type: 'absolute', schedule: { default: -50 } },
        },
        legalRisks: [
          makeLegalRiskDef({
            name: 'Environmental Violation',
            description: 'Sue for environmental damage',
            probability: { 1: 0.06, 2: 0.12, default: 0.18 },
            impact: {
              type: 'absolute',
              target: 'cash',
              schedule: { 1: 7350, 2: 14700, default: 22050 },
            },
          }),
        ],
      },
      {
        decision: 'Buy Shares',
        level: 'Strategic',
        description: 'Buy shares of competitor',
        nature: 'Grey Area',
        offensiveAction: true,
        excludes: [],
        impacts: {
          cash: { type: 'absolute', schedule: { default: -5000 } },
        },
        legalRisks: [
          makeLegalRiskDef({
            name: 'Securities Violation',
            description: 'Sue for failing to disclose ownership',
            probability: { 1: 0.32, default: 0.32 },
            impact: {
              type: 'absolute',
              target: 'cash',
              schedule: { default: 45000 },
            },
          }),
        ],
      },
      {
        decision: 'Safe Decision',
        level: 'Operational',
        description: 'A decision with no legal risks',
        nature: 'Traditional',
        offensiveAction: false,
        excludes: [],
        impacts: {
          processingLevel: { type: 'absolute', schedule: { default: 0.05 } },
        },
      },
    ]);
  });

  describe('fileLawsuit', () => {
    it('should create a case when the target actually deployed the cited decision', () => {
      const targetActive = [{ decisionName: 'Buy Shares', elapsedYears: 0 }];
      const result = engine.fileLawsuit('player-2', 'player-1', 'Buy Shares', 'Securities Violation', targetActive, 'room-1', false);

      expect(result).not.toBeNull();
      expect(result?.groundName).toBe('Securities Violation');
    });

    it('should return null for a decision without legal risks', () => {
      const targetActive = [{ decisionName: 'Safe Decision', elapsedYears: 0 }];
      const result = engine.fileLawsuit('player-2', 'player-1', 'Safe Decision', 'Anything', targetActive, 'room-1', false);

      expect(result).toBeNull();
    });

    it('should have no automatic "evaluate on deploy" path — the old evaluateForPlayer method is gone', () => {
      expect((engine as any).evaluateForPlayer).toBeUndefined();
    });

    it('should set the decision-maker as defendant and the suer as plaintiff', () => {
      const targetActive = [{ decisionName: 'Water Pumping', elapsedYears: 0 }];
      const result = engine.fileLawsuit('player-2', 'player-1', 'Water Pumping', 'Environmental Violation', targetActive, 'room-1', false);

      expect(result?.defendantId).toBe('player-1');
      expect(result?.plaintiffId).toBe('player-2');
    });

    it('should still create a case — a hopeless, 0%-probability one — when the target never deployed the cited decision (a wrong guess)', () => {
      const targetActive = [{ decisionName: 'Safe Decision', elapsedYears: 0 }];
      const result = engine.fileLawsuit('player-2', 'player-1', 'Water Pumping', 'Environmental Violation', targetActive, 'room-1', false);

      expect(result).not.toBeNull();
      expect(result?.groundName).toBe('Environmental Violation');
      expect(result?.baseProbability).toBe(0);
    });

    it('should still set real stakes for a wrong-guess case, unaffected by there being no real target instance to price elapsedYears against', () => {
      const targetActive: { decisionName: string; elapsedYears: number }[] = [];
      const result = engine.fileLawsuit('player-2', 'player-1', 'Water Pumping', 'Environmental Violation', targetActive, 'room-1', false);

      expect(result?.stakes).toBe(22050);
    });

    it('should return null for an unknown ground name', () => {
      const targetActive = [{ decisionName: 'Water Pumping', elapsedYears: 0 }];
      const result = engine.fileLawsuit('player-2', 'player-1', 'Water Pumping', 'Made Up Ground', targetActive, 'room-1', false);

      expect(result).toBeNull();
    });

    it('should return null for an unknown decision name', () => {
      const result = engine.fileLawsuit('player-2', 'player-1', 'Nonexistent Decision', 'Anything', [], 'room-1', false);

      expect(result).toBeNull();
    });

    it('should use the year-1 probability schedule when the decision was just deployed (elapsedYears=0)', () => {
      const targetActive = [{ decisionName: 'Water Pumping', elapsedYears: 0 }];
      const result = engine.fileLawsuit('player-2', 'player-1', 'Water Pumping', 'Environmental Violation', targetActive, 'room-1', false);

      expect(result?.baseProbability).toBeCloseTo(0.06, 4);
    });

    it('should use the year-2 probability schedule after one turn has elapsed', () => {
      const targetActive = [{ decisionName: 'Water Pumping', elapsedYears: 1 }];
      const result = engine.fileLawsuit('player-2', 'player-1', 'Water Pumping', 'Environmental Violation', targetActive, 'room-1', false);

      expect(result?.baseProbability).toBeCloseTo(0.12, 4);
    });

    it('should fall through to the default probability once past the explicit schedule', () => {
      const targetActive = [{ decisionName: 'Water Pumping', elapsedYears: 5 }];
      const result = engine.fileLawsuit('player-2', 'player-1', 'Water Pumping', 'Environmental Violation', targetActive, 'room-1', false);

      expect(result?.baseProbability).toBeCloseTo(0.18, 4);
    });

    it('should set correct stakes from the impact schedule', () => {
      const targetActive = [{ decisionName: 'Water Pumping', elapsedYears: 0 }];
      const result = engine.fileLawsuit('player-2', 'player-1', 'Water Pumping', 'Environmental Violation', targetActive, 'room-1', false);

      expect(result?.stakes).toBe(22050);
    });

    it('should set correct stakes for default-only impacts', () => {
      const targetActive = [{ decisionName: 'Buy Shares', elapsedYears: 0 }];
      const result = engine.fileLawsuit('player-2', 'player-1', 'Buy Shares', 'Securities Violation', targetActive, 'room-1', false);

      expect(result?.stakes).toBe(45000);
    });

    it('should set correct metadata on the case', () => {
      const targetActive = [{ decisionName: 'Water Pumping', elapsedYears: 0 }];
      const result = engine.fileLawsuit('player-2', 'player-1', 'Water Pumping', 'Environmental Violation', targetActive, 'room-1', false);

      expect(result?.defendantId).toBe('player-1');
      expect(result?.plaintiffId).toBe('player-2');
      expect(result?.decisionName).toBe('Water Pumping');
      expect(result?.roomId).toBe('room-1');
      expect(result?.groundName).toBe('Environmental Violation');
      expect(result?.description).toBe('Sue for environmental damage');
      expect(result?.status).toBe('negotiating');
      expect(result?.offers).toHaveLength(0);
      expect(result?.verdict).toBeUndefined();
      expect(result?.adjustedProbability).toBeUndefined();
      expect(result?.createdAt).toBeInstanceOf(Date);
      expect(result?.plaintiffFullyInvestigated).toBe(false);
    });

    it('should generate unique case IDs across separate filings', () => {
      const targetActive = [{ decisionName: 'Water Pumping', elapsedYears: 0 }];
      const first = engine.fileLawsuit('player-2', 'player-1', 'Water Pumping', 'Environmental Violation', targetActive, 'room-1', false);
      const second = engine.fileLawsuit('player-3', 'player-1', 'Water Pumping', 'Environmental Violation', targetActive, 'room-1', false);

      expect(first?.id).not.toBe(second?.id);
    });

    it('should stamp plaintiffFullyInvestigated as true when the caller passes true', () => {
      const targetActive = [{ decisionName: 'Water Pumping', elapsedYears: 0 }];
      const result = engine.fileLawsuit('player-2', 'player-1', 'Water Pumping', 'Environmental Violation', targetActive, 'room-1', true);

      expect(result?.plaintiffFullyInvestigated).toBe(true);
    });

    describe('statute of limitations', () => {
      it('should still price a real probability just under the limit', () => {
        const targetActive = [{ decisionName: 'Water Pumping', elapsedYears: 9 }];
        const result = engine.fileLawsuit('player-2', 'player-1', 'Water Pumping', 'Environmental Violation', targetActive, 'room-1', false, 10);

        expect(result?.baseProbability).toBeCloseTo(0.18, 4);
      });

      it('should still create a case — a hopeless, 0%-probability one — once elapsedYears reaches the limit', () => {
        const targetActive = [{ decisionName: 'Water Pumping', elapsedYears: 10 }];
        const result = engine.fileLawsuit('player-2', 'player-1', 'Water Pumping', 'Environmental Violation', targetActive, 'room-1', false, 10);

        expect(result).not.toBeNull();
        expect(result?.groundName).toBe('Environmental Violation');
        expect(result?.baseProbability).toBe(0);
      });

      it('should stay 0% for a decision aged well past the limit', () => {
        const targetActive = [{ decisionName: 'Water Pumping', elapsedYears: 25 }];
        const result = engine.fileLawsuit('player-2', 'player-1', 'Water Pumping', 'Environmental Violation', targetActive, 'room-1', false, 10);

        expect(result?.baseProbability).toBe(0);
      });

      it('should not time-bar anything when the caller omits the limit (defaults to Infinity, pre-feature behavior)', () => {
        const targetActive = [{ decisionName: 'Water Pumping', elapsedYears: 999 }];
        const result = engine.fileLawsuit('player-2', 'player-1', 'Water Pumping', 'Environmental Violation', targetActive, 'room-1', false);

        expect(result?.baseProbability).toBeCloseTo(0.18, 4);
      });

      it('should still set real stakes for a time-barred case — only the probability is zeroed', () => {
        const targetActive = [{ decisionName: 'Water Pumping', elapsedYears: 10 }];
        const result = engine.fileLawsuit('player-2', 'player-1', 'Water Pumping', 'Environmental Violation', targetActive, 'room-1', false, 10);

        expect(result?.stakes).toBe(22050);
      });
    });
  });

  describe('resolveProbability', () => {
    it('should calculate adjusted probability with scrutiny', () => {
      const admin = makeAdmin();
      const result = engine.resolveProbability(0.5, 10, 0, admin);
      // 0.5 * (1 + 0.02 * 10 / 100 + 0) = 0.5 * (1 + 0.002) = 0.501
      expect(result).toBeCloseTo(0.501, 4);
    });

    it('should return base probability when scrutiny is zero', () => {
      const admin = makeAdmin();
      const result = engine.resolveProbability(0.3, 0, 0, admin);
      expect(result).toBeCloseTo(0.3, 4);
    });

    it('should scale linearly with scrutiny multiplier', () => {
      const admin = makeAdmin({
        legalProcess: { 
          scrutinyLegalRiskMultiplier: 0.05,
          legalExposureRatioCap: 0.8,
          semaphoreGreenMax: 0.15,
          semaphoreYellowMax: 0.4,
          buySharesLegalRiskThresholdPercent: 0.05,
        },
      });
      const result = engine.resolveProbability(0.5, 10, 0, admin);
      // 0.5 * (1 + 0.05 * 10 / 100 + 0) = 0.5 * (1 + 0.005) = 0.5025
      expect(result).toBeCloseTo(0.5025, 4);
    });

    it('should handle high scrutiny values', () => {
      const admin = makeAdmin();
      const result = engine.resolveProbability(0.5, 100, 0, admin);
      // 0.5 * (1 + 0.02 * 100 / 100 + 0) = 0.5 * (1 + 0.02) = 0.51
      expect(result).toBeCloseTo(0.51, 4);
    });

    it('should handle zero base probability', () => {
      const admin = makeAdmin();
      const result = engine.resolveProbability(0, 50, 0, admin);
      expect(result).toBe(0);
    });

    it('should increase probability with legal exposure ratio', () => {
      const admin = makeAdmin();
      const r1 = engine.resolveProbability(0.5, 0, 0, admin);
      const r2 = engine.resolveProbability(0.5, 0, 0.4, admin);
      // r1 = 0.5 * (1 + 0) = 0.5
      // r2 = 0.5 * (1 + 0.4) = 0.7
      expect(r2).toBeGreaterThan(r1);
      expect(r2).toBeCloseTo(0.7, 4);
    });
  });
});
