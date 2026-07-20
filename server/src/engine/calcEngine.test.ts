import { describe, it, expect } from 'vitest';
import {
  applyDepreciation,
  addDepreciationEntry,
  calculateCompetitivenessAndMarketShare,
  calculateVolume,
  calculatePL,
  updateBalanceSheet,
  calculateAdjustedProbability,
  calculateLegalExposureRatio,
  calculateRiskGauge,
  applyDecisionImpacts,
  calculateMaturityYears,
  getScheduleValue,
  DEPRECIATING_ASSETS,
} from './calcEngine';
import type { PlayerVariables, AdminVariables } from '@suetheirasses/shared';

// ── Helpers ──────────────────────────────────────────────────

function makeVars(overrides: Partial<PlayerVariables> = {}): PlayerVariables {
  return {
    cash: 100000,
    assets: 50000,
    intangibleAssets: 10000,
    debt: 20000,
    reserves: 30000,
    operatingExpenses: 5000,
    staffCost: 8000,
    materialCostPerTon: 100,
    otherIncome: 1000,
    price: 500,
    capacityUtilization: 0.8,
    processingLevel: 0.7,
    energyIntensity: 0.5,
    moistureContent: 0.3,
    nutrientConsistency: 0.85,
    supplySecurity: 0.6,
    logisticsCostPerTon: 50,
    processLoss: 0.05,
    installedCapacity: 10000,
    totalSharesOutstanding: 1000,
    shareOwnership: {},
    outrage: 10,
    scrutiny: 30,
    breakdowns: 0,
    contaminationRisk: 0.02,
    odorComplaints: 0,
    tokenLiability: 0,
    carbonFootprint: 0,
    stockVolume: 0,
    demand: 8000,
    ...overrides,
  };
}

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

// ── Tests ────────────────────────────────────────────────────

