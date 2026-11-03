/**
 * DynamicModalService - 指令式动态模态框渲染服务
 *
 * 核心设计理念：
 * - 不再使用 *ngIf 触发模板显隐（"开关式"的陈旧思维）
 * - 调用 open(ComponentType) 直接渲染内容到 DOM
 * - 关闭时销毁组件，DOM 树保持干净
 * - 弹窗存在时才渲染节点，关闭即销毁
 *
 * 使用示例：
 * ```typescript
 * const result = await dynamicModal.open(DeleteConfirmModalComponent, {
 *   title: '删除项目',
 *   itemName: 'My Project'
 * });
 * if (result.confirmed) {
 *   await deleteProject(projectId);
 * }
 * ```
 */
import {
  Injectable,
  ApplicationRef,
  createComponent,
  EnvironmentInjector,
  Type,
  ComponentRef,
  inject,
  signal,
  computed,
  Injector,
  DestroyRef,
  InjectionToken,
  afterNextRender,
  type AfterRenderRef,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { ConfigurableFocusTrapFactory, type ConfigurableFocusTrap } from '@angular/cdk/a11y';
// Subscription 类型已移除，使用 { unsubscribe(): void } 鸭子类型兼容 EventEmitter 和 output()

/** 模态框配置接口 */
export interface ModalConfig<T = unknown> {
  /** 传递给组件的数据（通过 MODAL_DATA 注入令牌） */
  data?: T;
  /** 通过 componentRef.setInput() 设置的组件输入 */
  inputs?: Record<string, unknown>;
  /** 订阅组件输出事件的回调映射（key 为 output 名称） */
  outputs?: Record<string, (event: unknown) => void>;
  /** 是否显示遮罩层 */
  hasBackdrop?: boolean;
  /** 点击遮罩层是否关闭 */
  closeOnBackdropClick?: boolean;
  /** 按 ESC 是否关闭 */
  closeOnEscape?: boolean;
  /** 自定义容器选择器（默认 body） */
  containerSelector?: string;
  /** 模态框 z-index 层级 */
  zIndex?: number;
}

/** 模态框引用，用于控制已打开的模态框 */
export interface ModalRef<R = unknown> {
  /** 关闭模态框并返回结果 */
  close: (result?: R) => void;
  /** 获取模态框结果的 Promise */
  result: Promise<R>;
  /** 组件实例 */
  componentRef: ComponentRef<unknown>;
}

/** 模态框栈项 */
interface ModalStackItem {
  id: string;
  componentRef: ComponentRef<unknown>;
  backdropElement?: HTMLElement;
  containerElement: HTMLElement;
  resolve: (result: unknown) => void;
  config: ModalConfig;
  escapeListener?: (e: KeyboardEvent) => void;
  /** 订阅清理数组（兼容 RxJS Subscription 和 Angular OutputRefSubscription） */
  subscriptions: ModalSubscription[];
  focusTrap: ConfigurableFocusTrap;
  focusRenderRef: AfterRenderRef | null;
  focusGeneration: number;
  contentWrapper: HTMLElement;
  opener: HTMLElement | null;
}

type ModalSubscription = { unsubscribe(): void };
type ModalCleanup = () => void;
type SubscribableOutput<T = unknown> = {
  subscribe?: (fn: (value: T) => void) => ModalSubscription;
};
type ResolvedModalConfig<T = unknown> =
  Required<Omit<ModalConfig<T>, 'data' | 'containerSelector' | 'inputs' | 'outputs'>>
  & Pick<ModalConfig<T>, 'data' | 'containerSelector' | 'inputs' | 'outputs'>;

interface ModalShell {
  backdropElement?: HTMLElement;
  containerElement: HTMLElement;
  contentWrapper: HTMLElement;
}

/** 默认配置 */
const DEFAULT_CONFIG: Required<Omit<ModalConfig, 'data' | 'containerSelector' | 'inputs' | 'outputs'>> = {
  hasBackdrop: true,
  closeOnBackdropClick: true,
  closeOnEscape: true,
  zIndex: 1000
};

/**
 * 动态模态框服务
 *
 * 职责：
 * - 动态创建和销毁模态框组件
 * - 管理模态框栈（支持多层嵌套）
 * - 处理遮罩层、键盘事件、焦点管理
 */
@Injectable({
  providedIn: 'root'
})
export class DynamicModalService {
  private appRef = inject(ApplicationRef);
  private injector = inject(EnvironmentInjector);
  private document = inject(DOCUMENT);
  private destroyRef = inject(DestroyRef);
  private focusTrapFactory = inject(ConfigurableFocusTrapFactory);

  /** 模态框栈 */
  private modalStack = signal<ModalStackItem[]>([]);

  /** 当前打开的模态框数量 */
  readonly stackDepth = computed(() => this.modalStack().length);

  /** 是否有任何模态框打开 */
  readonly hasOpenModal = computed(() => this.modalStack().length > 0);

  /** 模态框 ID 计数器 */
  private idCounter = 0;
  private stackSettlementGeneration = 0;
  private settlementModalIds: string[] = [];
  private closeAllFocusSettlementTokens: symbol[] = [];
  private focusSettlementDepth = 0;
  private isDestroyed = false;

  constructor() {
    // 清理：服务销毁时关闭所有模态框
    this.destroyRef.onDestroy(() => {
      if (this.isDestroyed) return;
      this.isDestroyed = true;
      this.closeAllItems(false);
    });
  }

  /**
   * 打开模态框（指令式 API）
   *
   * @param component 要渲染的组件类型
   * @param config 模态框配置（包含传递给组件的数据）
   * @returns ModalRef 包含 close 方法和 result Promise
   *
   * 组件约定：
   * - 组件应该注入 MODAL_DATA 获取传入数据
   * - 组件应该注入 ModalRef 来关闭自身
   * - 或者组件可以 emit close 事件
   */
  open<C, D = unknown, R = unknown>(
    component: Type<C>,
    config: ModalConfig<D> = {}
  ): ModalRef<R> {
    if (this.isDestroyed) {
      throw new Error('DynamicModalService is destroyed');
    }
    const opener = this.captureConnectedOpener();
    const mergedConfig = this.mergeConfig(config);
    const modalId = `modal-${++this.idCounter}`;
    const { resultPromise, resolvePromise } = this.createResultPromise<R>();
    const rollback: ModalCleanup[] = [];
    const closeModal = (result?: R) => {
      this.closeById(modalId, result);
    };
    const modalRefToken = this.createModalRefToken(closeModal, resultPromise);
    try {
      const shell = this.createModalShell(modalId, mergedConfig, rollback);
      const componentRef = this.createModalComponent(component, shell.contentWrapper, config.data, modalRefToken);
      rollback.push(() => componentRef.destroy());
      modalRefToken.componentRef = componentRef as ComponentRef<unknown>;
      this.applyComponentInputs(componentRef, config.inputs);
      const subscriptions: ModalSubscription[] = [];
      this.addSubscriptionRollback(rollback, subscriptions);
      this.subscribeComponentOutputs(componentRef, config.outputs, closeModal, modalId, subscriptions);
      rollback.push(() => this.appRef.detachView(componentRef.hostView));
      this.appRef.attachView(componentRef.hostView);
      const escapeListener = this.registerEscapeListener(mergedConfig, modalId, closeModal, rollback);
      const focusTrap = this.focusTrapFactory.create(shell.contentWrapper);
      rollback.push(() => focusTrap.destroy());
      const item = this.addToStack(
        modalId, componentRef, shell, mergedConfig, resolvePromise, escapeListener,
        subscriptions, focusTrap, opener, rollback,
      );
      rollback.push(() => {
        item.focusGeneration += 1;
        item.focusRenderRef?.destroy();
        item.focusRenderRef = null;
      });
      this.scheduleInitialFocus(item);
      rollback.length = 0;
      return modalRefToken;
    } catch (error) {
      this.runModalSettlement(modalId, () => this.rollbackModalOpen(rollback));
      throw error;
    }
  }

  private mergeConfig<D>(config: ModalConfig<D>): ResolvedModalConfig<D> {
    return {
      ...DEFAULT_CONFIG,
      ...config
    };
  }

  private createResultPromise<R>(): {
    resolvePromise: (result: R) => void;
    resultPromise: Promise<R>;
  } {
    let resolvePromise!: (result: R) => void;
    const resultPromise = new Promise<R>((resolve) => {
      resolvePromise = resolve;
    });
    return { resolvePromise, resultPromise };
  }

  private createModalShell<D>(modalId: string, config: ResolvedModalConfig<D>, rollback: ModalCleanup[]): ModalShell {
    const container = this.getOrCreateContainer(config.containerSelector);
    const containerElement = this.createModalContainer(modalId, config.zIndex);
    rollback.push(() => containerElement.remove());
    const backdropElement = this.createBackdropElement(modalId, config);
    const contentWrapper = this.createContentWrapper();

    if (backdropElement) {
      containerElement.appendChild(backdropElement);
    }
    containerElement.appendChild(contentWrapper);
    container.appendChild(containerElement);
    return { backdropElement, containerElement, contentWrapper };
  }

  private createModalContainer(modalId: string, zIndex: number): HTMLElement {
    const modalContainer = this.document.createElement('div');
    modalContainer.id = modalId;
    modalContainer.className = 'dynamic-modal-container';
    modalContainer.style.cssText = `
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: ${zIndex + this.modalStack().length};
    `;
    return modalContainer;
  }

  private createBackdropElement<D>(modalId: string, config: ResolvedModalConfig<D>): HTMLElement | undefined {
    if (!config.hasBackdrop) {
      return undefined;
    }

    const backdropElement = this.document.createElement('div');
    backdropElement.className = 'dynamic-modal-backdrop';
    backdropElement.style.cssText = `
      position: absolute;
      inset: 0;
      background-color: rgba(0, 0, 0, 0.5);
      transition: opacity 150ms ease-out;
    `;

    if (config.closeOnBackdropClick) {
      backdropElement.addEventListener('click', () => {
        if (this.isTopModal(modalId)) {
          this.closeById(modalId);
        }
      });
    }
    return backdropElement;
  }

  private createContentWrapper(): HTMLElement {
    const contentWrapper = this.document.createElement('div');
    contentWrapper.className = 'dynamic-modal-content';
    contentWrapper.style.cssText = `
      position: relative;
      z-index: 1;
    `;
    contentWrapper.tabIndex = -1;
    return contentWrapper;
  }

  private createModalRefToken<R>(closeModal: (result?: R) => void, resultPromise: Promise<R>): ModalRef<R> {
    return {
      close: closeModal,
      result: resultPromise,
      componentRef: null as unknown as ComponentRef<unknown>
    };
  }

  private createModalComponent<C, D, R>(
    component: Type<C>,
    hostElement: HTMLElement,
    data: D | undefined,
    modalRefToken: ModalRef<R>,
  ): ComponentRef<C> {
    const customInjector = Injector.create({
      providers: [
        { provide: MODAL_DATA, useValue: data },
        { provide: MODAL_REF, useValue: modalRefToken }
      ],
      parent: this.injector
    });

    return createComponent(component, {
      environmentInjector: this.injector,
      elementInjector: customInjector,
      hostElement
    });
  }

  private applyComponentInputs<C>(componentRef: ComponentRef<C>, inputs: Record<string, unknown> | undefined): void {
    if (!inputs) {
      return;
    }

    for (const [key, value] of Object.entries(inputs)) {
      componentRef.setInput(key, value);
    }
  }

  private subscribeComponentOutputs<C, R>(
    componentRef: ComponentRef<C>,
    outputs: ModalConfig['outputs'] | undefined,
    closeModal: (result?: R) => void,
    modalId: string,
    subscriptions: ModalSubscription[],
  ): void {
    this.subscribeConfiguredOutputs(componentRef, outputs, closeModal, modalId, subscriptions);
    this.subscribeDefaultResultOutput(componentRef, outputs, 'close', closeModal, subscriptions);
    this.subscribeDefaultResultOutput(componentRef, outputs, 'confirm', closeModal, subscriptions);
  }

  private subscribeConfiguredOutputs<C, R>(
    componentRef: ComponentRef<C>,
    outputs: ModalConfig['outputs'] | undefined,
    closeModal: (result?: R) => void,
    modalId: string,
    subscriptions: ModalSubscription[],
  ): void {
    if (!outputs) {
      return;
    }

    const instance = componentRef.instance as Record<string, unknown>;
    for (const [eventName, handler] of Object.entries(outputs)) {
      const output = instance[eventName] as SubscribableOutput | undefined;
      if (!output?.subscribe) {
        continue;
      }

      const subscription = eventName === 'close'
        ? output.subscribe((value: unknown) => {
          closeModal(value as R);
          this.runModalCleanupStep(() => this.runModalSettlement(modalId, () => handler(value)));
        })
        : output.subscribe(handler);
      subscriptions.push(subscription);
    }
  }

  private subscribeDefaultResultOutput<C, R>(
    componentRef: ComponentRef<C>,
    outputs: ModalConfig['outputs'] | undefined,
    eventName: 'close' | 'confirm',
    closeModal: (result?: R) => void,
    subscriptions: ModalSubscription[],
  ): void {
    if (outputs?.[eventName]) {
      return;
    }

    const instance = componentRef.instance as Record<string, unknown>;
    const output = instance[eventName] as SubscribableOutput<R> | undefined;
    if (!output?.subscribe) {
      return;
    }

    subscriptions.push(output.subscribe((result: R) => closeModal(result)));
  }

  private registerEscapeListener<R>(
    config: ResolvedModalConfig,
    modalId: string,
    closeModal: (result?: R) => void,
    rollback: ModalCleanup[],
  ): ((e: KeyboardEvent) => void) | undefined {
    if (!config.closeOnEscape) {
      return undefined;
    }

    const escapeListener = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') {
        return;
      }

      if (this.isTopModal(modalId)) {
        closeModal();
      }
    };
    rollback.push(() => this.document.removeEventListener('keydown', escapeListener));
    this.document.addEventListener('keydown', escapeListener);
    return escapeListener;
  }

  private addToStack<R>(
    modalId: string,
    componentRef: ComponentRef<unknown>,
    shell: ModalShell,
    config: ResolvedModalConfig,
    resolvePromise: (result: R) => void,
    escapeListener: ((e: KeyboardEvent) => void) | undefined,
    subscriptions: ModalSubscription[],
    focusTrap: ConfigurableFocusTrap,
    opener: HTMLElement | null,
    rollback: ModalCleanup[],
  ): ModalStackItem {
    const previousTop = this.getTopModal();
    const previousTopEnabled = previousTop?.focusTrap.enabled;
    if (previousTop) {
      rollback.push(() => {
        if (this.isTopModal(previousTop.id)) this.setModalParticipation(previousTop, previousTopEnabled ?? true);
      });
    }
    rollback.push(() => { focusTrap.enabled = false; });
    if (previousTop) {
      this.setModalParticipation(previousTop, false);
    }
    focusTrap.enabled = true;
    const item: ModalStackItem = {
      id: modalId,
      componentRef,
      backdropElement: shell.backdropElement,
      containerElement: shell.containerElement,
      resolve: resolvePromise as (result: unknown) => void,
      config,
      escapeListener,
      subscriptions,
      focusTrap,
      focusRenderRef: null,
      focusGeneration: 0,
      contentWrapper: shell.contentWrapper,
      opener,
    };
    rollback.push(() => {
      this.modalStack.update(stack => stack.filter(entry => entry.id !== modalId));
    });
    this.modalStack.update(stack => [...stack, item]);
    this.stackSettlementGeneration += 1;
    return item;
  }

  private scheduleInitialFocus(item: ModalStackItem): void {
    const generation = ++item.focusGeneration;
    item.focusRenderRef = afterNextRender({
      write: () => {
        if (generation !== item.focusGeneration) return;
        item.focusRenderRef = null;
        this.focusModal(item);
      },
    }, { injector: this.injector });
  }

  private focusModal(item: ModalStackItem): void {
    if (this.isDestroyed || !this.isTopModal(item.id)) return;
    const focused = item.focusTrap.focusInitialElement({ preventScroll: true });
    if (!focused && !this.isDestroyed && this.isTopModal(item.id)) {
      item.contentWrapper.focus({ preventScroll: true });
    }
  }

  private reacquireSurvivingTop(item: ModalStackItem): void {
    item.focusGeneration += 1;
    const focusRenderRef = item.focusRenderRef;
    item.focusRenderRef = null;
    if (focusRenderRef) {
      this.runModalCleanupStep(() => focusRenderRef.destroy());
    }
    this.runModalCleanupStep(() => {
      this.setModalParticipation(item, true);
      this.focusModal(item);
    });
  }

  private setModalParticipation(item: ModalStackItem, active: boolean): void {
    item.focusTrap.enabled = active;
    item.containerElement.inert = !active;
    if (active) item.containerElement.removeAttribute('aria-hidden');
    else item.containerElement.setAttribute('aria-hidden', 'true');
  }

  /**
   * 通过 ID 关闭模态框
   */
  private closeById(modalId: string, result?: unknown, restoreFocus = true): void {
    const stack = this.modalStack();
    const index = stack.findIndex(item => item.id === modalId);

    if (index === -1) return;

    const item = stack[index];
    const ownsFocusSettlement = this.focusSettlementDepth++ === 0;
    try {
      // 先移除所有权，后续任一回调重入时都只能观察到已结算状态。
      this.modalStack.update(s => s.filter(m => m.id !== modalId));
      this.stackSettlementGeneration += 1;
      this.runModalSettlement(modalId, () => {
        this.runModalCleanupStep(() => item.resolve(result));
        this.cleanupModalItem(item);
        if (!ownsFocusSettlement) return;
        const nextTop = this.getTopModal();
        if (nextTop) {
          if (!nextTop.containerElement.inert && nextTop.focusTrap.enabled) return;
          if (restoreFocus && this.closeAllFocusSettlementTokens.length === 0) {
            this.reacquireSurvivingTop(nextTop);
          } else {
            this.runModalCleanupStep(() => this.setModalParticipation(nextTop, true));
          }
          return;
        }
        if (restoreFocus && this.closeAllFocusSettlementTokens.length === 0) {
          this.restoreConnectedFocus(item.opener);
        }
      });
    } finally {
      this.focusSettlementDepth -= 1;
    }
  }

  private cleanupModalItem(item: ModalStackItem): void {
    item.focusGeneration += 1;
    const focusRenderRef = item.focusRenderRef;
    item.focusRenderRef = null;
    if (focusRenderRef) {
      this.runModalCleanupStep(() => focusRenderRef.destroy());
    }
    this.runModalCleanupStep(() => item.focusTrap.destroy());
    for (const sub of item.subscriptions) {
      this.runModalCleanupStep(() => sub.unsubscribe());
    }

    if (item.escapeListener) {
      this.runModalCleanupStep(() => {
        this.document.removeEventListener('keydown', item.escapeListener as EventListener);
      });
    }

    this.runModalCleanupStep(() => {
      this.appRef.detachView(item.componentRef.hostView);
    });
    this.runModalCleanupStep(() => {
      item.componentRef.destroy();
    });
    this.runModalCleanupStep(() => {
      item.containerElement.remove();
    });
  }

  private runModalCleanupStep(cleanup: () => void): void {
    try {
      cleanup();
    } catch {
      // Modal close must keep unwinding remaining DOM, listener and view cleanup.
    }
  }

  private rollbackModalOpen(rollback: ModalCleanup[]): void {
    for (let i = rollback.length - 1; i >= 0; i--) {
      this.runModalCleanupStep(rollback[i]);
    }
  }

  private addSubscriptionRollback(rollback: ModalCleanup[], subscriptions: ModalSubscription[]): void {
    rollback.push(() => {
      for (let i = subscriptions.length - 1; i >= 0; i--) {
        this.runModalCleanupStep(() => subscriptions[i].unsubscribe());
      }
    });
  }

  private runModalSettlement(modalId: string, settlement: () => void): void {
    this.settlementModalIds.push(modalId);
    try {
      settlement();
    } finally {
      this.settlementModalIds.pop();
    }
  }

  /**
   * 关闭栈顶模态框
   */
  close<R = unknown>(result?: R): void {
    if (this.isDestroyed) return;
    const settlingModalId = this.settlementModalIds[this.settlementModalIds.length - 1];
    if (settlingModalId) {
      this.closeById(settlingModalId, result);
      return;
    }
    const stack = this.modalStack();
    if (stack.length === 0) return;

    const topModal = stack[stack.length - 1];
    this.closeById(topModal.id, result);
  }

  /**
   * 关闭所有模态框
   */
  closeAll(): void {
    if (this.isDestroyed) return;
    this.closeAllItems(true);
  }

  private closeAllItems(restoreFocus: boolean): void {
    const token = Symbol('close-all-focus-settlement');
    const ownsFocusSettlement = this.closeAllFocusSettlementTokens.length === 0;
    this.closeAllFocusSettlementTokens.push(token);
    try {
      const stack = this.modalStack();
      const outerOpener = stack[0]?.opener ?? null;
      const expectedSettlementGeneration = this.stackSettlementGeneration + stack.length;
      for (let i = stack.length - 1; i >= 0; i--) {
        this.closeById(stack[i].id, undefined, false);
      }
      if (
        ownsFocusSettlement
        && restoreFocus
        && this.modalStack().length === 0
        && this.stackSettlementGeneration === expectedSettlementGeneration
      ) {
        this.restoreConnectedFocus(outerOpener);
      }
    } finally {
      this.closeAllFocusSettlementTokens.pop();
    }
  }

  private captureConnectedOpener(): HTMLElement | null {
    const activeElement = this.document.activeElement;
    return activeElement instanceof HTMLElement && activeElement.isConnected ? activeElement : null;
  }

  private restoreConnectedFocus(target: HTMLElement | null): void {
    if (!target?.isConnected) return;
    this.runModalCleanupStep(() => target.focus({ preventScroll: true }));
  }

  private getTopModal(): ModalStackItem | null {
    const stack = this.modalStack();
    return stack[stack.length - 1] ?? null;
  }

  private isTopModal(modalId: string): boolean {
    return this.getTopModal()?.id === modalId;
  }

  /**
   * 获取或创建容器元素
   */
  private getOrCreateContainer(selector?: string): HTMLElement {
    if (selector) {
      const container = this.document.querySelector<HTMLElement>(selector);
      if (container) return container;
    }
    return this.document.body;
  }
}

/**
 * 注入令牌：模态框数据
 * 组件使用 inject(MODAL_DATA) 获取传入的数据
 */
export const MODAL_DATA = new InjectionToken<unknown>('MODAL_DATA');

/**
 * 注入令牌：模态框引用
 * 组件使用 inject(MODAL_REF) 获取关闭模态框的能力
 */
export const MODAL_REF = new InjectionToken<{ close: (result?: unknown) => void }>('MODAL_REF');
