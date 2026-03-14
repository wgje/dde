import { describe, expect, it } from 'vitest';
import {
  hasIncompletePlannerFields,
  normalizePlannerCognitiveLoad,
  normalizePlannerMinutes,
  sanitizePlannerFields,
} from './planner-fields';

describe('planner-fields', () => {
  it('normalizes positive minutes and drops invalid values', () => {
    expect(normalizePlannerMinutes(15.9)).toBe(15);
    expect(normalizePlannerMinutes(0)).toBeNull();
    expect(normalizePlannerMinutes(-5)).toBeNull();
    expect(normalizePlannerMinutes('10')).toBeNull();
  });

  it('handles edge cases: NaN, Infinity, fractional < 1', () => {
    expect(normalizePlannerMinutes(NaN)).toBeNull();
    expect(normalizePlannerMinutes(Infinity)).toBeNull();
    expect(normalizePlannerMinutes(-Infinity)).toBeNull();
    expect(normalizePlannerMinutes(0.5)).toBeNull();
    expect(normalizePlannerMinutes(0.99)).toBeNull();
    expect(normalizePlannerMinutes(1.01)).toBe(1);
  });

  it('normalizes cognitive load to high/low/null', () => {
    expect(normalizePlannerCognitiveLoad('high')).toBe('high');
    expect(normalizePlannerCognitiveLoad('low')).toBe('low');
    expect(normalizePlannerCognitiveLoad('medium')).toBeNull();
  });

  it('elevates expected minutes to wait minutes when wait is larger', () => {
    expect(
      sanitizePlannerFields({
        expectedMinutes: 10,
        waitMinutes: 25,
        cognitiveLoad: 'low',
      }),
    ).toEqual({
      expectedMinutes: 25,
      waitMinutes: 25,
      cognitiveLoad: 'low',
      adjusted: true,
    });
  });

  it('elevates missing expected minutes to wait minutes', () => {
    expect(
      sanitizePlannerFields({
        expectedMinutes: null,
        waitMinutes: 20,
        cognitiveLoad: null,
      }),
    ).toEqual({
      expectedMinutes: 20,
      waitMinutes: 20,
      cognitiveLoad: null,
      adjusted: true,
    });
  });

  it('detects incomplete planner fields after normalization', () => {
    expect(
      hasIncompletePlannerFields({
        expectedMinutes: 25,
        waitMinutes: 5,
        cognitiveLoad: 'high',
      }),
    ).toBe(false);

    // waitMinutes 为选填，不影响完整性判断
    expect(
      hasIncompletePlannerFields({
        expectedMinutes: 25,
        waitMinutes: null,
        cognitiveLoad: 'high',
      }),
    ).toBe(false);

    // expectedMinutes 缺失且无 waitMinutes 回补时仍为不完整
    expect(
      hasIncompletePlannerFields({
        expectedMinutes: null,
        waitMinutes: null,
        cognitiveLoad: 'high',
      }),
    ).toBe(true);
  });
});
