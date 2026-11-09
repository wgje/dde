package app.nanoflow.host

internal suspend fun NanoflowWidgetStore.readOptimisticSummary(
  appWidgetId: Int,
  expectedOwnerDeviceId: String? = null,
  expectedBindingGeneration: Int? = null,
): WidgetOptimisticSummaryResult {
  val start = beginAuthoritativeRefresh(appWidgetId)
  if (expectedOwnerDeviceId != null &&
    (start.binding?.deviceId != expectedOwnerDeviceId || start.binding.bindingGeneration != expectedBindingGeneration)) {
    return WidgetOptimisticResult.RejectedStale
  }
  if (start.binding == null || start.ticket.owner == null) return WidgetOptimisticResult.RejectedStale
  val summary = start.summary ?: return WidgetOptimisticResult.CurrentNoSnapshot
  return WidgetOptimisticResult.Committed(NanoflowWidgetOptimisticSummarySnapshot(summary, start.ticket))
}
