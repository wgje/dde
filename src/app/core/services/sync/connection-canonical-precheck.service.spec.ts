import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Connection } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import {
  ConnectionCanonicalIdentityService,
  type EndpointConnectionMatch,
} from './connection-canonical-identity.service';
import { ConnectionCanonicalPrecheckService } from './connection-canonical-precheck.service';

describe('ConnectionCanonicalPrecheckService', () => {
  const mockLogger = {
    info: vi.fn(),
  };
  const canonicalIdentity = {
    applyCanonicalConnectionIdentity: vi.fn(),
    applyCanonicalConnectionState: vi.fn(),
    isCanonicalMatchAtLeastAsFresh: vi.fn(() => false),
  };

  let service: ConnectionCanonicalPrecheckService;
  let endpointMatches: EndpointConnectionMatch[];

  const client = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(async () => ({ data: endpointMatches, error: null })),
          })),
        })),
      })),
    })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    endpointMatches = [];

    TestBed.configureTestingModule({
      providers: [
        ConnectionCanonicalPrecheckService,
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => mockLogger),
          },
        },
        {
          provide: ConnectionCanonicalIdentityService,
          useValue: canonicalIdentity,
        },
      ],
    });

    service = TestBed.inject(ConnectionCanonicalPrecheckService);
  });

  it('reuses active remote endpoint identity before connection push', async () => {
    const connection: Connection = {
      id: 'local-connection',
      source: 'source-task',
      target: 'target-task',
      updatedAt: '2026-04-20T00:00:00.000Z',
    };
    endpointMatches = [{
      id: 'remote-connection',
      deleted_at: null,
      updated_at: '2026-04-20T00:01:00.000Z',
      title: 'Remote title',
      description: null,
    }];

    await service.applyCanonicalEndpointPrecheck(client as never, 'project-1', connection);

    expect(canonicalIdentity.applyCanonicalConnectionIdentity).toHaveBeenCalledWith(
      'project-1',
      connection,
      endpointMatches[0],
    );
    expect(canonicalIdentity.applyCanonicalConnectionState).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      '检测到远端同端点连接，复用既有 id 继续同步',
      expect.objectContaining({
        connectionId: 'local-connection',
        existingConnectionId: 'remote-connection',
        projectId: 'project-1',
      }),
    );
  });
});
