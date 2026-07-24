/**
 * Guardrails for AI-generated decision candidates (see `decisionGenService.ts`). A
 * schema-valid `DecisionDefinition` (passing `decisionDefinitionSchema`) can still be a
 * *bad* one — a small model can hallucinate a field name that isn't a real
 * `PlayerVariables` key, touch ten KPIs at once, or price a lawsuit at $50 or $50
 * billion. This is the second gate, applied after schema validation, that caps what an
 * AI-authored decision is allowed to touch and by how much, mirroring the request that
 * decisions "affect only a certain number of KPIs, within certain effect limits."
 *
 * Every range in `FIELD_RANGES`/`LEGAL_RISK_FIELD_RANGES` was derived by scanning the
 * real 45-decision/83-legal-risk seed library (`server/src/data/game_engine.json`) for
 * each field's observed min/max across every decision that touches it, then padded —
 * see CLAUDE.md's experimental "AI decision generation" section. This is intentionally
 * calibration, not a hard game-design ceiling: a legitimately strong hand-authored
 * decision could still exceed these via `/admin` directly. It only bounds what an AI
 * candidate can reach before a human reviews it.
 */

import type { DecisionDefinition, ImpactEntry, LegalRiskDefinition } from '@suetheirasses/shared';

export const MAX_IMPACT_FIELDS = 5;
export const MAX_LEGAL_RISKS = 3;
export const MIN_PROBABILITY = 0.01;
export const MAX_PROBABILITY = 0.7;

/** Fields a decision's own `impacts` (or the same field under a `target.` prefix) may
 * set — every `PlayerVariables` key EXCEPT the ones the engine computes itself each turn
 * (`equity`, `volume`, `receivables`, `stockValue`, `marketShare`, `competitiveness`,
 * `legalExposure*`) and the two share-ledger fields (`totalSharesOutstanding`,
 * `shareOwnership`), which only the dedicated Buy/Sell Shares mechanic may touch — see
 * `shareTransactionType` in gameTypes.ts. `revenue`/`financeCost`/`taxCost` ARE real,
 * legitimate targets despite being "derived" elsewhere — Channel Stuffing, Payday Loan,
 * and Tax Planning already set them in the real library. */
export const ALLOWED_IMPACT_FIELDS = [
  'cash', 'assets', 'intangibleAssets', 'debt', 'reserves', 'operatingExpenses', 'staffCost',
  'materialCostPerTon', 'otherIncome', 'price', 'capacityUtilization', 'processingLevel',
  'energyIntensity', 'moistureContent', 'nutrientConsistency', 'supplySecurity',
  'logisticsCostPerTon', 'processLoss', 'installedCapacity', 'outrage', 'scrutiny',
  'breakdowns', 'contaminationRisk', 'odorComplaints', 'tokenLiability', 'carbonFootprint',
  'stockVolume', 'demand', 'revenue', 'financeCost', 'taxCost',
] as const;

const ALLOWED_IMPACT_FIELD_SET = new Set<string>(ALLOWED_IMPACT_FIELDS);

/** A legal risk's `impact.target` is only ever meaningful as one of these three — see
 * `LegalEngine.fileLawsuit`'s stakes calc: `'cash'` prices the schedule value directly
 * (absolute), `'equity'`/`'revenue'` scale it against the defendant's own current value
 * of that field (relative). All 83 legal risks in the real library already use only
 * these three; nothing else has real engine precedent for pricing a lawsuit's stakes. */
export const ALLOWED_LEGAL_RISK_TARGETS = ['cash', 'equity', 'revenue'] as const;
type LegalRiskTarget = (typeof ALLOWED_LEGAL_RISK_TARGETS)[number];

type FieldRange = { absolute?: [number, number]; relative?: [number, number] };

