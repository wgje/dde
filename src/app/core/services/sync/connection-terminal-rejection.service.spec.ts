import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Connection, Project } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { ConnectionCanonicalIdentityService } from './connection-canonical-identity.service';
import { ConnectionTerminalRejectionService } from './connection-terminal-rejection.service';

describe('ConnectionTerminalRejectionService', () => {
  const mockLogger = {
    info: vi.fn(),
  };
  const mockSentry = {
    captureMessage: vi.fn(),
  };

  let projects: Project[];
  let service: ConnectionTerminalRejectionService;

  const canonicalIdentity = {
    updateProjectsFromCurrentData: vi.fn((mutator: (current: Project[]) => Project[]) => {
      projects = mutator(projects);
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    projects = [{
      id: 'project-1',
      name: 'Project',
      description: '',
      connections: [{
        id: 'connection-1',
        source: 'source-task',
        target: 'target-task',
      }],
      tasks: [],
      createdDate: '2026-04-20T00:00:00.000Z',
      updatedAt: '2026-04-20T00:00:00.000Z',
    }];

    TestBed.configureTestingModule({
      providers: [
        ConnectionTerminalRejectionService,
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => mockLogger),
          },
        },
        { provide: SentryLazyLoaderService, useValue: mockSentry },
        {
          provide: ConnectionCanonicalIdentityService,
          useValue: canonicalIdentity,
        },
      ],
    });

    service = TestBed.inject(ConnectionTerminalRejectionService);
  });

  it('soft deletes terminally rejected connections in local project state', () => {
    const connection: Connection = {
      id: 'connection-1',
      source: 'source-task',
      target: 'target-task',
    };

    service.discardInvalidConnectionLocally(
      connection,
      'project-1',
      'connection_endpoint_not_in_project',
    );

    expect(projects[0].connections).toEqual([
      expect.objectContaining({
        id: 'connection-1',
        deletedAt: expect.any(String),
        updatedAt: expect.any(String),
      }),
    ]);
    expect(mockLogger.info).toHaveBeenCalledWith(
      'connection 终态拒绝，就地软删避免 RetryQueue 循环',
      expect.objectContaining({
        connectionId: 'connection-1',
        projectId: 'project-1',
        reason: 'connection_endpoint_not_in_project',
      }),
    );
    expect(mockSentry.captureMessage).toHaveBeenCalledWith(
      'connection_discarded_terminal_rejection',
      expect.objectContaining({
        level: 'info',
        tags: expect.objectContaining({
          operation: 'pushConnection',
          entityType: 'connection',
          reason: 'connection_endpoint_not_in_project',
        }),
      }),
    );
  });
});
