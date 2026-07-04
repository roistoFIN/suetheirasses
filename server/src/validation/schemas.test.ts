import { describe, it, expect } from 'vitest';
import {
  validateRoomJoin,
  validateStrategySubmit,
  validateLawsuitFile,
  validateLawsuitRespond,
  validateChatMessage,
  roomJoinSchema,
  strategySubmitSchema,
  lawsuitFileSchema,
  lawsuitRespondSchema,
  chatMessageSchema,
  gameActionSchema,
} from './schemas';
import { StrategyActionType } from '@suetheirasses/shared';

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

    it('should reject roomName exceeding 30 characters', () => {
      const longRoom = 'a'.repeat(31);
      expect(() => validateRoomJoin({ playerName: 'Test', roomName: longRoom })).toThrow();
    });

    it('should accept roomName at exactly 30 characters', () => {
      const room = 'a'.repeat(30);
      const result = validateRoomJoin({ playerName: 'Test', roomName: room });
      expect(result.roomName).toBe(room);
    });

    it('should reject non-string playerName', () => {
      expect(() => validateRoomJoin({ playerName: 123 as any })).toThrow();
    });
  });

  describe('strategySubmitSchema', () => {
    it('should validate a valid strategy submit with one action', () => {
      const data = { actions: [{ type: StrategyActionType.INVEST, amount: 5000 }] };
      const result = validateStrategySubmit(data);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].type).toBe(StrategyActionType.INVEST);
      expect(result.actions[0].amount).toBe(5000);
    });

    it('should validate strategy submit with multiple actions', () => {
      const data = {
        actions: [
          { type: StrategyActionType.INVEST, amount: 5000 },
          { type: StrategyActionType.EXPAND, amount: 15000 },
          { type: StrategyActionType.LAYOFF },
        ],
      };
      const result = validateStrategySubmit(data);
      expect(result.actions).toHaveLength(3);
    });

    it('should validate strategy submit with optional fields', () => {
      const data = {
        actions: [
          {
            type: StrategyActionType.INVEST,
            target: 'tech',
            amount: 10000,
            details: 'Invest in AI',
          },
        ],
      };
      const result = validateStrategySubmit(data);
      expect(result.actions[0].target).toBe('tech');
      expect(result.actions[0].amount).toBe(10000);
      expect(result.actions[0].details).toBe('Invest in AI');
    });

    it('should reject empty actions array', () => {
      expect(() => validateStrategySubmit({ actions: [] })).toThrow();
    });

    it('should reject more than 5 actions', () => {
      const actions = Array(6).fill({ type: StrategyActionType.INVEST });
      expect(() => validateStrategySubmit({ actions })).toThrow();
    });

    it('should accept exactly 5 actions', () => {
      const actions = Array(5).fill({ type: StrategyActionType.INVEST });
      const result = validateStrategySubmit({ actions });
      expect(result.actions).toHaveLength(5);
    });

    it('should reject invalid action type', () => {
      expect(() => validateStrategySubmit({ actions: [{ type: 'INVALID' as any }] })).toThrow();
    });

    it('should reject negative amount', () => {
      expect(() => validateStrategySubmit({ actions: [{ type: StrategyActionType.INVEST, amount: -100 }] })).toThrow();
    });

    it('should accept zero amount', () => {
      const data = { actions: [{ type: StrategyActionType.INVEST, amount: 0 }] };
      const result = validateStrategySubmit(data);
      expect(result.actions[0].amount).toBe(0);
    });

    it('should validate all strategy action types', () => {
      const actionTypes = [
        StrategyActionType.INVEST,
        StrategyActionType.EXPAND,
        StrategyActionType.LAYOFF,
        StrategyActionType.MERGER,
        StrategyActionType.AD_CAMPAIGN,
        StrategyActionType.RESEARCH_AND_DEVELOPMENT,
        StrategyActionType.OUTSOURCE,
        StrategyActionType.ACQUISITION,
      ];

      for (const type of actionTypes) {
        const data = { actions: [{ type }] };
        const result = validateStrategySubmit(data);
        expect(result.actions[0].type).toBe(type);
      }
    });

    it('should reject missing actions field', () => {
      expect(() => validateStrategySubmit({} as any)).toThrow();
    });
  });

  describe('lawsuitFileSchema', () => {
    it('should validate a valid lawsuit file payload', () => {
      const data = {
        defendantId: 'def123',
        claimAmount: 50000,
        grounds: 'Breach of contract and negligence',
      };
      const result = validateLawsuitFile(data);
      expect(result.defendantId).toBe('def123');
      expect(result.claimAmount).toBe(50000);
      expect(result.grounds).toBe('Breach of contract and negligence');
    });

    it('should reject claimAmount below 1000', () => {
      expect(() => validateLawsuitFile({ defendantId: 'def123', claimAmount: 999, grounds: 'Test' })).toThrow();
    });

    it('should accept claimAmount at exactly 1000', () => {
      const data = { defendantId: 'def123', claimAmount: 1000, grounds: 'Test grounds here' };
      const result = validateLawsuitFile(data);
      expect(result.claimAmount).toBe(1000);
    });

    it('should accept claimAmount at exactly 1000000', () => {
      const data = { defendantId: 'def123', claimAmount: 1000000, grounds: 'Test grounds here' };
      const result = validateLawsuitFile(data);
      expect(result.claimAmount).toBe(1000000);
    });

    it('should reject claimAmount above 1000000', () => {
      expect(() => validateLawsuitFile({ defendantId: 'def123', claimAmount: 1000001, grounds: 'Test' })).toThrow();
    });

    it('should reject grounds below 10 characters', () => {
      expect(() => validateLawsuitFile({ defendantId: 'def123', claimAmount: 5000, grounds: 'Short' })).toThrow();
    });

    it('should accept grounds at exactly 10 characters', () => {
      const data = { defendantId: 'def123', claimAmount: 5000, grounds: '1234567890' };
      const result = validateLawsuitFile(data);
      expect(result.grounds).toBe('1234567890');
    });

    it('should reject grounds above 500 characters', () => {
      const longGrounds = 'a'.repeat(501);
      expect(() => validateLawsuitFile({ defendantId: 'def123', claimAmount: 5000, grounds: longGrounds })).toThrow();
    });

    it('should accept grounds at exactly 500 characters', () => {
      const grounds = 'a'.repeat(500);
      const data = { defendantId: 'def123', claimAmount: 5000, grounds };
      const result = validateLawsuitFile(data);
      expect(result.grounds).toBe(grounds);
    });

    it('should reject empty defendantId', () => {
      expect(() => validateLawsuitFile({ defendantId: '', claimAmount: 5000, grounds: 'Test grounds here' })).toThrow();
    });

    it('should reject negative claimAmount', () => {
      expect(() => validateLawsuitFile({ defendantId: 'def123', claimAmount: -100, grounds: 'Test grounds here' })).toThrow();
    });
  });

  describe('lawsuitRespondSchema', () => {
    it('should validate a valid lawsuit respond payload', () => {
      const data = {
        lawsuitId: 'lawsuit123',
        defense: 'This is a strong defense with good arguments',
      };
      const result = validateLawsuitRespond(data);
      expect(result.lawsuitId).toBe('lawsuit123');
      expect(result.defense).toBe('This is a strong defense with good arguments');
      expect(result.settlementOffer).toBeUndefined();
    });

    it('should validate with optional settlementOffer', () => {
      const data = {
        lawsuitId: 'lawsuit123',
        defense: 'This is a strong defense with good arguments',
        settlementOffer: 25000,
      };
      const result = validateLawsuitRespond(data);
      expect(result.settlementOffer).toBe(25000);
    });

    it('should accept settlementOffer of zero', () => {
      const data = {
        lawsuitId: 'lawsuit123',
        defense: 'This is a strong defense with good arguments',
        settlementOffer: 0,
      };
      const result = validateLawsuitRespond(data);
      expect(result.settlementOffer).toBe(0);
    });

    it('should reject negative settlementOffer', () => {
      expect(() => validateLawsuitRespond({
        lawsuitId: 'lawsuit123',
        defense: 'This is a strong defense with good arguments',
        settlementOffer: -100,
      })).toThrow();
    });

    it('should reject defense below 10 characters', () => {
      expect(() => validateLawsuitRespond({ lawsuitId: 'lawsuit123', defense: 'Short' })).toThrow();
    });

    it('should accept defense at exactly 10 characters', () => {
      const data = { lawsuitId: 'lawsuit123', defense: '1234567890' };
      const result = validateLawsuitRespond(data);
      expect(result.defense).toBe('1234567890');
    });

    it('should reject defense above 1000 characters', () => {
      const longDefense = 'a'.repeat(1001);
      expect(() => validateLawsuitRespond({ lawsuitId: 'lawsuit123', defense: longDefense })).toThrow();
    });

    it('should accept defense at exactly 1000 characters', () => {
      const defense = 'a'.repeat(1000);
      const data = { lawsuitId: 'lawsuit123', defense };
      const result = validateLawsuitRespond(data);
      expect(result.defense).toBe(defense);
    });

    it('should reject empty lawsuitId', () => {
      expect(() => validateLawsuitRespond({ lawsuitId: '', defense: 'This is a strong defense with good arguments' })).toThrow();
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

  describe('gameActionSchema standalone', () => {
    it('should validate action with all fields', () => {
      const data = {
        type: StrategyActionType.INVEST,
        target: 'tech',
        amount: 10000,
        details: 'Invest in AI research',
      };
      const result = gameActionSchema.parse(data);
      expect(result.type).toBe(StrategyActionType.INVEST);
      expect(result.target).toBe('tech');
      expect(result.amount).toBe(10000);
      expect(result.details).toBe('Invest in AI research');
    });

    it('should validate action with only type', () => {
      const data = { type: StrategyActionType.LAYOFF };
      const result = gameActionSchema.parse(data);
      expect(result.type).toBe(StrategyActionType.LAYOFF);
      expect(result.target).toBeUndefined();
      expect(result.amount).toBeUndefined();
      expect(result.details).toBeUndefined();
    });
  });
});
