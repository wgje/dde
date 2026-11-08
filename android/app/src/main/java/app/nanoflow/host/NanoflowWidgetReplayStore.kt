package app.nanoflow.host

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.util.UUID

private val durableReplayEventsKey = stringPreferencesKey("replay.durableEvents")

internal object NanoflowWidgetReplayRuntime {
  val id: String = UUID.randomUUID().toString()
}

internal data class NanoflowWidgetGateNavigationCommit(
  val pageIndex: Int,
  val selectedEntryId: String?,
)

internal class NanoflowWidgetReplayStore(
  private val context: Context,
) {
  private val mutex = Mutex()
  private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

  suspend fun read(): List<NanoflowWidgetReplayEvent> = mutex.withLock {
    readLocked(context.widgetDataStore.data.first())
  }

  suspend fun persist(event: NanoflowWidgetReplayEvent) = mutex.withLock {
    var rejected = false
    context.widgetDataStore.edit { prefs ->
      val current = readLocked(prefs)
      if (current.any { it.eventId == event.eventId }) return@edit
      if (isReplayable(event.status) && current.count { isReplayable(it.status) } >= MAX_PENDING_EVENTS) {
        rejected = true
        return@edit
      }
      write(prefs, retainEvents(current + event))
    }
    check(!rejected) { "Widget replay queue is full; unresolved events were preserved" }
  }

  suspend fun claim(event: NanoflowWidgetReplayEvent, runtimeId: String): NanoflowWidgetReplayEvent? = mutex.withLock {
    var claimed: NanoflowWidgetReplayEvent? = null
    context.widgetDataStore.edit { prefs ->
      val current = readLocked(prefs)
      val index = current.indexOfFirst { it.eventId == event.eventId }
      if (index < 0 || !sameIdentity(current[index], event)) return@edit
      val existing = current[index]
      if (existing.status != "pending" && existing.status != "failed") return@edit
      val updated = existing.copy(
        status = "processing",
        attemptCount = existing.attemptCount + 1,
        processingRuntimeId = runtimeId,
        updatedAtMs = System.currentTimeMillis(),
      )
      claimed = updated
      write(prefs, current.mapIndexed { position, value -> if (position == index) updated else value })
    }
    claimed
  }

  suspend fun update(
    eventId: String,
    status: String,
    error: String? = null,
    runtimeId: String,
  ): NanoflowWidgetReplayEvent? = mutex.withLock {
    var updated: NanoflowWidgetReplayEvent? = null
    context.widgetDataStore.edit { prefs ->
      val current = readLocked(prefs)
      val index = current.indexOfFirst { it.eventId == eventId }
      if (index < 0) return@edit
      val existing = current[index]
      if (existing.status != "processing" || existing.processingRuntimeId != runtimeId) return@edit
      val next = existing.copy(
        status = status,
        processingRuntimeId = if (status == "processing") runtimeId else null,
        updatedAtMs = System.currentTimeMillis(),
        lastError = error,
      )
      updated = next
      write(prefs, retainEvents(current.mapIndexed { position, value -> if (position == index) next else value }))
    }
    updated
  }

  suspend fun takeover(
    ownerDeviceId: String,
    bindingGeneration: Int,
    runtimeId: String,
  ): List<NanoflowWidgetReplayEvent> = mutex.withLock {
    var takenOver = emptyList<NanoflowWidgetReplayEvent>()
    context.widgetDataStore.edit { prefs ->
      val current = readLocked(prefs)
      val now = System.currentTimeMillis()
      val eligible = current.filter {
        it.ownerDeviceId == ownerDeviceId && it.bindingGeneration == bindingGeneration &&
          (it.kind == "gate-navigation" || it.kind == "gate-action") &&
          (it.status == "pending" || it.status == "failed" ||
            (it.status == "processing" && it.processingRuntimeId != runtimeId))
      }
      if (eligible.isEmpty()) return@edit
      val ids = eligible.mapTo(HashSet()) { it.eventId }
      takenOver = eligible.map { it.copy(status = "pending", processingRuntimeId = null, updatedAtMs = now) }
      write(prefs, current.map { if (it.eventId in ids) it.copy(status = "pending", processingRuntimeId = null, updatedAtMs = now) else it })
    }
    takenOver
  }

  suspend fun applyGateNavigation(
    event: NanoflowWidgetReplayEvent,
    entryIds: List<String>,
    runtimeId: String,
  ): NanoflowWidgetGateNavigationCommit? = mutex.withLock {
    var committed: NanoflowWidgetGateNavigationCommit? = null
    context.widgetDataStore.edit { prefs ->
      val current = readLocked(prefs)
      val index = current.indexOfFirst { it.eventId == event.eventId }
      if (index < 0) return@edit
      val existing = current[index]
      if (!sameIdentity(existing, event) || existing.kind != "gate-navigation" ||
        existing.status != "processing" || existing.processingRuntimeId != runtimeId) return@edit

      val pageIndexKey = gatePageIndexKey(event.appWidgetId)
      val selectedEntryKey = gateSelectedEntryIdKey(event.appWidgetId)
      val selectedEntryId = if (entryIds.isEmpty()) null else {
        prefs[selectedEntryKey]?.takeIf { it in entryIds }
          ?: entryIds.getOrNull((prefs[pageIndexKey] ?: 0).coerceAtLeast(0).coerceIn(entryIds.indices))
      }
      val normalizedIndex = selectedEntryId?.let(entryIds::indexOf)?.takeIf { it >= 0 } ?: 0
      val nextIndex = if (entryIds.size <= 1) 0 else (normalizedIndex + event.delta).coerceIn(0, entryIds.lastIndex)
      val nextEntryId = entryIds.getOrNull(nextIndex)
      val nextEvent = existing.copy(
        status = "finished",
        processingRuntimeId = null,
        updatedAtMs = System.currentTimeMillis(),
        lastError = null,
      )
      prefs[pageIndexKey] = nextIndex
      if (nextEntryId == null) prefs.remove(selectedEntryKey) else prefs[selectedEntryKey] = nextEntryId
      write(prefs, current.mapIndexed { position, value -> if (position == index) nextEvent else value })
      committed = NanoflowWidgetGateNavigationCommit(nextIndex, nextEntryId)
    }
    committed
  }

  private fun sameIdentity(left: NanoflowWidgetReplayEvent, right: NanoflowWidgetReplayEvent): Boolean =
    left.operationId == right.operationId && left.kind == right.kind && left.appWidgetId == right.appWidgetId &&
      left.delta == right.delta && left.gateAction == right.gateAction && left.entryId == right.entryId &&
      left.ownerDeviceId == right.ownerDeviceId && left.bindingGeneration == right.bindingGeneration

  private fun isReplayable(status: String): Boolean = status == "pending" || status == "processing" || status == "failed"

  private fun retainEvents(events: List<NanoflowWidgetReplayEvent>): List<NanoflowWidgetReplayEvent> {
    val terminalHistoryIds = events.filterNot { isReplayable(it.status) }
      .takeLast(MAX_TERMINAL_HISTORY)
      .mapTo(HashSet()) { it.eventId }
    return events.filter { isReplayable(it.status) || it.eventId in terminalHistoryIds }
  }

  private fun readLocked(snapshot: Preferences): List<NanoflowWidgetReplayEvent> =
    snapshot[durableReplayEventsKey]?.let { raw ->
      runCatching { json.decodeFromString(ListSerializer(NanoflowWidgetReplayEvent.serializer()), raw) }
        .getOrElse { throw IllegalStateException("Widget durable replay journal cannot be decoded", it) }
    } ?: emptyList()

  private fun write(prefs: androidx.datastore.preferences.core.MutablePreferences, events: List<NanoflowWidgetReplayEvent>) {
    prefs[durableReplayEventsKey] = json.encodeToString(ListSerializer(NanoflowWidgetReplayEvent.serializer()), events)
  }

  private companion object {
    const val MAX_PENDING_EVENTS = 64
    const val MAX_TERMINAL_HISTORY = 64
  }
}

