/**
 * Safe arithmetic expression parser/evaluator for admin-editable formulas
 * (server/prisma's `Formula` table — see CLAUDE.md's "Formulas are DB-backed").
 *
 * Deliberately NOT `eval`/`new Function`/`vm` — those can be escaped or abused for
 * arbitrary code execution, which is a categorically worse risk than a math typo.
 * This is a small hand-rolled recursive-descent parser over a fixed grammar with no
 * way to reach anything outside its own AST node types: number literals, identifiers,
 * `+ - * /`, unary `-`, parentheses, and exactly two whitelisted calls, `MIN`/`MAX`.
 * No string literals, no member access, no assignment, no arbitrary function calls.
 */

export type FormulaAst =
  | { type: 'number'; value: number }
  | { type: 'identifier'; name: string }
  | { type: 'unary'; op: '-'; arg: FormulaAst }
  | { type: 'binary'; op: '+' | '-' | '*' | '/'; left: FormulaAst; right: FormulaAst }
  | { type: 'call'; name: 'MIN' | 'MAX'; args: [FormulaAst, FormulaAst] };

export class FormulaParseError extends Error {}
export class FormulaEvalError extends Error {}

const WHITELISTED_FUNCTIONS = new Set(['MIN', 'MAX']);

// ============================================================
// Tokenizer
// ============================================================

type Token =
  | { type: 'number'; value: number; pos: number }
  | { type: 'identifier'; value: string; pos: number }
  | { type: 'op'; value: '+' | '-' | '*' | '/' | '(' | ')' | ','; pos: number }
  | { type: 'eof'; pos: number };

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expression.length) {
    const ch = expression[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(expression[i + 1] ?? ''))) {
      const start = i;
      while (i < expression.length && /[0-9.]/.test(expression[i])) i++;
      const raw = expression.slice(start, i);
      const value = Number(raw);
      if (Number.isNaN(value)) {
        throw new FormulaParseError(`Invalid number "${raw}" at position ${start}`);
      }
      tokens.push({ type: 'number', value, pos: start });
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      while (i < expression.length && /[a-zA-Z0-9_]/.test(expression[i])) i++;
      tokens.push({ type: 'identifier', value: expression.slice(start, i), pos: start });
      continue;
    }

    if ('+-*/(),'.includes(ch)) {
      tokens.push({ type: 'op', value: ch as '+' | '-' | '*' | '/' | '(' | ')' | ',', pos: i });
      i++;
      continue;
    }

    throw new FormulaParseError(`Unexpected character "${ch}" at position ${i}`);
  }

  tokens.push({ type: 'eof', pos: expression.length });
  return tokens;
}

