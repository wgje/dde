import { LAYOUT_CONFIG } from '../../../../config/layout.config';
import type { GoJSLinkData } from './flow-diagram-config.service';

interface LinkSpan {
  readonly link: GoJSLinkData;
  readonly fromStage: number;
  readonly toStage: number;
  readonly minStage: number;
  readonly maxStage: number;
}

interface LinkAssignment {
  boundary: number;
  slot: number;
}

const FRACTION_MIN = 0.08;
const FRACTION_MAX = 0.92;

export function assignCrossTreeLabelStagger(
  crossTreeLinks: GoJSLinkData[],
  taskStageMap: Map<string, number | null>,
  stageNodeCount: Map<number, number>
): void {
  if (crossTreeLinks.length < 2) return;

  const { crossSpans, zeroSpans } = splitLinkSpans(crossTreeLinks, taskStageMap);
  assignCrossStageLabelStagger(crossSpans, stageNodeCount);
  assignSameStageLabelStagger(zeroSpans, stageNodeCount);
}

function splitLinkSpans(
  crossTreeLinks: GoJSLinkData[],
  taskStageMap: Map<string, number | null>
): { crossSpans: LinkSpan[]; zeroSpans: LinkSpan[] } {
  const crossSpans: LinkSpan[] = [];
  const zeroSpans: LinkSpan[] = [];

  for (const link of crossTreeLinks) {
    const span = createLinkSpan(link, taskStageMap);
    if (!span) continue;

    if (span.maxStage === span.minStage) {
      zeroSpans.push(span);
    } else {
      crossSpans.push(span);
    }
  }

  return { crossSpans, zeroSpans };
}

function createLinkSpan(
  link: GoJSLinkData,
  taskStageMap: Map<string, number | null>
): LinkSpan | null {
  const fromStage = taskStageMap.get(link.from);
  const toStage = taskStageMap.get(link.to);
  if (fromStage === undefined || fromStage === null || toStage === undefined || toStage === null) {
    return null;
  }

  return {
    link,
    fromStage,
    toStage,
    minStage: Math.min(fromStage, toStage),
    maxStage: Math.max(fromStage, toStage),
  };
}

function assignCrossStageLabelStagger(
  crossSpans: LinkSpan[],
  stageNodeCount: Map<number, number>
): void {
  sortCrossSpans(crossSpans);
  const { boundaryBuckets, linkAssignments } = assignBoundarySlots(crossSpans);

  for (const span of crossSpans) {
    const assignment = linkAssignments.get(span.link.key);
    const bucket = assignment ? boundaryBuckets.get(assignment.boundary) : undefined;
    if (!assignment || !bucket) continue;

    applyCrossStageAssignment(span, assignment, bucket.length, stageNodeCount);
  }
}

function sortCrossSpans(crossSpans: LinkSpan[]): void {
  crossSpans.sort((x, y) => {
    const spanDelta = (x.maxStage - x.minStage) - (y.maxStage - y.minStage);
    return spanDelta !== 0 ? spanDelta : x.link.key.localeCompare(y.link.key);
  });
}

function assignBoundarySlots(crossSpans: LinkSpan[]): {
  boundaryBuckets: Map<number, LinkSpan[]>;
  linkAssignments: Map<string, LinkAssignment>;
} {
  const boundaryBuckets = new Map<number, LinkSpan[]>();
  const linkAssignments = new Map<string, LinkAssignment>();

  for (const span of crossSpans) {
    const boundary = chooseBestBoundary(span, boundaryBuckets);
    const bucket = getOrCreateBoundaryBucket(boundaryBuckets, boundary);
    const slot = bucket.length;
    bucket.push(span);
    linkAssignments.set(span.link.key, { boundary, slot });
  }

  return { boundaryBuckets, linkAssignments };
}

function chooseBestBoundary(
  span: LinkSpan,
  boundaryBuckets: Map<number, LinkSpan[]>
): number {
  const rangeSpan = span.maxStage - span.minStage;
  const desiredFractionFromMin = span.fromStage === span.minStage
    ? LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_TARGET_SIDE_FRACTION
    : 1 - LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_TARGET_SIDE_FRACTION;
  let bestBoundary = span.minStage;
  let bestSize = Infinity;
  let bestDistance = Infinity;

  for (let boundary = span.minStage; boundary < span.maxStage; boundary += 1) {
    const size = boundaryBuckets.get(boundary)?.length ?? 0;
    const boundaryFractionFromMin = (boundary - span.minStage + 0.5) / rangeSpan;
    const distance = Math.abs(boundaryFractionFromMin - desiredFractionFromMin);
    if (size < bestSize || (size === bestSize && distance < bestDistance)) {
      bestSize = size;
      bestDistance = distance;
      bestBoundary = boundary;
    }
  }

  return bestBoundary;
}

