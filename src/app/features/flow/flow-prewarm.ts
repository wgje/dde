export interface FlowFeaturePrewarmResult {
  warmed: boolean;
  warmedServices: string[];
  createdDiagram: false;
}

export async function prewarmFlowFeature(): Promise<FlowFeaturePrewarmResult> {
  await Promise.all([
    import('./components/flow-view.component'),
    import('./services/flow-diagram.service'),
    import('./services/flow-diagram-data.service'),
    import('./services/flow-layout.service'),
    import('./services/flow-template.service'),
    import('./services/flow-link-template.service'),
    import('./services/flow-overview.service'),
  ]);

  return {
    warmed: true,
    warmedServices: [
      'FlowViewComponent',
      'FlowDiagramService',
      'FlowDiagramDataService',
      'FlowLayoutService',
      'FlowTemplateService',
      'FlowLinkTemplateService',
      'FlowOverviewService',
    ],
    createdDiagram: false,
  };
}
