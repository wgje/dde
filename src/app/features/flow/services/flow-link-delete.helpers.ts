import type { LinkDataRef } from '../../../../models/flow-view-state';

export interface FlowLinkDeleteRequest {
  fromKey: string;
  toKey: string;
  isCrossTree: boolean;
}

export function resolveFlowLinkDeleteRequest(
  linkData: LinkDataRef['data'] | null | undefined,
): FlowLinkDeleteRequest | null {
  const fromKey = linkData?.['from'];
  const toKey = linkData?.['to'];

  if (typeof fromKey !== 'string' || typeof toKey !== 'string') {
    return null;
  }

  if (!fromKey || !toKey) {
    return null;
  }

  return {
    fromKey,
    toKey,
    isCrossTree: linkData?.['isCrossTree'] === true,
  };
}

export function resolveCrossTreeDeleteRequests(
  selectedLinks: LinkDataRef['data'][],
): FlowLinkDeleteRequest[] {
  return selectedLinks
    .map(resolveFlowLinkDeleteRequest)
    .filter((request): request is FlowLinkDeleteRequest => request !== null && request.isCrossTree);
}