export const FIELD_RANGES: Record<string, FieldRange> = {
  cash: { absolute: [-150000, 250000] },
  assets: { absolute: [-100000, 200000] },
  intangibleAssets: { absolute: [-60000, 80000] },
  debt: { absolute: [-60000, 120000] },
  reserves: { absolute: [-40000, 40000] },
  operatingExpenses: { absolute: [-25000, 30000], relative: [-0.2, 0.3] },
  staffCost: { absolute: [-20000, 30000] },
  materialCostPerTon: { relative: [-0.2, 0.2] },
  otherIncome: { absolute: [0, 25000] },
  price: { relative: [-0.2, 0.5] },
  capacityUtilization: { absolute: [-0.2, 0.2], relative: [-0.3, 0.4] },
  processingLevel: { absolute: [-0.2, 0.5] },
  energyIntensity: { relative: [-0.35, 0.4] },
  moistureContent: { absolute: [-0.15, 0.25] },
  nutrientConsistency: { absolute: [-0.1, 0.3] },
  supplySecurity: { relative: [-0.3, 0.3] },
  logisticsCostPerTon: { relative: [-0.25, 0.1] },
  processLoss: { absolute: [-0.1, 0.2] },
  installedCapacity: { relative: [-0.2, 0.4] },
  outrage: { absolute: [-60, 60] },
  scrutiny: { absolute: [-20, 40] },
  breakdowns: { absolute: [-0.2, 0.5] },
  contaminationRisk: { absolute: [-0.15, 0.3] },
  odorComplaints: { absolute: [-10, 40] },
  tokenLiability: { absolute: [0, 200000] },
  carbonFootprint: { absolute: [-30, 20] },
  stockVolume: { absolute: [-40, 10] },
  demand: { absolute: [-20, 20] },
  revenue: { absolute: [0, 50000] },
  financeCost: { absolute: [0, 20000] },
  taxCost: { absolute: [-25000, 0] },
};

const GENERIC_FALLBACK: Required<FieldRange> = { absolute: [-100000, 100000], relative: [-0.5, 0.5] };

const LEGAL_RISK_FIELD_RANGES: Record<LegalRiskTarget, [number, number]> = {
  cash: [-300000, -5000],
  equity: [-0.6, -0.02],
  revenue: [-0.5, -0.01],
};

export interface ClampWarning {
  path: string;
  message: string;
}

export interface ClampResult {
  decision: DecisionDefinition;
  warnings: ClampWarning[];
}

function clampNumber(v: unknown, range: [number, number]): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.min(range[1], Math.max(range[0], n));
}

function baseFieldName(key: string): string {
  return key.startsWith('target.') ? key.slice('target.'.length) : key;
}

function rangeFor(field: string, type: 'absolute' | 'relative'): [number, number] {
  return FIELD_RANGES[field]?.[type] ?? GENERIC_FALLBACK[type];
}

/** Most fields in the real seed library are only ever used as ONE of absolute/relative
 * — e.g. `materialCostPerTon` is always `relative` (a % change), never `absolute` (a flat
 * dollar-per-ton delta). A model picking the "wrong" type for such a field isn't a
 * magnitude problem `rangeFor`'s clamp can catch — a flat `+100` easily fits inside the
 * generic `[-100000, 100000]` fallback used for a type with no defined range, even
 * though `+100` applied as an absolute addend to a small per-ton cost is a wildly
 * different (and un-calibrated) effect than the `relative` fraction the field actually
 * supports. Coerces `type` to whichever ONE type `FIELD_RANGES` actually defines for a
 * field, rather than trusting the model's choice + a too-generous fallback range. */
function resolveImpactType(field: string, requestedType: 'absolute' | 'relative'): { type: 'absolute' | 'relative'; coerced: boolean } {
  const known = FIELD_RANGES[field];
  if (!known || known[requestedType]) return { type: requestedType, coerced: false };
  const onlyType = known.absolute ? 'absolute' : known.relative ? 'relative' : undefined;
  if (onlyType && onlyType !== requestedType) return { type: onlyType, coerced: true };
  return { type: requestedType, coerced: false };
}

function clampSchedule(
  schedule: unknown,
  range: [number, number],
  path: string,
  warnings: ClampWarning[],
): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof schedule !== 'object' || schedule === null) {
    warnings.push({ path, message: 'schedule was not an object — replaced with an empty one' });
    return out;
  }
  for (const [key, value] of Object.entries(schedule as Record<string, unknown>)) {
    const isYearKey = key === 'default' || /^\d+$/.test(key);
    if (!isYearKey) {
      warnings.push({ path: `${path}.${key}`, message: 'dropped non-year schedule key' });
      continue;
    }
    const clamped = clampNumber(value, range);
    if (clamped !== value) {
      warnings.push({ path: `${path}.${key}`, message: `clamped ${String(value)} to ${clamped}` });
    }
    out[key] = clamped;
  }
  return out;
}

