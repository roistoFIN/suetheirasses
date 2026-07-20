import { describe, it, expect } from 'vitest';
import {
  validateRoomJoin,
  validateChatMessage,
  validateSubmitDecisions,
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

    describe('roomName field', () => {
      it('should accept roomName up to 40 characters (UUID v4 length)', () => {
        const uuid = '550e8400-e29b-41d4-a716-446655440000';
        const result = validateRoomJoin({ playerName: 'Alice', roomName: uuid });
        expect(result.roomName).toBe(uuid);
      });

      it('should accept roomName at exactly 40 characters', () => {
        const longCode = 'a'.repeat(40);
        const result = validateRoomJoin({ playerName: 'Bob', roomName: longCode });
        expect(result.roomName).toBe(longCode);
      });

      it('should reject roomName exceeding 40 characters', () => {
        expect(() => validateRoomJoin({ playerName: 'Charlie', roomName: 'a'.repeat(41) })).toThrow();
      });

      it('should accept cuid-style room codes (~25 chars)', () => {
        const cuid = 'ck8x3y2z0000001le8qj5m9nr';
        const result = validateRoomJoin({ playerName: 'Dave', roomName: cuid });
        expect(result.roomName).toBe(cuid);
      });

      it('should accept short alphanumeric room codes', () => {
        const result = validateRoomJoin({ playerName: 'Eve', roomName: 'abc123' });
        expect(result.roomName).toBe('abc123');
      });

      it('should accept roomName with hyphens (UUID format)', () => {
        const uuidLike = 'room-550e8400-e29b';
        const result = validateRoomJoin({ playerName: 'Frank', roomName: uuidLike });
        expect(result.roomName).toBe(uuidLike);
      });

      it('should reject empty string roomName', () => {
        const result = validateRoomJoin({ playerName: 'Grace', roomName: '' });
        expect(result.roomName).toBe('');
      });

      it('should accept roomName with spaces', () => {
        const result = validateRoomJoin({ playerName: 'Heidi', roomName: 'My Room Code' });
        expect(result.roomName).toBe('My Room Code');
      });
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

  describe('submitDecisionsSchema (game:submitDecisions)', () => {
    it('should validate a turn submission with strategic and operational decisions', () => {
      const result = validateSubmitDecisions({
        strategic: [{ name: 'New Factory' }],
        operational: [{ name: 'Digital Marketing' }],
        lawsuits: [],
      });
      expect(result.strategic).toHaveLength(1);
      expect(result.operational).toHaveLength(1);
    });

    it('should validate an empty submission (player passes their turn)', () => {
      const result = validateSubmitDecisions({ strategic: [], operational: [], lawsuits: [] });
      expect(result.strategic).toEqual([]);
      expect(result.operational).toEqual([]);
    });

    it('should preserve targetId for targeted decisions (e.g. Buy Shares)', () => {
      const result = validateSubmitDecisions({
        strategic: [{ name: 'Buy Shares', targetId: 'rival-player-id' }],
        operational: [],
        lawsuits: [],
      });
      expect(result.strategic[0]).toEqual({ name: 'Buy Shares', targetId: 'rival-player-id' });
    });

    it('should preserve a deliberate lawsuit filing citing a target decision and ground', () => {
      const result = validateSubmitDecisions({
        strategic: [], operational: [],
        lawsuits: [{ targetId: 'rival-player-id', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });
      expect(result.lawsuits).toHaveLength(1);
    });

    it('should reject a payload missing the strategic/operational/lawsuits arrays', () => {
      expect(() => validateSubmitDecisions({})).toThrow();
    });

    it('should reject a decision entry with an empty name', () => {
      expect(() => validateSubmitDecisions({ strategic: [{ name: '' }], operational: [], lawsuits: [] })).toThrow();
    });
  });
});
