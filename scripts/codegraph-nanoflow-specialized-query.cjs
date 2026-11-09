'use strict';

const STRICT_NATIVE_OUTPUT_FOCUSED_QUERY = [
  'scripts/query-codegraph-nanoflow-overlay.mjs',
  'formatStrictNativeMarkdown',
  'formatNativeMarkdown',
  'buildStrictNativeMarkdownRelationshipGroups',
  'nativeJsonEdgeLine',
].join(' ');

const CONTEXT7_MAINTENANCE_FOCUSED_QUERY = [
  'docs/context7/catalog.json',
  'docs/context7/source-map.md',
  'context7-retrieval-route',
  'context7-source-map-route',
  'context7-retrieval-primary',
  'context7-source-map-source',
].join(' ');

const TOOLING_FIXTURE_QUALITY_FOCUSED_QUERY = [
  'src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts',
  'buildFakeCodegraphExploreScript',
  'writeFakeCodegraphExploreScript',
  'context-pack source quality fixtures',
].join(' ');

function classifySpecializedMaintenanceQuery({
  segments = [],
  codegraphTooling = false,
  context7Documentation = false,
} = {}) {
  const segmentSet = new Set(
    segments.map(segment => String(segment).toLowerCase()).filter(Boolean),
  );
  const hasStrictNativeMaintenanceIntent = [
    'adaptation',
    'maintenance',
    'quality',
    'standard',
  ].some(segment => segmentSet.has(segment));
  const strictNativeOutputMaintenance = codegraphTooling
    && hasStrictNativeMaintenanceIntent
    && segmentSet.has('strict')
    && segmentSet.has('native')
    && ['output', 'markdown', 'json', 'formatter', 'format', 'projection']
      .some(segment => segmentSet.has(segment));
  const hasContext7Anchor = ['codegraph', 'nanoflow', 'adapter', 'adaptation', 'overlay']
    .some(segment => segmentSet.has(segment));
  const hasContext7RouteIntent = segmentSet.has('retrieval')
    || segmentSet.has('sourcemap')
    || segmentSet.has('route')
    || (segmentSet.has('source') && segmentSet.has('map'));
  const context7Maintenance = context7Documentation
    && hasContext7Anchor
    && hasContext7RouteIntent;
  const hasHelper = segmentSet.has('helper') || segmentSet.has('helpers');
  const hasFixture = segmentSet.has('fixture') || segmentSet.has('fixtures');
  const hasFixtureQualityIntent = [
    'quality',
    'source',
    'sources',
    'script',
    'scripts',
    'block',
    'blocks',
    'standard',
  ].some(segment => segmentSet.has(segment));
  const toolingFixtureQuality = codegraphTooling
    && hasHelper
    && hasFixture
    && hasFixtureQualityIntent;

  return {
    strictNativeOutputMaintenance,
    context7Maintenance,
    toolingFixtureQuality,
    focusedQuery: strictNativeOutputMaintenance
      ? STRICT_NATIVE_OUTPUT_FOCUSED_QUERY
      : context7Maintenance
        ? CONTEXT7_MAINTENANCE_FOCUSED_QUERY
        : toolingFixtureQuality
          ? TOOLING_FIXTURE_QUALITY_FOCUSED_QUERY
          : '',
  };
}

module.exports = {
  STRICT_NATIVE_OUTPUT_FOCUSED_QUERY,
  CONTEXT7_MAINTENANCE_FOCUSED_QUERY,
  TOOLING_FIXTURE_QUALITY_FOCUSED_QUERY,
  classifySpecializedMaintenanceQuery,
};
