package app.nanoflow.host

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.CoroutineContext

internal class NanoflowTwaLaunchCoordinator<T>(
  private val scope: CoroutineScope,
  private val preparationContext: CoroutineContext = Dispatchers.IO,
) {
  private var generation = 0L
  private var activeJob: Job? = null

  fun start(
    prepare: suspend () -> T,
    onCommit: (T) -> Unit,
    onError: (Throwable) -> Unit,
  ): Job {
    retireGeneration()
    val launchGeneration = generation
    val job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
      val prepared = try {
        withContext(preparationContext) { prepare() }
      } catch (error: CancellationException) {
        throw error
      } catch (error: Throwable) {
        if (isCurrent(launchGeneration)) {
          onError(error)
        }
        return@launch
      }

      if (isCurrent(launchGeneration)) {
        onCommit(prepared)
      }
    }
    activeJob = job
    return job
  }

  fun retireGeneration() {
    generation += 1
    activeJob?.cancel()
    activeJob = null
  }

  fun cancel() {
    retireGeneration()
  }

  private fun isCurrent(candidate: Long): Boolean {
    return candidate == generation && scope.isActive
  }
}
