import { Overlay } from '@angular/cdk/overlay';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExternalSourceLink } from '../../../core/external-sources/external-source.model';
import { KnowledgeAnchorPopoverService } from './knowledge-anchor-popover.service';

describe('KnowledgeAnchorPopoverService', () => {
  const link: ExternalSourceLink = {
    id: 'link-1',
    taskId: 'task-1',
    sourceType: 'siyuan-block',
    targetId: '20260426123456-abc1234',
    uri: 'siyuan://blocks/20260426123456-abc1234?focus=1',
    sortOrder: 0,
    deletedAt: null,
    createdAt: '2026-05-18T00:00:00.000Z',
    updatedAt: '2026-05-18T00:00:00.000Z',
  };

  let service: KnowledgeAnchorPopoverService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        KnowledgeAnchorPopoverService,
        { provide: Overlay, useValue: {} },
      ],
    });
    service = TestBed.inject(KnowledgeAnchorPopoverService);
  });

  afterEach(() => {
    service.dispose();
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('cancels zero-valued hover open and close timer handles', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'setTimeout')
      .mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>);
    const origin = document.createElement('button');

    service.scheduleOpen(link, origin);
    service.close();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);

    clearTimeoutSpy.mockClear();

    const owner = document.createElement('button');
    Reflect.set(service, 'originRef', owner);
    Reflect.set(service, 'activeOwner', owner);
    service.scheduleClose(owner);
    service.keepOpen(owner);

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
  });

  it('cancels only the pending open that belongs to the closing host', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      .mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>);
    const hostA = document.createElement('div');
    const hostB = document.createElement('div');
    const originA = document.createElement('button');
    const originB = document.createElement('button');
    hostA.append(originA);
    hostB.append(originB);

    service.scheduleOpen(link, originA, hostA);
    service.closeForHost(hostA);

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);

    clearTimeoutSpy.mockClear();
    service.scheduleOpen(link, originB, hostB);
    const pendingHostB = setTimeoutSpy.mock.results[1]?.value;
    service.closeForHost(hostA);

    expect(clearTimeoutSpy).not.toHaveBeenCalledWith(pendingHostB);
  });

  it('cancels its own pending open when a host leaves before the overlay opens', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      .mockImplementation(() => 3 as unknown as ReturnType<typeof setTimeout>);
    const host = document.createElement('div');
    const origin = document.createElement('button');
    host.append(origin);

    service.scheduleOpen(link, origin, host);
    const pendingOpen = setTimeoutSpy.mock.results[0]?.value;
    service.scheduleClose(host);

    expect(clearTimeoutSpy).toHaveBeenCalledWith(pendingOpen);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('closing an older host overlay preserves a newer host pending open', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      .mockImplementation(() => 1 as unknown as ReturnType<typeof setTimeout>);
    const hostA = document.createElement('div');
    const hostB = document.createElement('div');
    const originA = document.createElement('button');
    const originB = document.createElement('button');
    const detach = vi.fn();
    const dispose = vi.fn();
    hostA.append(originA);
    hostB.append(originB);
    Reflect.set(service, 'originRef', originA);
    Reflect.set(service, 'activeOwner', hostA);
    Reflect.set(service, 'overlayRef', { detach, dispose });

    service.scheduleOpen(link, originB, hostB);
    const pendingHostB = setTimeoutSpy.mock.results[0]?.value;
    service.closeForHost(hostA);

    expect(detach).toHaveBeenCalledOnce();
    expect(clearTimeoutSpy).not.toHaveBeenCalledWith(pendingHostB);
  });

  it('a late hover close from one host preserves another host pending open', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      .mockImplementation(() => 2 as unknown as ReturnType<typeof setTimeout>);
    const hostA = document.createElement('div');
    const hostB = document.createElement('div');
    const originA = document.createElement('button');
    const originB = document.createElement('button');
    hostA.append(originA);
    hostB.append(originB);
    Reflect.set(service, 'originRef', originA);
    Reflect.set(service, 'activeOwner', hostA);

    service.scheduleOpen(link, originB, hostB);
    const pendingHostB = setTimeoutSpy.mock.results[0]?.value;
    service.scheduleClose(hostA);

    expect(clearTimeoutSpy).not.toHaveBeenCalledWith(pendingHostB);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
  });
});
