import { describe, it, expect } from 'vitest';
import {
  validateRoomJoin,
  validateChatMessage,
  validateSubmitDecisions,
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
});