function clampImpactEntry(
  field: string,
  entry: unknown,
  path: string,
  warnings: ClampWarning[],
): ImpactEntry | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const raw = entry as Partial<ImpactEntry>;
  const requestedType: 'absolute' | 'relative' = raw.type === 'relative' ? 'relative' : 'absolute';
  const { type, coerced } = resolveImpactType(field, requestedType);
  if (coerced) {
    warnings.push({ path: `${path}.type`, message: `"${field}" is only ever used as "${type}" in the real library — coerced from "${requestedType}"` });
  }
  const range = rangeFor(field, type);
  const schedule = clampSchedule(raw.schedule, range, `${path}.schedule`, warnings);
  if (Object.keys(schedule).length === 0) return null;
  return { type, schedule };
}

/** Filters + clamps `impacts` down to a whitelisted field set, at most
 * `MAX_IMPACT_FIELDS` entries, each schedule value within that field's real-data-derived
 * range. Returns entries in the model's own original order (first N kept, rest dropped
 * with a warning) — no attempt to rank "which fields matter more." */
function clampImpacts(
  impacts: unknown,
  warnings: ClampWarning[],
): Record<string, ImpactEntry> {
  const out: Record<string, ImpactEntry> = {};
  if (typeof impacts !== 'object' || impacts === null) return out;

  for (const [key, entry] of Object.entries(impacts as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_IMPACT_FIELDS) {
      warnings.push({ path: `impacts.${key}`, message: `dropped — exceeds the ${MAX_IMPACT_FIELDS}-field cap` });
      continue;
    }
    if (key === 'sharesAmount') {
      warnings.push({ path: `impacts.${key}`, message: 'dropped — reserved for the Share Issuance mechanic' });
      continue;
    }
    const base = baseFieldName(key);
    if (!ALLOWED_IMPACT_FIELD_SET.has(base)) {
      warnings.push({ path: `impacts.${key}`, message: `dropped — "${base}" is not a recognized KPI field` });
      continue;
    }
    const clamped = clampImpactEntry(base, entry, `impacts.${key}`, warnings);
    if (!clamped) {
      warnings.push({ path: `impacts.${key}`, message: 'dropped — empty or malformed impact entry' });
      continue;
    }
    out[key] = clamped;
  }
  return out;
}

function clampLegalRisk(
  risk: unknown,
  index: number,
  warnings: ClampWarning[],
): LegalRiskDefinition | null {
  if (typeof risk !== 'object' || risk === null) return null;
  const raw = risk as Partial<LegalRiskDefinition>;
  const path = `legalRisks[${index}]`;

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (!name || !description) {
    warnings.push({ path, message: 'dropped — missing name or description' });
    return null;
  }

  const rawTarget = typeof raw.impact?.target === 'string' ? raw.impact.target : '';
  const target: LegalRiskTarget = (ALLOWED_LEGAL_RISK_TARGETS as readonly string[]).includes(rawTarget)
    ? (rawTarget as LegalRiskTarget)
    : 'cash';
  if (rawTarget !== target) {
    warnings.push({ path: `${path}.impact.target`, message: `"${rawTarget}" is not suable — defaulted to "cash"` });
  }
  const type: 'absolute' | 'relative' = target === 'cash' ? 'absolute' : 'relative';
  const impactRange = LEGAL_RISK_FIELD_RANGES[target];
  const schedule = clampSchedule(raw.impact?.schedule, impactRange, `${path}.impact.schedule`, warnings);
  if (Object.keys(schedule).length === 0) {
    warnings.push({ path, message: 'dropped — empty impact schedule' });
    return null;
  }

  const probability = clampSchedule(raw.probability, [MIN_PROBABILITY, MAX_PROBABILITY], `${path}.probability`, warnings);
  if (Object.keys(probability).length === 0) {
    warnings.push({ path, message: 'dropped — empty probability schedule' });
    return null;
  }

  return { name, description, probability, impact: { type, target, schedule } };
}

function clampLegalRisks(legalRisks: unknown, warnings: ClampWarning[]): LegalRiskDefinition[] {
  if (!Array.isArray(legalRisks)) return [];
  const out: LegalRiskDefinition[] = [];
  const seenNames = new Set<string>();
  for (let i = 0; i < legalRisks.length; i++) {
    if (out.length >= MAX_LEGAL_RISKS) {
      warnings.push({ path: `legalRisks[${i}]`, message: `dropped — exceeds the ${MAX_LEGAL_RISKS}-ground cap` });
      continue;
    }
    const clamped = clampLegalRisk(legalRisks[i], i, warnings);
    if (!clamped) continue;
    const key = clamped.name.toLowerCase();
    if (seenNames.has(key)) {
      warnings.push({ path: `legalRisks[${i}]`, message: `dropped — duplicate ground name "${clamped.name}"` });
      continue;
    }
    seenNames.add(key);
    out.push(clamped);
  }
  return out;
}