// ============================================================
// Recursive-descent parser
// expression := term (('+' | '-') term)*
// term       := unary (('*' | '/') unary)*
// unary      := '-' unary | primary
// primary    := NUMBER | IDENTIFIER '(' expression ',' expression ')' | IDENTIFIER | '(' expression ')'
// ============================================================

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expectOp(value: string): void {
    const tok = this.next();
    if (tok.type !== 'op' || tok.value !== value) {
      throw new FormulaParseError(`Expected "${value}" at position ${tok.pos}`);
    }
  }

  parse(): FormulaAst {
    const ast = this.parseExpression();
    const tok = this.peek();
    if (tok.type !== 'eof') {
      throw new FormulaParseError(`Unexpected trailing input at position ${tok.pos}`);
    }
    return ast;
  }

  private parseExpression(): FormulaAst {
    let node = this.parseTerm();
    for (;;) {
      const tok = this.peek();
      if (tok.type === 'op' && (tok.value === '+' || tok.value === '-')) {
        this.next();
        const right = this.parseTerm();
        node = { type: 'binary', op: tok.value, left: node, right };
      } else {
        break;
      }
    }
    return node;
  }

  private parseTerm(): FormulaAst {
    let node = this.parseUnary();
    for (;;) {
      const tok = this.peek();
      if (tok.type === 'op' && (tok.value === '*' || tok.value === '/')) {
        this.next();
        const right = this.parseUnary();
        node = { type: 'binary', op: tok.value, left: node, right };
      } else {
        break;
      }
    }
    return node;
  }

  private parseUnary(): FormulaAst {
    const tok = this.peek();
    if (tok.type === 'op' && tok.value === '-') {
      this.next();
      return { type: 'unary', op: '-', arg: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): FormulaAst {
    const tok = this.next();

    if (tok.type === 'number') {
      return { type: 'number', value: tok.value };
    }

    if (tok.type === 'identifier') {
      // Function call: NAME '(' expr ',' expr ')' — only MIN/MAX are ever recognized.
      const lookahead = this.peek();
      if (lookahead.type === 'op' && lookahead.value === '(') {
        if (!WHITELISTED_FUNCTIONS.has(tok.value)) {
          throw new FormulaParseError(`Unknown function "${tok.value}" at position ${tok.pos} — only MIN/MAX are allowed`);
        }
        this.next(); // consume '('
        const first = this.parseExpression();
        this.expectOp(',');
        const second = this.parseExpression();
        this.expectOp(')');
        return { type: 'call', name: tok.value as 'MIN' | 'MAX', args: [first, second] };
      }
      return { type: 'identifier', name: tok.value };
    }

    if (tok.type === 'op' && tok.value === '(') {
      const inner = this.parseExpression();
      this.expectOp(')');
      return inner;
    }

    throw new FormulaParseError(`Unexpected token at position ${tok.pos}`);
  }
}

/** Parses a formula expression into an AST. Throws FormulaParseError on invalid syntax. */
export function parseFormula(expression: string): FormulaAst {
  const tokens = tokenize(expression);
  return new Parser(tokens).parse();
}

/**
 * Evaluates a parsed formula against a context of named numeric inputs. Throws
 * FormulaEvalError if the expression references an identifier not present in
 * `context` — never silently returns NaN/undefined for a typo'd variable name.
 */
export function evaluateFormula(ast: FormulaAst, context: Record<string, number>): number {
  switch (ast.type) {
    case 'number':
      return ast.value;
    case 'identifier':
      if (!Object.prototype.hasOwnProperty.call(context, ast.name)) {
        throw new FormulaEvalError(`Unknown variable "${ast.name}"`);
      }
      return context[ast.name];
    case 'unary':
      return -evaluateFormula(ast.arg, context);
    case 'binary': {
      const left = evaluateFormula(ast.left, context);
      const right = evaluateFormula(ast.right, context);
      switch (ast.op) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/': return left / right;
      }
      break;
    }
    case 'call': {
      const a = evaluateFormula(ast.args[0], context);
      const b = evaluateFormula(ast.args[1], context);
      return ast.name === 'MIN' ? Math.min(a, b) : Math.max(a, b);
    }
  }
  throw new FormulaEvalError('Unreachable AST node');
}

/** Every identifier (variable name) an expression references — used to validate a
 * formula edit against its fixed per-key variable whitelist before it's saved. */
export function collectIdentifiers(ast: FormulaAst, out: Set<string> = new Set()): Set<string> {
  switch (ast.type) {
    case 'identifier':
      out.add(ast.name);
      break;
    case 'unary':
      collectIdentifiers(ast.arg, out);
      break;
    case 'binary':
      collectIdentifiers(ast.left, out);
      collectIdentifiers(ast.right, out);
      break;
    case 'call':
      collectIdentifiers(ast.args[0], out);
      collectIdentifiers(ast.args[1], out);
      break;
  }
  return out;
}

/** Parses once and returns a reusable evaluator closure — compiled per load/reload,
 * not per turn per player. */
export function compileFormula(expression: string): (context: Record<string, number>) => number {
  const ast = parseFormula(expression);
  return (context: Record<string, number>) => evaluateFormula(ast, context);
}

export type CompiledFormula = ReturnType<typeof compileFormula>;

/** A loaded set of named, compiled formulas — GameLoop's live in-memory mirror of
 * the `Formula` table, rebuilt via buildFormulaSet() on every startup/admin edit. */
export type FormulaSet = Map<string, CompiledFormula>;

/** Compiles every row into a FormulaSet. Throws (with the offending key identified)
 * if any stored expression fails to parse — this should only ever happen if the DB
 * was edited outside the validated admin write path. */
export function buildFormulaSet(rows: Array<{ key: string; expression: string }>): FormulaSet {
  const set: FormulaSet = new Map();
  for (const row of rows) {
    try {
      set.set(row.key, compileFormula(row.expression));
    } catch (error: any) {
      throw new FormulaParseError(`Formula "${row.key}" failed to compile: ${error.message}`);
    }
  }
  return set;
}

/** Looks up and evaluates a named formula. Throws FormulaEvalError if no formula is
 * registered for `key` — a missing formula is a configuration bug, not a value to
 * silently default. */
export function evalNamed(formulas: FormulaSet, key: string, context: Record<string, number>): number {
  const fn = formulas.get(key);
  if (!fn) {
    throw new FormulaEvalError(`No formula registered for "${key}"`);
  }
  return fn(context);
}