function getOrCreateBoundaryBucket(
  boundaryBuckets: Map<number, LinkSpan[]>,
  boundary: number
): LinkSpan[] {
  let bucket = boundaryBuckets.get(boundary);
  if (!bucket) {
    bucket = [];
    boundaryBuckets.set(boundary, bucket);
  }

  return bucket;
}

function applyCrossStageAssignment(
  span: LinkSpan,
  assignment: LinkAssignment,
  bucketSize: number,
  stageNodeCount: Map<number, number>
): void {
  const rangeSpan = span.maxStage - span.minStage;
  const baseFractionFromSource = resolveBaseFractionFromSource(span, assignment.boundary);
  const denseBoost = getDenseBoost(
    stageNodeCount,
    assignment.boundary,
    assignment.boundary + 1
  );

  span.link.labelSegmentFraction = computeEmbeddedLabelFraction(
    baseFractionFromSource,
    assignment.slot,
    bucketSize,
    (LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_FRACTION_STEP * 0.5 * denseBoost) / rangeSpan,
    FRACTION_MIN,
    FRACTION_MAX
  );
  span.link.labelSegmentOffsetY = 0;
}

function resolveBaseFractionFromSource(span: LinkSpan, boundary: number): number {
  const rangeSpan = span.maxStage - span.minStage;
  const baseFractionFromMin = (boundary - span.minStage + 0.5) / rangeSpan;
  if (rangeSpan === 1) {
    return LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_TARGET_SIDE_FRACTION;
  }

  return span.fromStage === span.minStage
    ? baseFractionFromMin
    : 1 - baseFractionFromMin;
}

function assignSameStageLabelStagger(
  zeroSpans: LinkSpan[],
  stageNodeCount: Map<number, number>
): void {
  if (zeroSpans.length < 2) return;

  for (const bucket of createSameStageBuckets(zeroSpans).values()) {
    if (bucket.length < 2) continue;
    bucket.sort((x, y) => x.link.key.localeCompare(y.link.key));
    applySameStageBucket(bucket, stageNodeCount);
  }
}

function createSameStageBuckets(zeroSpans: LinkSpan[]): Map<number, LinkSpan[]> {
  const sameStageBuckets = new Map<number, LinkSpan[]>();
  for (const span of zeroSpans) {
    const bucket = getOrCreateBoundaryBucket(sameStageBuckets, span.minStage);
    bucket.push(span);
  }

  return sameStageBuckets;
}

function applySameStageBucket(
  bucket: LinkSpan[],
  stageNodeCount: Map<number, number>
): void {
  const isDense = isDenseStage(stageNodeCount, bucket[0].minStage);
  const fractionStep = LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_FRACTION_STEP *
    (isDense ? LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_DENSE_STAGE_VERTICAL_BOOST : 1);

  for (let index = 0; index < bucket.length; index += 1) {
    bucket[index].link.labelSegmentFraction = computeEmbeddedLabelFraction(
      LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_TARGET_SIDE_FRACTION,
      index,
      bucket.length,
      fractionStep,
      FRACTION_MIN,
      FRACTION_MAX
    );
    bucket[index].link.labelSegmentOffsetY = 0;
  }
}

function getDenseBoost(
  stageNodeCount: Map<number, number>,
  leftStage: number,
  rightStage: number
): number {
  const leftCount = stageNodeCount.get(leftStage) ?? 0;
  const rightCount = stageNodeCount.get(rightStage) ?? 0;
  return Math.min(leftCount, rightCount) >=
    LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_DENSE_STAGE_THRESHOLD
    ? LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_DENSE_STAGE_VERTICAL_BOOST
    : 1;
}

function isDenseStage(stageNodeCount: Map<number, number>, stage: number): boolean {
  return (stageNodeCount.get(stage) ?? 0) >=
    LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_DENSE_STAGE_THRESHOLD;
}

function computeEmbeddedLabelFraction(
  baseFraction: number,
  slot: number,
  bucketSize: number,
  preferredStep: number,
  minFraction: number,
  maxFraction: number
): number {
  const clampedBase = Math.min(maxFraction, Math.max(minFraction, baseFraction));
  if (bucketSize <= 1) {
    return clampedBase;
  }

  const normalizedPreferredStep = Math.max(0, preferredStep);
  const mid = (bucketSize - 1) / 2;
  const preferredHalfSpan = normalizedPreferredStep * mid;
  const minCenter = minFraction + preferredHalfSpan;
  const maxCenter = maxFraction - preferredHalfSpan;

  const centeredBase = minCenter <= maxCenter
    ? Math.min(maxCenter, Math.max(minCenter, baseFraction))
    : (minFraction + maxFraction) / 2;
  const safeStep = minCenter <= maxCenter
    ? normalizedPreferredStep
    : (maxFraction - minFraction) / Math.max(bucketSize - 1, 1);

  return Math.min(
    maxFraction,
    Math.max(minFraction, centeredBase + (slot - mid) * safeStep)
  );
}