function uniqueName(candidate: string, existingDecisionNames: string[], warnings: ClampWarning[]): string {
  const trimmed = candidate.trim() || 'Untitled AI Decision';
  if (!existingDecisionNames.includes(trimmed)) return trimmed;
  let suffix = 2;
  let renamed = `${trimmed} (AI)`;
  while (existingDecisionNames.includes(renamed)) {
    renamed = `${trimmed} (AI ${suffix})`;
    suffix++;
  }
  warnings.push({ path: 'decision', message: `renamed "${trimmed}" to "${renamed}" — name already exists` });
  return renamed;
}

/**
 * Second validation gate for an AI-generated decision, applied AFTER
 * `decisionDefinitionSchema.parse` has already confirmed the raw shape is structurally
 * sound. Filters `impacts` to a whitelisted field set with a hard field-count cap and
 * per-field magnitude clamps, does the equivalent for `legalRisks` (ground count cap,
 * suable-target whitelist, probability/stakes clamps), fixes `offensiveAction`/
 * `requiresTarget` to actually match whether any `target.*` impact survived, strips
 * fields reserved for the built-in Buy/Sell Shares mechanic, and resolves a name
 * collision against the existing library. Never throws — a candidate this function
 * can't salvage into something with at least one real impact should be treated as a
 * generation failure by the caller (see `decisionGenService.ts`), not silently
 * shipped empty.
 */
export function clampDecisionCandidate(
  raw: DecisionDefinition,
  existingDecisionNames: string[],
): ClampResult {
  const warnings: ClampWarning[] = [];

  const impacts = clampImpacts((raw as any).impacts, warnings);
  const legalRisks = clampLegalRisks((raw as any).legalRisks, warnings);
  const hasTargetImpacts = Object.keys(impacts).some((k) => k.startsWith('target.'));

  const level = raw.level === 'Strategic' || raw.level === 'Operational' ? raw.level : 'Operational';
  if (level !== raw.level) warnings.push({ path: 'level', message: `invalid level — defaulted to "${level}"` });

  const nature = raw.nature === 'Traditional' || raw.nature === 'Grey Area' || raw.nature === 'Dirty' ? raw.nature : 'Traditional';
  if (nature !== raw.nature) warnings.push({ path: 'nature', message: `invalid nature — defaulted to "${nature}"` });

  const description = typeof raw.description === 'string' && raw.description.trim()
    ? raw.description.trim()
    : 'AI-generated decision — no description was provided.';
  if (description !== raw.description) warnings.push({ path: 'description', message: 'missing description — placeholder inserted' });

  const excludes = Array.isArray(raw.excludes)
    ? raw.excludes.filter((n) => typeof n === 'string' && existingDecisionNames.includes(n) && n !== raw.decision)
    : [];

  const decisionName = uniqueName(typeof raw.decision === 'string' ? raw.decision : '', existingDecisionNames, warnings);

  const competitorsView = Array.isArray(raw.competitorsView)
    ? raw.competitorsView.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 4)
    : [];

  const decision: DecisionDefinition = {
    decision: decisionName,
    level,
    description,
    nature,
    offensiveAction: hasTargetImpacts ? true : Boolean(raw.offensiveAction),
    excludes,
    impacts,
    ...(legalRisks.length > 0 ? { legalRisks } : {}),
    ...(competitorsView.length > 0 ? { competitorsView } : {}),
    ...(hasTargetImpacts ? { requiresTarget: true } : {}),
  };

  if ('cash' in impacts) {
    const validCategories = ['operating', 'investing', 'financing'];
    const category = validCategories.includes(raw.cashFlowCategory as string) ? raw.cashFlowCategory : 'operating';
    if (category !== raw.cashFlowCategory) {
      warnings.push({ path: 'cashFlowCategory', message: `missing/invalid — defaulted to "${category}"` });
    }
    (decision as any).cashFlowCategory = category;
  }

  return { decision, warnings };
}

/** True once `clampDecisionCandidate` has produced something worth showing to an admin
 * — at least one real (whitelisted, in-range) impact. A candidate with none is not a
 * decision at all, just noise; the caller should treat this as a failed generation
 * attempt and retry rather than surface an empty draft. */
export function isViableCandidate(result: ClampResult): boolean {
  return Object.keys(result.decision.impacts).length > 0;
}
