import { describe, it, expect } from 'vitest';
import {
  validateRoomJoin,
  validateStrategySubmit,
  validateLawsuitFile,
  validateLawsuitRespond,
  validateChatMessage,
} from '../../server/src/validation/schemas';

describe('Validation Schemas', () => {
  describe('roomJoinSchema', () => {
    it('should validate a valid room join payload', () => {
      const result = validateRoomJoin({ playerName: 'Alice' });
      expect(result.playerName).toBe('Alice');
    });

    it('should validate with optional roomName', () => {
      const result = validateRoomJoin({ playerName: 'Bob', roomName: 'My Room' });
      expect(result.playerName).toBe('Bob');
      expect(result.roomName).toBe('My Room');
    });

    it('should reject empty playerName', () => {
      expect(() => validateRoomJoin({ playerName: '' })).toThrow();
    });

    it('should reject playerName exceeding max length', () => {
      expect(() => validateRoomJoin({ playerName: 'a'.repeat(31) })).toThrow();
    });

    it('should reject missing playerName', () => {
      expect(() => validateRoomJoin({} as any)).toThrow();
    });
  });

  describe('strategySubmitSchema', () => {
    it('should validate a valid strategy submit', () => {
      const result = validateStrategySubmit({
        actions: [{ type: 'INVEST', amount: 10000 }],
      });
      expect(result.actions.length).toBe(1);
      expect(result.actions[0].type).toBe('INVEST');
    });

    it('should validate multiple actions', () => {
      const result = validateStrategySubmit({
        actions: [
          { type: 'INVEST', amount: 10000 },
          { type: 'LAYOFF', amount: 5000 },
          { type: 'AD_CAMPAIGN', amount: 8000 },
        ],
      });
      expect(result.actions.length).toBe(3);
    });

    it('should reject empty actions array', () => {
      expect(() => validateStrategySubmit({ actions: [] })).toThrow();
    });

    it('should reject more than 5 actions', () => {
      expect(() => validateStrategySubmit({
        actions: [
          { type: 'INVEST' },
          { type: 'EXPAND' },
          { type: 'LAYOFF' },
          { type: 'AD_CAMPAIGN' },
          { type: 'RD' },
          { type: 'INVEST' },
        ],
      })).toThrow();
    });

    it('should reject invalid action type', () => {
      expect(() => validateStrategySubmit({
        actions: [{ type: 'INVALID_TYPE' }],
      })).toThrow();
    });

    it('should reject negative amount', () => {
      expect(() => validateStrategySubmit({
        actions: [{ type: 'INVEST', amount: -100 }],
      })).toThrow();
    });
  });

  describe('lawsuitFileSchema', () => {
    it('should validate a valid lawsuit file', () => {
      const result = validateLawsuitFile({
        defendantId: 'player-123',
        claimAmount: 50000,
        grounds: 'Breach of contract and fraudulent misrepresentation',
      });
      expect(result.defendantId).toBe('player-123');
      expect(result.claimAmount).toBe(50000);
    });

    it('should reject claimAmount below minimum', () => {
      expect(() => validateLawsuitFile({
        defendantId: 'player-123',
        claimAmount: 999,
        grounds: 'Some grounds',
      })).toThrow();
    });

    it('should reject claimAmount above maximum', () => {
      expect(() => validateLawsuitFile({
        defendantId: 'player-123',
        claimAmount: 1000001,
        grounds: 'Some grounds',
      })).toThrow();
    });

    it('should reject grounds below minimum length', () => {
      expect(() => validateLawsuitFile({
        defendantId: 'player-123',
        claimAmount: 50000,
        grounds: 'Short',
      })).toThrow();
    });

    it('should reject grounds exceeding max length', () => {
      expect(() => validateLawsuitFile({
        defendantId: 'player-123',
        claimAmount: 50000,
        grounds: 'a'.repeat(501),
      })).toThrow();
    });

    it('should reject missing defendantId', () => {
      expect(() => validateLawsuitFile({
        claimAmount: 50000,
        grounds: 'Some grounds',
      } as any)).toThrow();
    });
  });

  describe('lawsuitRespondSchema', () => {
    it('should validate a valid lawsuit response', () => {
      const result = validateLawsuitRespond({
        lawsuitId: 'lawsuit-123',
        defense: 'This is a detailed defense with sufficient length',
      });
      expect(result.lawsuitId).toBe('lawsuit-123');
      expect(result.defense.length).toBeGreaterThan(10);
    });

    it('should validate with optional settlement offer', () => {
      const result = validateLawsuitRespond({
        lawsuitId: 'lawsuit-123',
        defense: 'This is a detailed defense with sufficient length',
        settlementOffer: 25000,
      });
      expect(result.settlementOffer).toBe(25000);
    });

    it('should reject defense below minimum length', () => {
      expect(() => validateLawsuitRespond({
        lawsuitId: 'lawsuit-123',
        defense: 'Short',
      })).toThrow();
    });

    it('should reject defense exceeding max length', () => {
      expect(() => validateLawsuitRespond({
        lawsuitId: 'lawsuit-123',
        defense: 'a'.repeat(1001),
      })).toThrow();
    });

    it('should reject negative settlement offer', () => {
      expect(() => validateLawsuitRespond({
        lawsuitId: 'lawsuit-123',
        defense: 'This is a detailed defense with sufficient length',
        settlementOffer: -100,
      })).toThrow();
    });
  });

  describe('chatMessageSchema', () => {
    it('should validate a valid chat message', () => {
      const result = validateChatMessage({ message: 'Hello, world!' });
      expect(result.message).toBe('Hello, world!');
    });

    it('should reject empty message', () => {
      expect(() => validateChatMessage({ message: '' })).toThrow();
    });

    it('should reject message exceeding max length', () => {
      expect(() => validateChatMessage({ message: 'a'.repeat(501) })).toThrow();
    });
  });
});
