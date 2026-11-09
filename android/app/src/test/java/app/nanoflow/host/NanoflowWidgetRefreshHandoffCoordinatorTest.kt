package app.nanoflow.host

import android.content.Context
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.Operation
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import java.util.UUID
import java.util.concurrent.CancellationException
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NanoflowWidgetRefreshHandoffCoordinatorTest {
  private val context: Context = ApplicationProvider.getApplicationContext()
  private var workManagerInitialized = false

  @After
  fun closeWorkManager() {
    if (workManagerInitialized) WorkManagerTestInitHelper.closeWorkDatabase()
  }

  @Test
  fun `operation completion wins once and suppresses a late watchdog`() {
    val harness = Harness()

    harness.submit()
    harness.operation.succeed()
    harness.deliverOperation()
    harness.fireWatchdog()

    assertEquals(listOf("confirmed"), harness.reports)
    assertEquals(1, harness.finishes.get())
    assertEquals(1, harness.watchdogCancels.get())
  }

  @Test
  fun `watchdog wins once and suppresses late operation result and telemetry`() {
    val harness = Harness()

    harness.submit()
    harness.fireWatchdog()
    harness.operation.succeed()
    harness.deliverOperation()

    assertEquals(listOf("unconfirmed-watchdog-timeout"), harness.reports)
    assertEquals(1, harness.finishes.get())
    assertEquals(0, harness.watchdogCancels.get())
  }

  @Test
  fun `operation failure and cancellation are unconfirmed without cancelling work`() {
    listOf(
      IllegalStateException("enqueue transaction failed"),
      CancellationException("operation future cancelled"),
    ).forEach { failure ->
      val harness = Harness()
      harness.submit()
      harness.operation.fail(failure)

      harness.deliverOperation()

      assertEquals(listOf("unconfirmed-operation-result-failed"), harness.reports)
      assertEquals(1, harness.finishes.get())
      assertFalse(harness.operation.cancelInvoked)
    }
  }

  @Test
  fun `submit watchdog and observer failures each fail closed`() {
    val submit = Harness(submitFailure = IllegalStateException("submit"))
    submit.submit()
    assertEquals(listOf("unconfirmed-submit-failed"), submit.reports)
    assertEquals(1, submit.finishes.get())

    val watchdog = Harness(watchdogScheduleFailure = IllegalStateException("watchdog"))
    watchdog.submit()
    assertEquals(listOf("unconfirmed-watchdog-schedule-failed"), watchdog.reports)
    assertEquals(1, watchdog.finishes.get())

    val observer = Harness(observerFailure = IllegalStateException("observer"))
    observer.submit()
    assertEquals(listOf("unconfirmed-operation-observer-failed"), observer.reports)
    assertEquals(1, observer.finishes.get())
    assertEquals(1, observer.watchdogCancels.get())
  }

  @Test
  fun `telemetry watchdog cancel and finish failures stay contained`() {
    val harness = Harness(
      confirmedReporterFailure = IllegalStateException("telemetry"),
      watchdogCancelFailure = IllegalStateException("cancel"),
      finishFailure = IllegalStateException("finish"),
    )

    val result = runCatching {
      harness.submit()
      harness.operation.succeed()
      harness.deliverOperation()
      harness.fireWatchdog()
    }

    assertTrue(result.isSuccess)
    assertEquals(listOf("confirmed"), harness.reports)
    assertEquals(1, harness.finishes.get())
    assertEquals(1, harness.watchdogCancels.get())
  }

  @Test
  fun `real WorkManager operation confirms the unique work transaction`() {
    val workerExecutor = HoldingExecutor()
    val configuration = Configuration.Builder()
      .setExecutor(workerExecutor)
      .setTaskExecutor(SynchronousExecutor())
      .build()
    WorkManagerTestInitHelper.initializeTestWorkManager(context, configuration)
    workManagerInitialized = true

    val tracked = NanoflowWidgetRefreshWorker.enqueueTracked(context, "handoff-contract")

    tracked.operation.result.get(5, TimeUnit.SECONDS)
    val info = assertNotNull(
      WorkManager.getInstance(context).getWorkInfoById(tracked.requestId).get(5, TimeUnit.SECONDS),
    )
    assertTrue(info.state == WorkInfo.State.ENQUEUED || info.state == WorkInfo.State.RUNNING)
    assertTrue(workerExecutor.commands.isNotEmpty())
  }

  private class Harness(
    private val submitFailure: Throwable? = null,
    private val watchdogScheduleFailure: Throwable? = null,
    private val observerFailure: Throwable? = null,
    private val confirmedReporterFailure: Throwable? = null,
    private val watchdogCancelFailure: Throwable? = null,
    private val finishFailure: Throwable? = null,
  ) {
    val operation = TestOperation()
    val reports = mutableListOf<String>()
    val finishes = AtomicInteger()
    val watchdogCancels = AtomicInteger()
    private var watchdog: (() -> Unit)? = null
    private var operationListener: (() -> Unit)? = null
    private val requestId = UUID.randomUUID()
    private val coordinator = NanoflowWidgetRefreshHandoffCoordinator(
      scheduleWatchdog = { delayMs, callback ->
        assertEquals(8_000L, delayMs)
        watchdogScheduleFailure?.let { throw it }
        watchdog = callback
        {
          watchdogCancels.incrementAndGet()
          watchdogCancelFailure?.let { throw it }
        }
      },
      observeOperation = { _, callback ->
        observerFailure?.let { throw it }
        operationListener = callback
      },
      reportConfirmed = {
        reports += "confirmed"
        confirmedReporterFailure?.let { throw it }
      },
      reportUnconfirmed = { _, reason, _ -> reports += "unconfirmed-$reason" },
    )

    fun submit() {
      coordinator.submit(
        enqueue = {
          submitFailure?.let { throw it }
          NanoflowWidgetRefreshTrackedEnqueue(requestId, operation)
        },
        finish = {
          finishes.incrementAndGet()
          finishFailure?.let { throw it }
        },
      )
    }

    fun deliverOperation() = checkNotNull(operationListener).invoke()
    fun fireWatchdog() = checkNotNull(watchdog).invoke()
  }

  private class TestOperation : Operation {
    private val future = TrackingListenableFuture<Operation.State.SUCCESS>()
    private val liveState = MutableLiveData<Operation.State>(Operation.IN_PROGRESS)
    val cancelInvoked: Boolean get() = future.cancelCalls > 0

    override fun getResult(): ListenableFuture<Operation.State.SUCCESS> = future
    override fun getState(): LiveData<Operation.State> = liveState

    fun succeed() {
      future.set(Operation.SUCCESS)
    }

    fun fail(error: Throwable) {
      if (error is CancellationException) {
        future.cancelExternally()
      } else {
        future.setException(error)
      }
    }
  }

  private class TrackingListenableFuture<T> : ListenableFuture<T> {
    private val delegate = SettableFuture.create<T>()
    var cancelCalls = 0
      private set

    override fun addListener(listener: Runnable, executor: Executor) {
      delegate.addListener(listener, executor)
    }

    override fun cancel(mayInterruptIfRunning: Boolean): Boolean {
      cancelCalls += 1
      return delegate.cancel(mayInterruptIfRunning)
    }

    override fun isCancelled(): Boolean = delegate.isCancelled
    override fun isDone(): Boolean = delegate.isDone
    override fun get(): T = delegate.get()
    override fun get(timeout: Long, unit: TimeUnit): T = delegate.get(timeout, unit)
    fun set(value: T) = delegate.set(value)
    fun setException(error: Throwable) = delegate.setException(error)
    fun cancelExternally() = delegate.cancel(false)
  }

  private class HoldingExecutor : Executor {
    val commands = mutableListOf<Runnable>()
    override fun execute(command: Runnable) {
      commands += command
    }
  }
}
