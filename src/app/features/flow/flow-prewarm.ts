export interface FlowPrewarmFeatureResult {
  warmed: boolean;
  warmedServices?: string[];
}

export function prewarmFlowFeature(): Promise<FlowPrewarmFeatureResult> {
  return Promise.resolve({ warmed: true, warmedServices: [] });
}
