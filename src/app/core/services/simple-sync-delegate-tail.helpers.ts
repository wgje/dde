import type { TaskDeleteBaseUpdatedAtMap } from './sync';

export type OptionalTail<T> = [] | [value: T];

export function optionalTail<T>(value: T | undefined): OptionalTail<T> {
  return value === undefined ? [] : [value];
}

export type TaskDeleteOperationTail = [
  taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
  operationId?: string,
];

export function taskDeleteOperationTail(
  taskDeleteBaseUpdatedAtMap: TaskDeleteBaseUpdatedAtMap | undefined,
  operationId: string | undefined,
): TaskDeleteOperationTail {
  if (taskDeleteBaseUpdatedAtMap !== undefined) {
    return operationId === undefined
      ? [taskDeleteBaseUpdatedAtMap]
      : [taskDeleteBaseUpdatedAtMap, operationId];
  }

  return operationId === undefined ? [] : [undefined, operationId];
}