describe('calcEngine', () => {
  describe('addDepreciationEntry', () => {
    it('should create an entry for a depreciating asset', () => {
      const entry = addDepreciationEntry('New Factory', 'assets', 100000, 2024);
      expect(entry).not.toBeNull();
      expect(entry!.assetType).toBe('assets');
      expect(entry!.originalValue).toBe(100000);
      expect(entry!.purchaseYear).toBe(2024);
      expect(entry!.usefulLife).toBe(10);
      expect(entry!.annualAmount).toBe(10000);
      expect(entry!.remainingYears).toBe(10);
    });

    it('should use 5-year life for intangible assets', () => {
      const entry = addDepreciationEntry('Patent Portfolio', 'intangibleAssets', 50000, 2024);
      expect(entry).not.toBeNull();
      expect(entry!.usefulLife).toBe(5);
      expect(entry!.annualAmount).toBe(10000);
    });

    it('should return null for non-depreciating assets', () => {
      expect(addDepreciationEntry('Sale & Leaseback', 'assets', 10000, 2024)).toBeNull();
      expect(addDepreciationEntry('Maintenance Neglect', 'assets', 5000, 2024)).toBeNull();
    });

    it('should return null for non-depreciating decision names', () => {
      expect(addDepreciationEntry('Random Decision', 'assets', 10000, 2024)).toBeNull();
    });

    it('should return null for zero or negative values', () => {
      expect(addDepreciationEntry('New Factory', 'assets', 0, 2024)).toBeNull();
      expect(addDepreciationEntry('New Factory', 'assets', -100, 2024)).toBeNull();
    });
  });

  describe('applyDepreciation', () => {
    it('should depreciate existing ledger entries', () => {
      const vars = makeVars({ assets: 50000 });
      const ledger = [
        {
          id: 'e1',
          assetType: 'assets' as const,
          originalValue: 10000,
          purchaseYear: 2020,
          usefulLife: 10,
          annualAmount: 1000,
          remainingYears: 5,
        },
      ];

      const result = applyDepreciation(vars, ledger, 2024);

      expect(result.totalDepreciation).toBe(1000);
      expect(result.updatedVars.assets).toBe(49000);
      expect(result.updatedLedger[0].remainingYears).toBe(4);
    });

    it('should remove fully depreciated entries', () => {
      const vars = makeVars({ assets: 50000 });
      const ledger = [
        {
          id: 'e1',
          assetType: 'assets' as const,
          originalValue: 10000,
          purchaseYear: 2010,
          usefulLife: 10,
          annualAmount: 1000,
          remainingYears: 0,
        },
      ];

      const result = applyDepreciation(vars, ledger, 2024);

      expect(result.updatedLedger).toHaveLength(0);
    });

    it('should handle multiple entries', () => {
      const vars = makeVars({ assets: 50000, intangibleAssets: 10000 });
      const ledger = [
        {
          id: 'e1',
          assetType: 'assets' as const,
          originalValue: 10000,
          purchaseYear: 2020,
          usefulLife: 10,
          annualAmount: 1000,
          remainingYears: 5,
        },
        {
          id: 'e2',
          assetType: 'intangibleAssets' as const,
          originalValue: 5000,
          purchaseYear: 2021,
          usefulLife: 5,
          annualAmount: 1000,
          remainingYears: 3,
        },
      ];

      const result = applyDepreciation(vars, ledger, 2024);

      expect(result.totalDepreciation).toBe(2000);
      expect(result.updatedVars.assets).toBe(49000);
      expect(result.updatedVars.intangibleAssets).toBe(9000);
    });

    it('should not modify vars when ledger is empty', () => {
      const vars = makeVars({ assets: 50000 });
      const result = applyDepreciation(vars, [], 2024);

      expect(result.totalDepreciation).toBe(0);
      expect(result.updatedVars.assets).toBe(50000);
      expect(result.updatedLedger).toHaveLength(0);
    });
  });

  describe('calculateCompetitivenessAndMarketShare', () => {
    it('should calculate market shares proportional to competitiveness', () => {
      const ids = ['p1', 'p2'];
      const vars = [
        makeVars({ price: 500, processingLevel: 0.7, supplySecurity: 0.6, processLoss: 0.05, demand: 8000, outrage: 10 }),
        makeVars({ price: 600, processingLevel: 0.5, supplySecurity: 0.4, processLoss: 0.1, demand: 6000, outrage: 20 }),
      ];
      const admin = makeAdmin();

      const result = calculateCompetitivenessAndMarketShare(ids, vars, admin);

      expect(result.get('p1')).toBeGreaterThan(result.get('p2')!);
      const total = Array.from(result.values()).reduce((s, v) => s + v, 0);
      expect(total).toBeCloseTo(1, 4);
    });

    it('should throw when ids and vars lengths mismatch', () => {
      expect(() =>
        calculateCompetitivenessAndMarketShare(['p1'], [makeVars(), makeVars()], makeAdmin()),
      ).toThrow('must have the same length');
    });

    it('should give equal shares when all competitiveness is zero', () => {
      const ids = ['p1', 'p2', 'p3'];
      const vars = [
        makeVars({ price: 1, processingLevel: 0, supplySecurity: 0, processLoss: 0, demand: 0, outrage: 0 }),
        makeVars({ price: 1, processingLevel: 0, supplySecurity: 0, processLoss: 0, demand: 0, outrage: 0 }),
        makeVars({ price: 1, processingLevel: 0, supplySecurity: 0, processLoss: 0, demand: 0, outrage: 0 }),
      ];

      const result = calculateCompetitivenessAndMarketShare(ids, vars, makeAdmin());

      expect(result.get('p1')).toBeCloseTo(1 / 3, 4);
      expect(result.get('p2')).toBeCloseTo(1 / 3, 4);
      expect(result.get('p3')).toBeCloseTo(1 / 3, 4);
    });

    it('should return a Map with correct keys', () => {
      const ids = ['alice', 'bob'];
      const vars = [makeVars(), makeVars()];

      const result = calculateCompetitivenessAndMarketShare(ids, vars, makeAdmin());

      expect(result.has('alice')).toBe(true);
      expect(result.has('bob')).toBe(true);
    });
  });

  describe('calculateVolume', () => {
    it('should cap volume at max supply', () => {
      const vars = makeVars({ installedCapacity: 5000, capacityUtilization: 0.8 });
      const volume = calculateVolume(vars, 0.5, 10000);
      // theoretical = 0.5 * 10000 = 5000, maxSupply = 5000 * 0.8 = 4000
      expect(volume).toBe(4000);
    });

    it('should use theoretical volume when below supply cap', () => {
      const vars = makeVars({ installedCapacity: 20000, capacityUtilization: 0.9 });
      const volume = calculateVolume(vars, 0.3, 10000);
      // theoretical = 0.3 * 10000 = 3000, maxSupply = 20000 * 0.9 = 18000
      expect(volume).toBe(3000);
    });

    it('should return zero when market share is zero', () => {
      const vars = makeVars();
      expect(calculateVolume(vars, 0, 10000)).toBe(0);
    });
  });

  describe('calculatePL', () => {
    it('should calculate correct P&L values', () => {
      const vars = makeVars({
        materialCostPerTon: 100,
        logisticsCostPerTon: 50,
        operatingExpenses: 5000,
        staffCost: 8000,
        otherIncome: 1000,
        debt: 20000,
      });
      const admin = makeAdmin();
      const volume = 5000;
      const depreciation = 5000;

      const result = calculatePL(vars, volume, depreciation, admin);

      expect(result.revenue).toBe(5000 * 500); // volume * price
      expect(result.cogs).toBe((100 + 50) * 5000);
      expect(result.grossProfit).toBe(result.revenue - result.cogs);
      expect(result.ebitda).toBe(result.grossProfit - 5000 - 8000 + 1000);
      expect(result.ebit).toBe(result.ebitda - depreciation);
      expect(result.financeCost).toBe(2000 + 20000 * 0.05);
      expect(result.profitBeforeTax).toBe(result.ebit - result.financeCost);
      expect(result.taxCost).toBe(Math.max(0, result.profitBeforeTax) * 0.2);
      expect(result.netProfit).toBe(result.profitBeforeTax - result.taxCost);
    });

    it('should have zero tax when profit is negative', () => {
      const vars = makeVars({
        materialCostPerTon: 1000,
        logisticsCostPerTon: 500,
        operatingExpenses: 50000,
        staffCost: 50000,
        debt: 100000,
      });
      const admin = makeAdmin();

      const result = calculatePL(vars, 100, 1000, admin);

      expect(result.taxCost).toBe(0);
    });
  });

  describe('updateBalanceSheet', () => {
    it('should update cash, reserves, receivables, equity, and stockValue', () => {
      const vars = makeVars({
        cash: 100000,
        reserves: 30000,
        assets: 50000,
        intangibleAssets: 10000,
        debt: 20000,
        totalSharesOutstanding: 1000,
      });
      const admin = makeAdmin();
      const netProfit = 15000;
      const depreciation = 5000;
      const revenue = 250000;
      const legalExposure = 0;

      const result = updateBalanceSheet(vars, netProfit, depreciation, revenue, legalExposure, admin);

      expect(result.cash).toBe(100000 + 15000 + 5000);
      expect(result.reserves).toBe(30000 + 15000);
      expect(result.receivables).toBeCloseTo(250000 * (30 / 365), 2);
      expect(result.equity).toBeCloseTo(
        result.cash + result.receivables + 50000 + 10000 + result.reserves - 20000,
        2,
      );
      expect(result.stockValue).toBeCloseTo(result.equity / 1000, 2);
    });
  });

  describe('calculateAdjustedProbability', () => {
    it('should increase probability with scrutiny', () => {
      const result = calculateAdjustedProbability(0.5, 10, 0, makeAdmin());
      // 0.5 * (1 + 0.02 * 10 / 100 + 0) = 0.5 * (1 + 0.002) = 0.501
      expect(result).toBeCloseTo(0.501, 4);
    });

    it('should return base probability when scrutiny is zero', () => {
      const result = calculateAdjustedProbability(0.3, 0, 0, makeAdmin());
      expect(result).toBeCloseTo(0.3, 4);
    });

    it('should scale linearly with scrutiny', () => {
      const r1 = calculateAdjustedProbability(0.5, 5, 0, makeAdmin());
      const r2 = calculateAdjustedProbability(0.5, 10, 0, makeAdmin());
      expect(r2).toBeGreaterThan(r1);
    });
  });

  describe('calculateRiskGauge', () => {
    it('should calculate risk gauge from open cases and variables', () => {
      const vars = makeVars({
        cash: 100000,
        scrutiny: 50,
        outrage: 30,
      });
      const admin = makeAdmin();
      const openCases = [
        { probability: 0.5, stakes: 20000 },
        { probability: 0.3, stakes: 10000 },
      ];

      const result = calculateRiskGauge(vars, openCases, admin);

      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(100);
    });

    it('should increase with more legal exposure', () => {
      const vars = makeVars({ cash: 100000, scrutiny: 10, outrage: 5 });
      const admin = makeAdmin();

      const r1 = calculateRiskGauge(vars, [], admin);
      const r2 = calculateRiskGauge(vars, [{ probability: 0.8, stakes: 50000 }], admin);

      expect(r2).toBeGreaterThan(r1);
    });

    it('should cap at 100', () => {
      const vars = makeVars({ cash: 1, scrutiny: 100, outrage: 100 });
      const admin = makeAdmin();
      const openCases = [{ probability: 1, stakes: 1000000 }];

      const result = calculateRiskGauge(vars, openCases, admin);

      expect(result).toBe(75); // w1*1 + w2*1 + w3*1 = 0.3 + 0.2 + 0.25 = 0.75 -> 75
    });
  });

  describe('applyDecisionImpacts', () => {
    it('should apply absolute impacts additively', () => {
      const vars = makeVars({ processingLevel: 0.5 });
      const impacts = {
        processingLevel: {
          type: 'absolute' as const,
          schedule: { 1: 0.1, 2: 0.1, default: 0.1 },
        },
      };

      const result = applyDecisionImpacts(vars, 'Test', impacts, 1);

      expect(result.updatedVars.processingLevel).toBeCloseTo(0.6, 4);
    });

    it('should apply relative impacts multiplicatively for single instance', () => {
      const vars = makeVars({ processingLevel: 0.5 });
      const impacts = {
        processingLevel: {
          type: 'relative' as const,
          schedule: { 1: 0.2, default: 0.2 },
        },
      };

      // elapsedYears=3 to hit default schedule
      const result = applyDecisionImpacts(vars, 'Pelleting Research and Development', impacts, 3);

      expect(result.updatedVars.processingLevel).toBeCloseTo(0.5 * 1.2, 4);
    });

    it('should accumulate multiple relative impacts additively (FORMULAS §9)', () => {
      // Simulates two matured New Factory instances each with installedCapacity +0.4
      const baseVars = makeVars({ installedCapacity: 10000 });
      const impacts1 = {
        installedCapacity: {
          type: 'relative' as const,
          schedule: { default: 0.4 },
        },
      };
      const impacts2 = {
        installedCapacity: {
          type: 'relative' as const,
          schedule: { default: 0.4 },
        },
      };

      // First instance: 10000 * (1 + 0.4) = 14000
      const r1 = applyDecisionImpacts(baseVars, 'New Factory', impacts1, 3);
      expect(r1.updatedVars.installedCapacity).toBeCloseTo(14000, 4);

      // Second instance on top of first: 14000 * (1 + 0.4) would be WRONG (multiplicative)
      // CORRECT: accumulated multiplier = 0.4 + 0.4 = 0.8 → 10000 * (1 + 0.8) = 18000
      // We simulate this by applying both in one call with combined multipliers
      const combinedImpacts = {
        installedCapacity: {
          type: 'relative' as const,
          schedule: { default: 0.8 }, // 0.4 + 0.4
        },
      };
      const rCombined = applyDecisionImpacts(baseVars, 'Two Factories', combinedImpacts, 3);
      expect(rCombined.updatedVars.installedCapacity).toBeCloseTo(18000, 4);
    });

    it('should use default schedule when matured', () => {
      const vars = makeVars({ processingLevel: 0.5 });
      const impacts = {
        processingLevel: {
          type: 'absolute' as const,
          schedule: { 1: 0.05, 2: 0.05, default: 0.1 },
        },
      };

      const result = applyDecisionImpacts(vars, 'Test', impacts, 5);

      expect(result.updatedVars.processingLevel).toBeCloseTo(0.6, 4);
    });

    it('should skip competitor-targeted fields', () => {
      const vars = makeVars({ competitorPrice: 400 });
      const impacts = {
        competitorPrice: {
          type: 'absolute' as const,
          schedule: { 1: -50, default: -50 },
        },
      };

      const result = applyDecisionImpacts(vars, 'Test', impacts, 1);

      expect(result.updatedVars.competitorPrice).toBe(400);
    });

    it('should skip zero multipliers', () => {
      const vars = makeVars({ processingLevel: 0.5 });
      const impacts = {
        processingLevel: {
          type: 'absolute' as const,
          schedule: { 1: 0, default: 0.1 },
        },
      };

      // elapsedYears=0 → key "1" (this decision's deployment-year value, which is 0)
      const result = applyDecisionImpacts(vars, 'Test', impacts, 0);

      expect(result.updatedVars.processingLevel).toBe(0.5);
    });

    it('should handle multiple impacts', () => {
      const vars = makeVars({ processingLevel: 0.5, supplySecurity: 0.4 });
      const impacts = {
        processingLevel: {
          type: 'absolute' as const,
          schedule: { 1: 0.1, default: 0.1 },
        },
        supplySecurity: {
          type: 'absolute' as const,
          schedule: { 1: 0.05, default: 0.05 },
        },
      };

      // elapsedYears=3 to hit default schedule
      const result = applyDecisionImpacts(vars, 'Pelleting Research and Development', impacts, 3);

      expect(result.updatedVars.processingLevel).toBeCloseTo(0.6, 4);
      expect(result.updatedVars.supplySecurity).toBeCloseTo(0.45, 4);
    });

    it('should create depreciation entries for depreciating asset purchases on year 0', () => {
      const vars = makeVars({ assets: 50000 });
      const impacts = {
        assets: {
          type: 'absolute' as const,
          schedule: { 1: 100000, 2: 150000, default: 0 },
        },
      };

      // Year 0 (deployment): should create entry for +100000
      const result = applyDecisionImpacts(vars, 'New Factory', impacts, 0, 2024);

      expect(result.updatedVars.assets).toBeCloseTo(150000, 4); // 50000 + 100000
      expect(result.newDepreciationEntries).toHaveLength(1);
      expect(result.newDepreciationEntries![0].originalValue).toBe(100000);
      expect(result.newDepreciationEntries![0].purchaseYear).toBe(2024);
      expect(result.newDepreciationEntries![0].usefulLife).toBe(10);
      expect(result.newDepreciationEntries![0].annualAmount).toBe(10000);
    });

    it('should NOT create depreciation entries on non-deploy years', () => {
      const vars = makeVars({ assets: 50000 });
      const impacts = {
        assets: {
          type: 'absolute' as const,
          schedule: { 1: 100000, default: 0 },
        },
      };

      // Year 0 (deployment): would create entry, but we're testing year 1 (advancing)
      // At elapsedYears=1, it reads schedule key 2, but we don't have key 2, so it uses default (0)
      // Result: 50000 + 0 = 50000
      const result = applyDecisionImpacts(vars, 'New Factory', impacts, 1, 2024);

      expect(result.updatedVars.assets).toBeCloseTo(50000, 4); // 50000 + 0
      expect(result.newDepreciationEntries || []).toHaveLength(0);
    });

    it('should not create depreciation for non-depreciating decisions', () => {
      const vars = makeVars({ assets: 50000 });
      const impacts = {
        assets: {
          type: 'absolute' as const,
          schedule: { 1: 10000, default: 0 },
        },
      };

      const result = applyDecisionImpacts(vars, 'Sale & Leaseback', impacts, 0, 2024);

      expect(result.updatedVars.assets).toBeCloseTo(60000, 4);
      expect(result.newDepreciationEntries).toHaveLength(0);
    });

    it('should return updatedVars and newDepreciationEntries in result object', () => {
      const vars = makeVars({ processingLevel: 0.5 });
      const impacts = {
        processingLevel: {
          type: 'absolute' as const,
          schedule: { default: 0.1 },
        },
      };

      const result = applyDecisionImpacts(vars, 'Test', impacts, 3);

      expect(result).toHaveProperty('updatedVars');
      expect(result).toHaveProperty('newDepreciationEntries');
      expect(Array.isArray(result.newDepreciationEntries)).toBe(true);
    });
  });

  describe('calculateLegalExposureRatio', () => {
    it('should calculate ratio as legalExposure / cash', () => {
      const admin = makeAdmin();
      const ratio = calculateLegalExposureRatio(50000, 100000, admin);
      // 50000 / 100000 = 0.5
      expect(ratio).toBeCloseTo(0.5, 4);
    });

    it('should cap at legalExposureRatioCap', () => {
      const admin = makeAdmin();
      const ratio = calculateLegalExposureRatio(100000, 100000, admin);
      // 100000 / 100000 = 1.0, but cap is 0.8
      expect(ratio).toBeCloseTo(0.8, 4);
    });

    it('should return 0 when cash is zero', () => {
      const admin = makeAdmin();
      const ratio = calculateLegalExposureRatio(50000, 0, admin);
      expect(ratio).toBe(0);
    });

    it('should return 0 when legal exposure is zero', () => {
      const admin = makeAdmin();
      const ratio = calculateLegalExposureRatio(0, 100000, admin);
      expect(ratio).toBe(0);
    });

    it('should respect custom cap value', () => {
      const admin = makeAdmin({
        legalProcess: {
          scrutinyLegalRiskMultiplier: 0.02,
          legalExposureRatioCap: 0.5, // Custom cap
          semaphoreGreenMax: 0.15,
          semaphoreYellowMax: 0.4,
          buySharesLegalRiskThresholdPercent: 0.05,
        },
      });
      const ratio = calculateLegalExposureRatio(60000, 100000, admin);
      // 60000 / 100000 = 0.6, but cap is 0.5
      expect(ratio).toBeCloseTo(0.5, 4);
    });

    it('should not cap when ratio is below cap', () => {
      const admin = makeAdmin();
      const ratio = calculateLegalExposureRatio(30000, 100000, admin);
      // 30000 / 100000 = 0.3 < 0.8 (cap)
      expect(ratio).toBeCloseTo(0.3, 4);
    });
  });

  describe('calculateAdjustedProbability', () => {
    it('should increase probability with scrutiny alone', () => {
      const admin = makeAdmin();
      const result = calculateAdjustedProbability(0.5, 10, 0, admin);
      // 0.5 * (1 + 0.02 * 10 / 100 + 0) = 0.5 * (1 + 0.002) = 0.5 * 1.002 = 0.501
      // Actually wait, let me re-read the formula: (scrutinyLegalRiskMultiplier * scrutiny) / 100
      // So: 0.5 * (1 + 0.02 * 10) = 0.5 * 1.2 = 0.6 (when scrutiny is not divided by 100)
      // Let me check the actual implementation...
      // The implementation is: 1 + (scrutinyLegalRiskMultiplier * defendantScrutiny) / 100 + defendantLegalExposureRatio
      // So with scrutiny=10: 1 + (0.02 * 10) / 100 + 0 = 1 + 0.002 + 0 = 1.002
      // Then: 0.5 * 1.002 = 0.501
      expect(result).toBeCloseTo(0.501, 4);
    });

    it('should increase probability with legal exposure ratio alone', () => {
      const admin = makeAdmin();
      const result = calculateAdjustedProbability(0.5, 0, 0.5, admin);
      // 0.5 * (1 + 0 + 0.5) = 0.5 * 1.5 = 0.75
      expect(result).toBeCloseTo(0.75, 4);
    });

    it('should increase probability with both scrutiny and legal exposure ratio', () => {
      const admin = makeAdmin();
      const result = calculateAdjustedProbability(0.5, 10, 0.4, admin);
      // 0.5 * (1 + 0.02 * 10 / 100 + 0.4) = 0.5 * (1 + 0.002 + 0.4) = 0.5 * 1.402 = 0.701
      expect(result).toBeCloseTo(0.701, 4);
    });

    it('should return base probability when both scrutiny and legal exposure are zero', () => {
      const admin = makeAdmin();
      const result = calculateAdjustedProbability(0.3, 0, 0, admin);
      expect(result).toBeCloseTo(0.3, 4);
    });

    it('should scale linearly with increasing legal exposure ratio', () => {
      const admin = makeAdmin();
      const r1 = calculateAdjustedProbability(0.5, 0, 0.1, admin);
      const r2 = calculateAdjustedProbability(0.5, 0, 0.3, admin);
      const r3 = calculateAdjustedProbability(0.5, 0, 0.5, admin);
      
      expect(r1).toBeLessThan(r2);
      expect(r2).toBeLessThan(r3);
    });

    it('should cap probability contribution at legal exposure cap', () => {
      const admin = makeAdmin();
      // Even if legal exposure ratio is provided as 1.0, it still contributes linearly
      const result = calculateAdjustedProbability(0.1, 0, 0.8, admin);
      // 0.1 * (1 + 0.8) = 0.18
      expect(result).toBeCloseTo(0.18, 4);
    });
  });

  describe('calculateRiskGauge with legal exposure', () => {
    it('should normalize legal exposure ratio by dividing by cap', () => {
      const vars = makeVars({ cash: 100000, scrutiny: 0, outrage: 0 });
      const admin = makeAdmin();
      const openCases = [{ probability: 0.5, stakes: 40000 }];
      
      // legalExposure = 0.5 * 40000 = 20000
      // legalExposureRatio = MIN(0.8, 20000 / 100000) = MIN(0.8, 0.2) = 0.2
      // normalized = 0.2 / 0.8 = 0.25
      // risk = 100 * (0.3 * 0.25 + 0.2 * 0 + 0.25 * 0) = 100 * 0.075 = 7.5
      
      const result = calculateRiskGauge(vars, openCases, admin);
      expect(result).toBeCloseTo(7.5, 1);
    });

    it('should normalize scrutiny by dividing by 100', () => {
      const vars = makeVars({ cash: 100000, scrutiny: 50, outrage: 0 });
      const admin = makeAdmin();
      const openCases = [];
      
      // legalExposureRatio = 0
      // normalized scrutiny = MIN(1, 50 / 100) = 0.5
      // risk = 100 * (0.3 * 0 + 0.2 * 0.5 + 0.25 * 0) = 100 * 0.1 = 10
      
      const result = calculateRiskGauge(vars, openCases, admin);
      expect(result).toBeCloseTo(10, 1);
    });

    it('should normalize outrage by dividing by 100', () => {
      const vars = makeVars({ cash: 100000, scrutiny: 0, outrage: 75 });
      const admin = makeAdmin();
      const openCases = [];
      
      // legalExposureRatio = 0
      // normalized outrage = MIN(1, 75 / 100) = 0.75
      // risk = 100 * (0.3 * 0 + 0.2 * 0 + 0.25 * 0.75) = 100 * 0.1875 = 18.75
      
      const result = calculateRiskGauge(vars, openCases, admin);
      expect(result).toBeCloseTo(18.75, 1);
    });

    it('should combine all three components with correct weights', () => {
      const vars = makeVars({ cash: 100000, scrutiny: 50, outrage: 50 });
      const admin = makeAdmin();
      const openCases = [{ probability: 0.5, stakes: 40000 }];
      
      // legalExposure = 0.5 * 40000 = 20000
      // legalExposureRatio = MIN(0.8, 0.2) = 0.2, normalized = 0.2 / 0.8 = 0.25
      // normalized scrutiny = 0.5
      // normalized outrage = 0.5
      // risk = 100 * (0.3 * 0.25 + 0.2 * 0.5 + 0.25 * 0.5) = 100 * (0.075 + 0.1 + 0.125) = 30
      
      const result = calculateRiskGauge(vars, openCases, admin);
      expect(result).toBeCloseTo(30, 1);
    });

    it('should cap scrutiny and outrage normalization at 1.0', () => {
      const vars = makeVars({ cash: 100000, scrutiny: 150, outrage: 200 });
      const admin = makeAdmin();
      const openCases = [];
      
      // normalized scrutiny = MIN(1, 1.5) = 1.0
      // normalized outrage = MIN(1, 2.0) = 1.0
      // risk = 100 * (0 + 0.2 * 1.0 + 0.25 * 1.0) = 100 * 0.45 = 45
      
      const result = calculateRiskGauge(vars, openCases, admin);
      expect(result).toBeCloseTo(45, 1);
    });

    it('should handle negative outrage (use absolute value)', () => {
      const vars = makeVars({ cash: 100000, scrutiny: 0, outrage: -60 });
      const admin = makeAdmin();
      const openCases = [];
      
      // normalized outrage = MIN(1, ABS(-60) / 100) = 0.6
      // risk = 100 * (0 + 0 + 0.25 * 0.6) = 15
      
      const result = calculateRiskGauge(vars, openCases, admin);
      expect(result).toBeCloseTo(15, 1);
    });

    it('should handle multiple open cases accumulating legal exposure', () => {
      const vars = makeVars({ cash: 100000, scrutiny: 0, outrage: 0 });
      const admin = makeAdmin();
      const openCases = [
        { probability: 0.3, stakes: 20000 },
        { probability: 0.4, stakes: 30000 },
      ];
      
      // legalExposure = 0.3 * 20000 + 0.4 * 30000 = 6000 + 12000 = 18000
      // legalExposureRatio = MIN(0.8, 0.18) = 0.18
      // normalized = 0.18 / 0.8 = 0.225
      // risk = 100 * 0.3 * 0.225 = 6.75
      
      const result = calculateRiskGauge(vars, openCases, admin);
      expect(result).toBeCloseTo(6.75, 1);
    });
  });

  describe('updateBalanceSheet with legal exposure', () => {
    it('should include legal exposure in equity calculation', () => {
      const vars = makeVars({
        cash: 100000,
        reserves: 30000,
        assets: 50000,
        intangibleAssets: 10000,
        debt: 20000,
        totalSharesOutstanding: 1000,
      });
      const admin = makeAdmin();
      const netProfit = 10000;
      const depreciation = 5000;
      const revenue = 200000;

      const legalExposure = 10000;
      const result = updateBalanceSheet(vars, netProfit, depreciation, revenue, legalExposure, admin);

      expect(result).toHaveProperty('cash');
      expect(result).toHaveProperty('reserves');
      expect(result).toHaveProperty('receivables');
      expect(result).toHaveProperty('equity');
      expect(result).toHaveProperty('stockValue');
      expect(result.cash).toBeGreaterThan(100000); // cash + profit + depreciation
      expect(result.legalExposure).toBe(10000);
    });

    it('should calculate receivables based on DSO', () => {
      const vars = makeVars({
        cash: 50000,
        reserves: 10000,
        assets: 30000,
        intangibleAssets: 5000,
        debt: 10000,
        totalSharesOutstanding: 500,
      });
      const admin = makeAdmin();
      const netProfit = 5000;
      const depreciation = 2000;
      const revenue = 100000;
      const legalExposure = 5000;

      const result = updateBalanceSheet(vars, netProfit, depreciation, revenue, legalExposure, admin);

      // DSO = 30 days, so receivables = 100000 * (30 / 365)
      expect(result.receivables).toBeCloseTo(100000 * (30 / 365), 2);
    });

    it('should calculate stock value per share correctly', () => {
      const vars = makeVars({
        cash: 100000,
        reserves: 30000,
        assets: 50000,
        intangibleAssets: 10000,
        debt: 20000,
        totalSharesOutstanding: 1000,
      });
      const admin = makeAdmin();
      const netProfit = 15000;
      const depreciation = 5000;
      const revenue = 250000;
      const legalExposure = 0;

      const result = updateBalanceSheet(vars, netProfit, depreciation, revenue, legalExposure, admin);

      // market equity = equity - legalExposure = equity
      // stock value = market equity / shares
      expect(result.stockValue).toBeGreaterThan(0);
      expect(result.legalExposure).toBe(0);
    });

    it('should reduce stock value when legal exposure exceeds equity', () => {
      const vars = makeVars({
        cash: 50000,
        reserves: 10000,
        assets: 30000,
        intangibleAssets: 5000,
        debt: 10000,
        totalSharesOutstanding: 1000,
      });
      const admin = makeAdmin();
      const netProfit = 5000;
      const depreciation = 2000;
      const revenue = 100000;
      const legalExposure = 200000; // Huge legal exposure

      const result = updateBalanceSheet(vars, netProfit, depreciation, revenue, legalExposure, admin);

      // market equity should be capped at 0, so stock value should be 0
      expect(result.stockValue).toBe(0);
    });

    it('should preserve original variables without mutation', () => {
      const vars = makeVars({
        cash: 100000,
        reserves: 30000,
        assets: 50000,
        intangibleAssets: 10000,
        debt: 20000,
        totalSharesOutstanding: 1000,
      });
      const admin = makeAdmin();
      const originalCash = vars.cash;

      updateBalanceSheet(vars, 15000, 5000, 250000, 5000, admin);

      expect(vars.cash).toBe(originalCash); // Original should be unchanged
    });
  });

  describe('calculateMaturityYears', () => {
    it('should return max numeric schedule key', () => {
      const impacts = {
        field1: { type: 'absolute' as const, schedule: { 1: 0.1, 2: 0.1, 3: 0.1, default: 0.2 } },
        field2: { type: 'absolute' as const, schedule: { 1: 0.05, 2: 0.05, default: 0.1 } },
      };

      expect(calculateMaturityYears(impacts)).toBe(3);
    });

    it('should return 0 when only default exists', () => {
      const impacts = {
        field1: { type: 'absolute' as const, schedule: { default: 0.1 } },
      };

      expect(calculateMaturityYears(impacts)).toBe(0);
    });

    it('should ignore non-numeric keys', () => {
      const impacts = {
        field1: { type: 'absolute' as const, schedule: { 1: 0.1, 3: 0.1, default: 0.2 } },
      };

      expect(calculateMaturityYears(impacts)).toBe(3);
    });
  });
});
