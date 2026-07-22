import { describe, it, expect } from 'vitest';
import {
  validateRoomJoin,
  validateChatMessage,
  validateSubmitDecisions,
  validateDecisionDefinition,
  validateGameConfig,
  validateFormulaUpdate,
  roomJoinSchema,
  chatMessageSchema,
  submitDecisionsSchema,
} from './schemas';

describe('Validation Schemas', () => {
  describe('roomJoinSchema', () => {
    it('should validate a valid room join payload', () => {
      const data = { playerName: 'TestPlayer' };
      const result = validateRoomJoin(data);
      expect(result.playerName).toBe('TestPlayer');
      expect(result.roomName).toBeUndefined();
    });

    it('should validate with optional roomName', () => {
      const data = { playerName: 'TestPlayer', roomName: 'room123' };
      const result = validateRoomJoin(data);
      expect(result.playerName).toBe('TestPlayer');
      expect(result.roomName).toBe('room123');
    });

    it('should reject empty playerName', () => {
      expect(() => validateRoomJoin({ playerName: '' })).toThrow();
    });

    it('should reject missing playerName', () => {
      expect(() => validateRoomJoin({})).toThrow();
    });

    it('should reject playerName exceeding 30 characters', () => {
      const longName = 'a'.repeat(31);
      expect(() => validateRoomJoin({ playerName: longName })).toThrow();
    });

    it('should accept playerName at exactly 30 characters', () => {
      const name = 'a'.repeat(30);
      const result = validateRoomJoin({ playerName: name });
      expect(result.playerName).toBe(name);
    });

    it('should reject roomName exceeding 40 characters', () => {
      const longRoom = 'a'.repeat(41);
      expect(() => validateRoomJoin({ playerName: 'Test', roomName: longRoom })).toThrow();
    });

    it('should accept roomName at exactly 40 characters', () => {
      const room = 'a'.repeat(40);
      const result = validateRoomJoin({ playerName: 'Test', roomName: room });
      expect(result.roomName).toBe(room);
    });

    it('should accept a full UUID v4 room code (36 characters, invite links)', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      const result = validateRoomJoin({ playerName: 'Test', roomName: uuid });
      expect(result.roomName).toBe(uuid);
    });

    it('should reject non-string playerName', () => {
      expect(() => validateRoomJoin({ playerName: 123 as any })).toThrow();
    });

    it('should validate with searchForRoom set to true', () => {
      const data = { playerName: 'TestPlayer', searchForRoom: true };
      const result = validateRoomJoin(data);
      expect(result.playerName).toBe('TestPlayer');
      expect(result.searchForRoom).toBe(true);
    });

    it('should validate with searchForRoom set to false', () => {
      const data = { playerName: 'TestPlayer', searchForRoom: false };
      const result = validateRoomJoin(data);
      expect(result.searchForRoom).toBe(false);
    });

    it('should accept searchForRoom with roomName (roomName takes precedence)', () => {
      const data = { playerName: 'TestPlayer', roomName: 'room123', searchForRoom: true };
      const result = validateRoomJoin(data);
      expect(result.playerName).toBe('TestPlayer');
      expect(result.roomName).toBe('room123');
      expect(result.searchForRoom).toBe(true);
    });

    it('should accept searchForRoom with playerName only', () => {
      const data = { playerName: 'TestPlayer', searchForRoom: true };
      const result = validateRoomJoin(data);
      expect(result.playerName).toBe('TestPlayer');
      expect(result.roomName).toBeUndefined();
      expect(result.searchForRoom).toBe(true);
    });

    it('should reject searchForRoom with non-boolean value', () => {
      expect(() => validateRoomJoin({ playerName: 'TestPlayer', searchForRoom: 'true' as any })).toThrow();
    });
  });

  describe('chatMessageSchema', () => {
    it('should validate a valid chat message', () => {
      const data = { message: 'Hello everyone!' };
      const result = validateChatMessage(data);
      expect(result.message).toBe('Hello everyone!');
    });

    it('should reject empty message', () => {
      expect(() => validateChatMessage({ message: '' })).toThrow();
    });

    it('should reject message below 1 character', () => {
      expect(() => validateChatMessage({ message: '' })).toThrow();
    });

    it('should reject message above 500 characters', () => {
      const longMessage = 'a'.repeat(501);
      expect(() => validateChatMessage({ message: longMessage })).toThrow();
    });

    it('should accept message at exactly 500 characters', () => {
      const message = 'a'.repeat(500);
      const data = { message };
      const result = validateChatMessage(data);
      expect(result.message).toBe(message);
    });

    it('should accept message at exactly 1 character', () => {
      const data = { message: 'a' };
      const result = validateChatMessage(data);
      expect(result.message).toBe('a');
    });
  });

  describe('submitDecisionsSchema', () => {
    it('should validate an empty submission', () => {
      const result = validateSubmitDecisions({ strategic: [], operational: [], lawsuits: [] });
      expect(result.strategic).toEqual([]);
      expect(result.operational).toEqual([]);
      expect(result.lawsuits).toEqual([]);
    });

    it('should validate a submission with strategic and operational decisions', () => {
      const data = {
        strategic: [{ name: 'New Factory' }],
        operational: [{ name: 'Digital Marketing' }, { name: 'Aggressive Sale' }],
        lawsuits: [],
      };
      const result = validateSubmitDecisions(data);
      expect(result.strategic).toHaveLength(1);
      expect(result.operational).toHaveLength(2);
    });

    it('should accept a decision with a targetId (targeted decisions like Buy Shares)', () => {
      const data = { strategic: [{ name: 'Buy Shares', targetId: 'player-2' }], operational: [], lawsuits: [] };
      const result = validateSubmitDecisions(data);
      expect(result.strategic[0].targetId).toBe('player-2');
    });

    it('should accept a lawsuit filing citing a target decision and ground', () => {
      const data = {
        strategic: [], operational: [],
        lawsuits: [{ targetId: 'player-2', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      };
      const result = validateSubmitDecisions(data);
      expect(result.lawsuits).toHaveLength(1);
      expect(result.lawsuits[0]).toEqual({ targetId: 'player-2', decisionName: 'Water Pumping', groundName: 'Environmental Violation' });
    });

    it('should reject a decision with an empty name', () => {
      expect(() =>
        validateSubmitDecisions({ strategic: [{ name: '' }], operational: [], lawsuits: [] }),
      ).toThrow();
    });

    it('should reject a decision name exceeding 100 characters', () => {
      expect(() =>
        validateSubmitDecisions({ strategic: [{ name: 'a'.repeat(101) }], operational: [], lawsuits: [] }),
      ).toThrow();
    });

    it('should reject missing strategic/operational/lawsuits arrays', () => {
      expect(() => validateSubmitDecisions({})).toThrow();
      expect(() => validateSubmitDecisions({ strategic: [] })).toThrow();
      expect(() => validateSubmitDecisions({ strategic: [], operational: [] })).toThrow();
    });

    it('should reject a strategic array exceeding the structural cap of 20', () => {
      const strategic = Array.from({ length: 21 }, (_, i) => ({ name: `Decision ${i}` }));
      expect(() => validateSubmitDecisions({ strategic, operational: [], lawsuits: [] })).toThrow();
    });

    it('should reject a lawsuits array exceeding the structural cap of 10', () => {
      const lawsuits = Array.from({ length: 11 }, (_, i) => ({ targetId: `p${i}`, decisionName: 'Water Pumping', groundName: 'Environmental Violation' }));
      expect(() => validateSubmitDecisions({ strategic: [], operational: [], lawsuits })).toThrow();
    });

    it('should not enforce game-balance limits (that is DecisionEngine.canDeploy\'s job)', () => {
      // Structural validation allows more than maxStrategicDecisionsPerTurn (1) through —
      // the actual per-turn limit is enforced later using game_config.json, not hardcoded here.
      const data = { strategic: [{ name: 'New Factory' }, { name: 'Vertical Integration' }], operational: [], lawsuits: [] };
      expect(() => validateSubmitDecisions(data)).not.toThrow();
    });
  });

  describe('decisionDefinitionSchema', () => {
    const validDecision = {
      decision: 'Test Decision',
      level: 'Operational',
      description: 'A decision for testing.',
      nature: 'Traditional',
      offensiveAction: false,
      excludes: [],
      impacts: { cash: { type: 'absolute', schedule: { default: -1000, 1: -500 } } },
    };

    it('should validate a minimal valid decision', () => {
      expect(() => validateDecisionDefinition(validDecision)).not.toThrow();
    });

    it('should validate with optional fields (legalRisks, competitorsView, etc.)', () => {
      const withOptionals = {
        ...validDecision,
        legalRisks: [{
          name: 'Test Lawsuit',
          description: 'Sue over the test decision.',
          probability: { default: 0.5 },
          impact: { type: 'absolute', target: 'cash', schedule: { default: -10000 } },
        }],
        competitorsView: ['Flavor text one.', 'Flavor text two.'],
        variableAmount: true,
        requiresTarget: true,
        legalRiskConditions: { someCondition: true },
        cashFlowCategory: 'operating',
      };
      expect(() => validateDecisionDefinition(withOptionals)).not.toThrow();
    });

    it('should reject an invalid level enum value', () => {
      expect(() => validateDecisionDefinition({ ...validDecision, level: 'Bogus' })).toThrow();
    });

    it('should reject a missing required field', () => {
      const { description, ...missingDescription } = validDecision;
      expect(() => validateDecisionDefinition(missingDescription)).toThrow();
    });

    it('should reject an impact entry with a non-numeric schedule value', () => {
      const bad = { ...validDecision, impacts: { cash: { type: 'absolute', schedule: { default: 'not-a-number' } } } };
      expect(() => validateDecisionDefinition(bad)).toThrow();
    });
  });

  describe('gameConfigSchema', () => {
    const validConfig = {
      gameSettings: {
        minPlayers: 2,
        maxPlayers: 4,
        turnDurationSeconds: 120,
        maxLawsuitsPerPlayerPerTurn: 3,
        maxStrategicDecisionsPerTurn: 1,
        maxOperationalDecisionsPerTurn: 2,
        totalMarketVolumeTonnesPerYear: 10000,
        marketFixed: true,
        digDeeperCost: 10000,
        negotiationPeriodTurns: 2,
        lawsuitFilingCost: 15000,
      },
      playerStartingValues: {
        cash: 100000, assets: 50000, intangibleAssets: 10000, debt: 20000, reserves: 30000,
        operatingExpenses: 5000, staffCost: 8000, materialCostPerTon: 100, otherIncome: 1000,
        price: 500, capacityUtilization: 0.8, processingLevel: 0.7, energyIntensity: 0.5,
        moistureContent: 0.3, nutrientConsistency: 0.85, supplySecurity: 0.6, logisticsCostPerTon: 50,
        processLoss: 0.05, installedCapacity: 10000, totalSharesOutstanding: 1000, shareOwnership: {},
        outrage: 10, scrutiny: 30, breakdowns: 0, contaminationRisk: 0.02, odorComplaints: 0,
        tokenLiability: 0, carbonFootprint: 0, stockVolume: 0, demand: 8000,
      },
      adminVariables: {
        competitiveness: {
          competitivenessWeight_quality_wq: 0.3, competitivenessWeight_supply_ws: 0.2,
          competitivenessWeight_loss_wl: 0.15, competitivenessWeight_demand_wd: 0.1, outrageDemandWeight: 0.5,
        },
        legalProcess: {
          semaphoreGreenMax: 0.15, semaphoreYellowMax: 0.4, scrutinyLegalRiskMultiplier: 0.02,
          legalExposureRatioCap: 0.8, buySharesLegalRiskThresholdPercent: 0.05,
        },
        riskGauge: { riskWeightLegalExposure_w1: 0.3, riskWeightScrutiny_w2: 0.2, riskWeightOutrage_w3: 0.25 },
        ownership: { takeoverThresholdPercent: 0.5 },
        finance: { baseFinanceCost: 2000, interestRate: 0.05, taxRate: 0.2, daysSalesOutstanding_DSO: 30 },
        depreciation: { assetUsefulLifeYears: 10, intangibleUsefulLifeYears: 5 },
      },
    };

    it('should validate a complete valid config', () => {
      expect(() => validateGameConfig(validConfig)).not.toThrow();
    });

    it('should reject a config missing an adminVariables sub-section', () => {
      const { finance, ...missingFinance } = validConfig.adminVariables;
      expect(() => validateGameConfig({ ...validConfig, adminVariables: missingFinance })).toThrow();
    });

    it('should reject gameSettings with a non-boolean marketFixed', () => {
      const bad = { ...validConfig, gameSettings: { ...validConfig.gameSettings, marketFixed: 'yes' } };
      expect(() => validateGameConfig(bad)).toThrow();
    });

    it('should reject an unknown top-level key typo (e.g. gameSetting instead of gameSettings)', () => {
      const { gameSettings, ...rest } = validConfig;
      expect(() => validateGameConfig({ gameSetting: gameSettings, ...rest })).toThrow();
    });
  });

  describe('formulaUpdateSchema / validateFormulaUpdate', () => {
    it('should validate a well-formed expression referencing only whitelisted variables', () => {
      const result = validateFormulaUpdate('competitiveness', {
        expression: '(1/price) * (1 + wq*processingLevel)',
        description: 'a description',
      });
      expect(result.expression).toBe('(1/price) * (1 + wq*processingLevel)');
    });

    it('should reject a missing expression field', () => {
      expect(() => validateFormulaUpdate('competitiveness', { description: 'x' })).toThrow();
    });

    it('should reject an empty expression string', () => {
      expect(() => validateFormulaUpdate('competitiveness', { expression: '', description: 'x' })).toThrow();
    });

    it('should reject a missing description field', () => {
      expect(() => validateFormulaUpdate('competitiveness', { expression: 'price' })).toThrow();
    });

    it('should reject an unknown formula key', () => {
      expect(() => validateFormulaUpdate('notARealFormula', { expression: '1 + 1', description: 'x' })).toThrow();
    });

    it('should reject malformed syntax (real parser, not a regex)', () => {
      expect(() => validateFormulaUpdate('competitiveness', { expression: 'price * ', description: 'x' })).toThrow();
    });

    it('should reject an expression referencing a variable outside that key\'s whitelist', () => {
      expect(() =>
        validateFormulaUpdate('competitiveness', { expression: 'price * totallyUnrelatedVariable', description: 'x' }),
      ).toThrow(/Unknown variable/);
    });

    it('should reject an expression referencing a variable that belongs to a DIFFERENT formula\'s whitelist', () => {
      // "cogs" is a real variable name, but only for the "grossProfit" formula, not "competitiveness"
      expect(() =>
        validateFormulaUpdate('competitiveness', { expression: 'price * cogs', description: 'x' }),
      ).toThrow(/Unknown variable/);
    });

    it('should accept MIN/MAX and reject other function calls', () => {
      expect(() => validateFormulaUpdate('volume', { expression: 'MIN(theoreticalVolume, maxSupply)', description: 'x' })).not.toThrow();
      expect(() => validateFormulaUpdate('volume', { expression: 'eval(theoreticalVolume)', description: 'x' })).toThrow();
    });
  });
});
