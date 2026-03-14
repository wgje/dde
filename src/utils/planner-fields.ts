export type PlannerCognitiveLoad = 'high' | 'low' | null;

export interface PlannerFieldInput {
  expectedMinutes?: unknown;
  waitMinutes?: unknown;
  cognitiveLoad?: unknown;
}

export interface PlannerFieldSet {
  expectedMinutes: number | null;
  waitMinutes: number | null;
  cognitiveLoad: PlannerCognitiveLoad;
  adjusted: boolean;
}

export function normalizePlannerMinutes(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const floored = Math.floor(value);
  // 值小于 1 时（如 0.5）floor 后为 0，语义无效，视为无数据
  return floored > 0 ? floored : null;
}

export function normalizePlannerCognitiveLoad(value: unknown): PlannerCognitiveLoad {
  return value === 'high' || value === 'low' ? value : null;
}

export function sanitizePlannerFields(input: PlannerFieldInput): PlannerFieldSet {
  let expectedMinutes = normalizePlannerMinutes(input.expectedMinutes);
  const waitMinutes = normalizePlannerMinutes(input.waitMinutes);
  const cognitiveLoad = normalizePlannerCognitiveLoad(input.cognitiveLoad);

  let adjusted = false;
  if (waitMinutes !== null && (expectedMinutes === null || waitMinutes > expectedMinutes)) {
    expectedMinutes = waitMinutes;
    adjusted = true;
  }

  return {
    expectedMinutes,
    waitMinutes,
    cognitiveLoad,
    adjusted,
  };
}

export function hasIncompletePlannerFields(input: PlannerFieldInput): boolean {
  const normalized = sanitizePlannerFields(input);
  return (
    normalized.expectedMinutes === null ||
    normalized.cognitiveLoad === null
  );
  // waitMinutes 为选填，不计入必填缺失判断
}
