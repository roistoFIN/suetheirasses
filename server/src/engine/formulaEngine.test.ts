import { describe, it, expect } from 'vitest';
import { parseFormula, evaluateFormula, compileFormula, collectIdentifiers, FormulaParseError, FormulaEvalError } from './formulaEngine';

describe('formulaEngine', () => {
  describe('parsing + evaluation', () => {
    it('evaluates a simple arithmetic expression with correct precedence', () => {
      const ast = parseFormula('2 + 3 * 4');
      expect(evaluateFormula(ast, {})).toBe(14);
    });

    it('respects parentheses', () => {
      const ast = parseFormula('(2 + 3) * 4');
      expect(evaluateFormula(ast, {})).toBe(20);
    });

    it('handles unary minus', () => {
      const ast = parseFormula('-5 + 3');
      expect(evaluateFormula(ast, {})).toBe(-2);
    });

    it('handles nested unary minus', () => {
      const ast = parseFormula('- -5');
      expect(evaluateFormula(ast, {})).toBe(5);
    });

    it('resolves variable references from context', () => {
      const ast = parseFormula('price * volume');
      expect(evaluateFormula(ast, { price: 10, volume: 5 })).toBe(50);
    });

    it('evaluates MIN and MAX', () => {
      expect(evaluateFormula(parseFormula('MIN(3, 7)'), {})).toBe(3);
      expect(evaluateFormula(parseFormula('MAX(3, 7)'), {})).toBe(7);
    });

    it('evaluates MIN/MAX with expression arguments and nesting', () => {
      const ast = parseFormula('MIN(cap, MAX(0, x - y))');
      expect(evaluateFormula(ast, { cap: 0.8, x: 10, y: 3 })).toBe(0.8);
      expect(evaluateFormula(ast, { cap: 0.8, x: 1, y: 3 })).toBe(0);
    });

    it('reproduces the real competitiveness formula exactly', () => {
      // (1/price) * (1 + wq*processingLevel + ws*supplySecurity - wl*processLoss + wd*effectiveDemand)
      const ast = parseFormula('(1/price) * (1 + wq*processingLevel + ws*supplySecurity - wl*processLoss + wd*effectiveDemand)');
      const context = { price: 500, wq: 0.3, processingLevel: 0.7, ws: 0.2, supplySecurity: 0.6, wl: 0.15, processLoss: 0.05, wd: 0.1, effectiveDemand: 0.5 };
      const expected = (1 / context.price) * (1 + context.wq * context.processingLevel + context.ws * context.supplySecurity - context.wl * context.processLoss + context.wd * context.effectiveDemand);
      expect(evaluateFormula(ast, context)).toBeCloseTo(expected, 10);
    });

    it('division by zero produces Infinity, not a throw (matches plain JS arithmetic)', () => {
      const ast = parseFormula('x / y');
      expect(evaluateFormula(ast, { x: 5, y: 0 })).toBe(Infinity);
    });
  });

  describe('parse errors', () => {
    it('rejects an unbalanced paren', () => {
      expect(() => parseFormula('(1 + 2')).toThrow(FormulaParseError);
    });

    it('rejects trailing garbage', () => {
      expect(() => parseFormula('1 + 2 3')).toThrow(FormulaParseError);
    });

    it('rejects an unknown character', () => {
      expect(() => parseFormula('1 + $foo')).toThrow(FormulaParseError);
    });

    it('rejects an unknown function name (only MIN/MAX are callable)', () => {
      expect(() => parseFormula('eval(1, 2)')).toThrow(FormulaParseError);
    });

    it('rejects a bare identifier immediately followed by "(" that is not MIN/MAX — no arbitrary function calls', () => {
      expect(() => parseFormula('require("fs")')).toThrow(FormulaParseError);
    });

    it('rejects malformed numbers', () => {
      expect(() => parseFormula('1.2.3')).toThrow(FormulaParseError);
    });

    it('rejects an empty expression', () => {
      expect(() => parseFormula('')).toThrow(FormulaParseError);
    });
  });

  describe('security — no way to reach anything outside the grammar', () => {
    it('treats "__proto__" and "constructor" as plain (unresolved) identifiers, not property access', () => {
      // These parse fine as identifiers (they're valid variable-name syntax) but
      // evaluation must fail closed — they're not in the context, so no lookup
      // ever touches the real JS prototype chain.
      const ast = parseFormula('__proto__ + constructor');
      expect(() => evaluateFormula(ast, {})).toThrow(FormulaEvalError);
    });

    it('has no member-access syntax at all', () => {
      expect(() => parseFormula('process.env.SECRET')).toThrow(FormulaParseError);
    });

    it('has no assignment syntax', () => {
      expect(() => parseFormula('x = 5')).toThrow(FormulaParseError);
    });

    it('has no string literal syntax', () => {
      expect(() => parseFormula('"hello"')).toThrow(FormulaParseError);
    });
  });

  describe('evaluation errors', () => {
    it('throws on an unknown variable rather than returning NaN/undefined', () => {
      const ast = parseFormula('price * typoedVariableName');
      expect(() => evaluateFormula(ast, { price: 10 })).toThrow(FormulaEvalError);
    });
  });

  describe('collectIdentifiers', () => {
    it('collects every distinct variable name referenced', () => {
      const ast = parseFormula('MIN(a, b) + c * (a - d)');
      expect(collectIdentifiers(ast)).toEqual(new Set(['a', 'b', 'c', 'd']));
    });

    it('returns an empty set for a purely numeric expression', () => {
      expect(collectIdentifiers(parseFormula('1 + 2 * 3'))).toEqual(new Set());
    });
  });

  describe('compileFormula', () => {
    it('parses once and can be evaluated repeatedly with different contexts', () => {
      const fn = compileFormula('x * 2');
      expect(fn({ x: 1 })).toBe(2);
      expect(fn({ x: 10 })).toBe(20);
    });

    it('propagates a parse error immediately, at compile time', () => {
      expect(() => compileFormula('1 +')).toThrow(FormulaParseError);
    });
  });
});
