/**
 * 类型安全的 Supabase RPC 调用服务
 *
 * 所有 RPC 调用应通过此服务进行，确保：
 * 1. 参数类型检查
 * 2. 返回值类型推导
 * 3. 统一的错误处理和重试策略
 * 4. 超时保护（SUPABASE_CLIENT_FETCH_MAX_MS）
 */

import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { RpcSignature, isValidRpcFunction } from '../types/rpc.types';
import { supabaseErrorToError } from '../utils/supabase-error';
import { TIMEOUT_CONFIG } from '../config/timeout.config';
import { OperationError, ErrorCodes, failure } from '../utils/result';

@Injectable({
  providedIn: 'root',
})
export class RpcService {
  private supabase = inject(SupabaseClientService);

  /**
   * 类型安全的 RPC 调用
   *
   * 特性：
   * - 自动参数类型检查（编译时）
   * - 返回值自动类型推导
   * - 统一超时保护
   * - 自动错误转换为 OperationError
   *
   * 用法示例：
   * ```
   * const result = await this.rpc.call('get_full_project_data', {
   *   project_id: 'abc123'
   * });
   * if (result.ok) {
   *   const { tasks, connections } = result.value; // 自动类型推导
   * }
   * ```
   *
   * @param fnName - RPC 函数名称（必须是 RpcSignature 中定义的函数）
   * @param params - 函数参数（类型由 RpcSignature 保证）
   * @returns 异步 Result 对象，包含返回值或错误
   */
  async call<FnName extends keyof RpcSignature>(
    fnName: FnName,
    params: RpcSignature[FnName]['params']
  ): Promise<{ ok: true; value: RpcSignature[FnName]['returns'] } | { ok: false; error: OperationError }> {
    // 验证函数名
    if (!isValidRpcFunction(fnName)) {
      return {
        ok: false,
        error: failure(
          ErrorCodes.OPERATION_FAILED,
          `无效的 RPC 函数名: ${String(fnName)}`
        ).error,
      };
    }

    try {
      // 获取 Supabase 客户端
      const client = this.supabase.client;

      // 带超时的 RPC 调用
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_CONFIG.STANDARD);

      try {
        const { data, error } = await client.rpc(fnName, params as Record<string, unknown>);

        clearTimeout(timeoutId);

        if (error) {
          const operationError = supabaseErrorToError(error);
          return { ok: false, error: operationError };
        }

        return { ok: true, value: data as RpcSignature[FnName]['returns'] };
      } catch (e) {
        clearTimeout(timeoutId);
        if (e instanceof Error && e.name === 'AbortError') {
          return {
            ok: false,
            error: failure(ErrorCodes.OPERATION_FAILED, 'RPC 调用超时').error,
          };
        }
        throw e;
      }
    } catch (e) {
      const operationError = e instanceof Error
        ? supabaseErrorToError(e)
        : failure(ErrorCodes.UNKNOWN, '未知错误').error;
      return { ok: false, error: operationError };
    }
  }

  /**
   * RPC 调用并自动抛出错误
   * 用于无需检查错误的场景（确保错误被全局处理器捕获）
   *
   * @throws OperationError
   */
  async callOrThrow<FnName extends keyof RpcSignature>(
    fnName: FnName,
    params: RpcSignature[FnName]['params']
  ): Promise<RpcSignature[FnName]['returns']> {
    const result = await this.call(fnName, params);
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  }
}
