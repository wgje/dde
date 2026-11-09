import {
  decideRealtimeActivationTransport,
  type RealtimeActivationTransportDecision,
} from './realtime-polling-reentry.helpers';
import type { RealtimeTransportCircuitService } from './realtime-transport-circuit.service';

export interface RealtimeActivationFallbackLogger {
  info(message: string, data?: unknown): void;
}

export interface RealtimeActivationFallbackOptions {
  projectId: string;
  userId: string;
  transportGeneration: number;
  decision: Extract<RealtimeActivationTransportDecision, { mode: 'polling' }>;
  transportCircuit: RealtimeTransportCircuitService;
  logger: RealtimeActivationFallbackLogger;
  startPolling(projectId: string, userId: string, transportGeneration: number): void;
}

export interface RealtimeTransportActivationOptions {
  projectId: string;
  userId: string;
  transportGeneration: number;
  realtimeTransportSupported: boolean;
  transportCircuit: RealtimeTransportCircuitService;
  logger: RealtimeActivationFallbackLogger;
  startPolling(projectId: string, userId: string, transportGeneration: number): void;
  subscribeRealtime(projectId: string, userId: string, transportGeneration: number): Promise<void>;
}

export async function activateRealtimeTransportOrFallbackToPolling({
  projectId,
  userId,
  transportGeneration,
  realtimeTransportSupported,
  transportCircuit,
  logger,
  startPolling,
  subscribeRealtime,
}: RealtimeTransportActivationOptions): Promise<void> {
  const activationDecision = decideRealtimeActivationTransport({
    realtimeTransportSupported,
    remainingCircuitMs: transportCircuit.remainingCircuitMs(),
    remainingBackoffMs: transportCircuit.remainingBackoffMs(projectId),
  });
  if (activationDecision.mode === 'polling') {
    startPollingForRealtimeDecision({
      projectId,
      userId,
      transportGeneration,
      decision: activationDecision,
      transportCircuit,
      logger,
      startPolling,
    });
    return;
  }

  await subscribeRealtime(projectId, userId, transportGeneration);
}

export function startPollingForRealtimeDecision({
  projectId,
  userId,
  transportGeneration,
  decision,
  transportCircuit,
  logger,
  startPolling,
}: RealtimeActivationFallbackOptions): void {
  if (decision.reason === 'unsupported') {
    logger.info('当前环境不支持 WebSocket，继续使用轮询', { projectId });
    startPolling(projectId, userId, transportGeneration);
    return;
  }

  if (decision.reason === 'circuit') {
    const circuit = transportCircuit.snapshot();
    logger.info('Realtime 熔断窗口内继续使用轮询', {
      projectId,
      remainingMs: decision.remainingMs,
      failures: circuit.failures,
      lastError: circuit.lastError,
    });
    startPolling(projectId, userId, transportGeneration);
    return;
  }

  logger.info('Realtime 冷却期内继续使用轮询', {
    projectId,
    remainingMs: decision.remainingMs,
  });
  startPolling(projectId, userId, transportGeneration);
}