internal suspend fun NanoflowWidgetStore.readDurableReplayEvents(): List<NanoflowWidgetReplayEvent> =
  NanoflowWidgetReplayStore(context).read()

internal suspend fun NanoflowWidgetStore.persistDurableReplayEvent(event: NanoflowWidgetReplayEvent) {
  val persisted = withReplayOwner(event.ownerDeviceId, event.bindingGeneration) {
    NanoflowWidgetReplayStore(context).persist(event)
  }
  check(persisted != null) { "Widget replay owner changed before event persistence" }
}

internal suspend fun NanoflowWidgetStore.updateDurableReplayEvent(
  eventId: String,
  status: String,
  error: String? = null,
): NanoflowWidgetReplayEvent? = NanoflowWidgetReplayStore(context)
  .update(eventId, status, error, NanoflowWidgetReplayRuntime.id)

internal suspend fun NanoflowWidgetStore.takeoverDurableReplayEvents(
  ownerDeviceId: String,
  bindingGeneration: Int,
): List<NanoflowWidgetReplayEvent> = withReplayOwner(ownerDeviceId, bindingGeneration) {
  NanoflowWidgetReplayStore(context).takeover(ownerDeviceId, bindingGeneration, NanoflowWidgetReplayRuntime.id)
} ?: emptyList()

internal suspend fun NanoflowWidgetStore.claimDurableReplayEvent(
  event: NanoflowWidgetReplayEvent,
): NanoflowWidgetReplayEvent? = withReplayOwner(event.ownerDeviceId, event.bindingGeneration) {
  NanoflowWidgetReplayStore(context).claim(event, NanoflowWidgetReplayRuntime.id)
}

internal suspend fun NanoflowWidgetStore.commitDurableGateNavigation(
  event: NanoflowWidgetReplayEvent,
  entryIds: List<String>,
): NanoflowWidgetGateNavigationCommit? = withReplayOwner(event.ownerDeviceId, event.bindingGeneration) {
  NanoflowWidgetReplayStore(context).applyGateNavigation(event, entryIds, NanoflowWidgetReplayRuntime.id)
}

internal suspend fun NanoflowWidgetStore.persistGatePageIndex(appWidgetId: Int, pageIndex: Int) =
  context.widgetDataStore.edit { it[gatePageIndexKey(appWidgetId)] = pageIndex.coerceAtLeast(0) }

internal suspend fun NanoflowWidgetStore.readGatePageIndex(appWidgetId: Int): Int =
  context.widgetDataStore.data.first()[gatePageIndexKey(appWidgetId)] ?: 0

internal suspend fun NanoflowWidgetStore.persistGateSelectedEntryId(appWidgetId: Int, entryId: String?) {
  context.widgetDataStore.edit { prefs ->
    val key = gateSelectedEntryIdKey(appWidgetId)
    if (entryId.isNullOrBlank()) prefs.remove(key) else prefs[key] = entryId
  }
}

internal suspend fun NanoflowWidgetStore.readGateSelectedEntryId(appWidgetId: Int): String? =
  context.widgetDataStore.data.first()[gateSelectedEntryIdKey(appWidgetId)]
