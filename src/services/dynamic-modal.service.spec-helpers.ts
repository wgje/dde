import {
  ComponentFactoryResolver,
  inject,
  type ComponentRef,
  type EnvironmentInjector,
  type Injector,
  type Type,
} from '@angular/core';
import type { DynamicModalComponentFactory } from './dynamic-modal.service';

export function createTestBedDynamicModalComponentFactory(): DynamicModalComponentFactory {
  const resolver = inject(ComponentFactoryResolver);
  return {
    create<C>(
      component: Type<C>,
      options: {
        elementInjector: Injector;
        environmentInjector: EnvironmentInjector;
        hostElement: HTMLElement;
      },
    ): ComponentRef<C> {
      return resolver.resolveComponentFactory(component).create(
        options.elementInjector,
        [],
        options.hostElement,
        options.environmentInjector,
      );
    },
  };
}
