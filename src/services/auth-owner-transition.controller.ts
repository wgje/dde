export interface AuthOwnerTransitionTicket {
  readonly ticketId: number;
  readonly capturedGeneration: number;
  readonly currentOwnerUserId: string | null;
  readonly pendingOwnerUserId: string | null;
  readonly targetOwnerUserId: string | null;
}

export type AuthOwnerTransitionStaleReason =
  | 'destroyed'
  | 'ticket-consumed'
  | 'generation-changed'
  | 'current-owner-changed'
  | 'pending-owner-changed'
  | 'reentrant-change';

export type AuthOwnerTransitionCommitResult =
  | { status: 'committed'; generation: number }
  | { status: 'stale'; reason: AuthOwnerTransitionStaleReason };

export interface AuthOwnerTransitionControllerOptions {
  generation: () => number;
  currentOwnerUserId: () => string | null;
  pendingOwnerUserId: () => string | null;
  advanceGeneration: () => void;
  publishTargetOwner: (ownerUserId: string | null) => void;
}

export class AuthOwnerTransitionController {
  private nextTicketId = 1;
  private captureVersion = 0;
  private destroyed = false;
  private readonly activeTickets = new Map<number, AuthOwnerTransitionTicket>();
  private readonly consumedTickets = new WeakSet<AuthOwnerTransitionTicket>();

  constructor(private readonly options: AuthOwnerTransitionControllerOptions) {}

  capture(targetOwnerUserId: string | null): AuthOwnerTransitionTicket {
    if (this.destroyed) {
      throw new Error('Auth owner transition controller is destroyed');
    }
    if (!Number.isSafeInteger(this.nextTicketId)) {
      throw new Error('Auth owner transition ticket sequence exhausted');
    }
    const ticket = Object.freeze({
      ticketId: this.nextTicketId,
      capturedGeneration: this.options.generation(),
      currentOwnerUserId: this.options.currentOwnerUserId(),
      pendingOwnerUserId: this.options.pendingOwnerUserId(),
      targetOwnerUserId,
    });
    this.nextTicketId += 1;
    this.captureVersion = ticket.ticketId;
    this.activeTickets.set(ticket.ticketId, ticket);
    return ticket;
  }

  commit(
    ticket: AuthOwnerTransitionTicket,
    cleanup: () => void,
  ): AuthOwnerTransitionCommitResult {
    if (this.destroyed) return { status: 'stale', reason: 'destroyed' };
    if (this.consumedTickets.has(ticket)
      || this.activeTickets.get(ticket.ticketId) !== ticket) {
      return { status: 'stale', reason: 'ticket-consumed' };
    }
    this.consume(ticket);
    if (this.options.generation() !== ticket.capturedGeneration) {
      return { status: 'stale', reason: 'generation-changed' };
    }
    if (this.options.currentOwnerUserId() !== ticket.currentOwnerUserId) {
      return { status: 'stale', reason: 'current-owner-changed' };
    }
    if (this.options.pendingOwnerUserId() !== ticket.pendingOwnerUserId) {
      return { status: 'stale', reason: 'pending-owner-changed' };
    }

    this.advanceGeneration();
    const committedGeneration = this.options.generation();
    if (cleanup.constructor.name === 'AsyncFunction') {
      throw new TypeError('Auth owner transition cleanup must be synchronous');
    }
    const captureVersionBeforeCleanup = this.captureVersion;
    const cleanupResult = cleanup() as unknown;
    if (this.isThenable(cleanupResult)) {
      throw new TypeError('Auth owner transition cleanup returned a thenable');
    }
    if (this.destroyed
      || this.options.generation() !== committedGeneration
      || this.captureVersion !== captureVersionBeforeCleanup
      || this.options.currentOwnerUserId() !== ticket.currentOwnerUserId
      || this.options.pendingOwnerUserId() !== ticket.pendingOwnerUserId) {
      return { status: 'stale', reason: 'reentrant-change' };
    }
    this.options.publishTargetOwner(ticket.targetOwnerUserId);
    return { status: 'committed', generation: committedGeneration };
  }

  discard(ticket: AuthOwnerTransitionTicket): void {
    if (this.activeTickets.get(ticket.ticketId) === ticket) {
      this.consume(ticket);
    }
  }

  advanceGeneration(): void {
    if (this.destroyed) return;
    this.consumeActiveTickets();
    this.options.advanceGeneration();
  }

  reset(): void {
    if (this.destroyed) return;
    this.advanceGeneration();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.advanceGeneration();
    this.destroyed = true;
  }

  private consume(ticket: AuthOwnerTransitionTicket): void {
    this.activeTickets.delete(ticket.ticketId);
    this.consumedTickets.add(ticket);
  }

  private consumeActiveTickets(): void {
    for (const ticket of this.activeTickets.values()) {
      this.consumedTickets.add(ticket);
    }
    this.activeTickets.clear();
  }

  private isThenable(value: unknown): value is PromiseLike<unknown> {
    return (typeof value === 'object' && value !== null) || typeof value === 'function'
      ? typeof (value as { then?: unknown }).then === 'function'
      : false;
  }
}

const ownerTransitions = new WeakMap<object, AuthOwnerTransitionController>();

export function bindAuthOwnerTransition<T extends AuthOwnerTransitionController>(
  owner: object,
  controller: T,
): T {
  if (ownerTransitions.has(owner)) {
    throw new Error('Auth owner transition controller is already bound');
  }
  ownerTransitions.set(owner, controller);
  return controller;
}

export function getAuthOwnerTransition(owner: object): AuthOwnerTransitionController {
  const controller = ownerTransitions.get(owner);
  if (!controller) {
    throw new Error('Auth owner transition controller is not bound');
  }
  return controller;
}
