package app.nanoflow.host.acceptance

import android.app.KeyguardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class NanoflowTwaEditableStartupTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val arguments: Bundle = InstrumentationRegistry.getArguments()
  private val testContext: Context = instrumentation.context
  private val device: UiDevice = UiDevice.getInstance(instrumentation)

  @Test
  fun coldAndWarmLauncherReachOfflineEditableTextView() {
    val targetPackage = resolveTargetPackage()
    val instrumentationPackage = testContext.packageName
    assertNotEquals(
      "Self-instrumenting package must remain distinct from the NanoFlow target",
      instrumentationPackage,
      targetPackage,
    )
    assertEquals(
      "Runner target package drifted from the app build fallback",
      BuildConfig.NANOFLOW_TARGET_PACKAGE,
      targetPackage,
    )

    val expectedSerial = requiredArgument(ARG_EXPECTED_SERIAL)
    val expectedProjectLabel = requiredArgument(ARG_EXPECTED_PROJECT_LABEL)
    val environment = preflightEnvironment(targetPackage, expectedSerial)

    // Prove the device already owns a durable offline TWA/project cache before timing cold launch.
    val preflightWindow = TelemetryWindow.open(device)
    launchFromHome(environment)
    waitForEditableProject(environment, expectedProjectLabel)
    assertTrustedLaunch(preflightWindow, expectedCount = 1)

    forceStop(environment.targetPackage)
    forceStop(CHROME_PACKAGE)
    device.pressHome()
    waitForCurrentPackage(environment.homePackage)

    val coldWindow = TelemetryWindow.open(device)
    val coldStart = SystemClock.elapsedRealtime()
    clickUniqueLauncherIcon(environment)
    waitForEditableProject(environment, expectedProjectLabel)
    val coldElapsedMs = SystemClock.elapsedRealtime() - coldStart
    assertTrustedLaunch(coldWindow, expectedCount = 1)
    reportElapsed("cold", coldElapsedMs)

    val warmWindow = TelemetryWindow.open(device)
    device.pressHome()
    waitForCurrentPackage(environment.homePackage)
    val warmStart = SystemClock.elapsedRealtime()
    clickUniqueLauncherIcon(environment)
    waitForEditableProject(environment, expectedProjectLabel)
    val warmElapsedMs = SystemClock.elapsedRealtime() - warmStart
    assertNoLaunchStarted(warmWindow)
    reportElapsed("warm", warmElapsedMs)
  }

  private fun preflightEnvironment(
    targetPackage: String,
    expectedSerial: String,
  ): DeviceEnvironment {
    requireSafePackageName(targetPackage)
    assertTrue("Physical device API must be 28+", Build.VERSION.SDK_INT >= 28)
    assertPhysicalDevice()
    device.wakeUp()
    val keyguard = testContext.getSystemService(KeyguardManager::class.java)
    assertFalse("Device must be unlocked before acceptance", keyguard.isDeviceLocked)
    assertFalse("Keyguard must not cover the launcher", keyguard.isKeyguardLocked)

    val actualSerial = readDeviceSerial()
    assertEquals("ANDROID_SERIAL must select this exact device", expectedSerial, actualSerial)
    assertOffline()

    val packageManager = testContext.packageManager
    val targetInfo = packageManager.getApplicationInfo(targetPackage, 0)
    val chromeInfo = packageManager.getApplicationInfo(CHROME_PACKAGE, 0)
    assertTrue("NanoFlow target package must be enabled", targetInfo.enabled)
    assertTrue("Chrome must be installed and enabled", chromeInfo.enabled)

    val homeIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
    val homePackage = packageManager.resolveActivity(homeIntent, PackageManager.MATCH_DEFAULT_ONLY)
      ?.activityInfo
      ?.packageName
      ?.takeIf { it.isNotBlank() }
      ?: failValue("Unable to resolve the active HOME package")
    assertNotEquals("HOME cannot be the NanoFlow target", targetPackage, homePackage)
    assertNotEquals("HOME cannot be Chrome", CHROME_PACKAGE, homePackage)

    val launchIntent = packageManager.getLaunchIntentForPackage(targetPackage)
      ?: failValue("NanoFlow target has no launcher activity")
    val launcherComponent = launchIntent.component
      ?: failValue("NanoFlow launcher intent has no explicit component")
    assertLocalDalDeclaration(packageManager, targetPackage, launcherComponent)

    val appLabel = packageManager.getApplicationLabel(targetInfo).toString().trim()
    assertTrue("NanoFlow launcher label must not be blank", appLabel.isNotBlank())

    device.pressHome()
    waitForCurrentPackage(homePackage)
    findUniqueClickableLabel(homePackage, appLabel)

    return DeviceEnvironment(
      targetPackage = targetPackage,
      homePackage = homePackage,
      appLabel = appLabel,
    )
  }

  private fun assertPhysicalDevice() {
    val qemu = shell("getprop ro.kernel.qemu").trim()
    val fingerprint = Build.FINGERPRINT.lowercase()
    val hardware = Build.HARDWARE.lowercase()
    val product = Build.PRODUCT.lowercase()
    assertFalse(
      "Acceptance requires a physical device, not an emulator",
      qemu == "1"
        || fingerprint.startsWith("generic")
        || fingerprint.contains("emulator")
        || hardware.contains("goldfish")
        || hardware.contains("ranchu")
        || product.startsWith("sdk"),
    )
  }

  private fun readDeviceSerial(): String {
    val primary = shell("getprop ro.serialno").trim()
    if (primary.isNotBlank() && primary != "unknown") return primary
    return shell("getprop ro.boot.serialno").trim().takeIf { it.isNotBlank() }
      ?: failValue("Unable to read physical device serial through the shell")
  }

  private fun assertOffline() {
    val connectivity = testContext.getSystemService(ConnectivityManager::class.java)
    val active = connectivity.activeNetwork
    val capabilities = active?.let(connectivity::getNetworkCapabilities)
    assertFalse(
      "Acceptance must run without a validated network",
      capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true,
    )
  }

  @Suppress("DEPRECATION")
  private fun assertLocalDalDeclaration(
    packageManager: PackageManager,
    targetPackage: String,
    launcherComponent: ComponentName,
  ) {
    val launcherInfo = packageManager.getActivityInfo(launcherComponent, PackageManager.GET_META_DATA)
    val metadata = launcherInfo.metaData ?: failValue("Launcher activity metadata is missing")
    val statementsResource = metadata.getInt(ASSET_STATEMENTS_METADATA, 0)
    assertTrue("Launcher must declare local Digital Asset Links statements", statementsResource != 0)
    val targetAppContext = testContext.createPackageContext(targetPackage, 0)
    val statements = targetAppContext.resources.getString(statementsResource)
    assertTrue(
      "Local DAL must authorize web URL handling",
      statements.contains("delegate_permission/common.handle_all_urls"),
    )
    assertTrue("Local DAL must target a web namespace", statements.contains("\"namespace\":\"web\""))
  }

  private fun launchFromHome(environment: DeviceEnvironment) {
    device.pressHome()
    waitForCurrentPackage(environment.homePackage)
    clickUniqueLauncherIcon(environment)
  }

  private fun clickUniqueLauncherIcon(environment: DeviceEnvironment) {
    findUniqueClickableLabel(environment.homePackage, environment.appLabel).click()
  }

  private fun waitForEditableProject(
    environment: DeviceEnvironment,
    expectedProjectLabel: String,
  ) {
    waitForCurrentPackage(CHROME_PACKAGE)
    val projectMatches = waitForObjects(
      selectors = listOf(
        By.pkg(CHROME_PACKAGE).text(expectedProjectLabel),
        By.pkg(CHROME_PACKAGE).desc(expectedProjectLabel),
      ),
      description = "durable local project label '$expectedProjectLabel'",
    )
    assertTrue("Expected local project label is not visible", projectMatches.isNotEmpty())
    findUniqueClickableText(CHROME_PACKAGE, EDITABLE_ANCHOR_TEXT)
    assertNoVisibleBrowserChrome()
    assertEquals("Editable anchor must be hosted by Chrome/TWA", CHROME_PACKAGE, device.currentPackageName)
  }

  private fun findUniqueClickableLabel(packageName: String, label: String): UiObject2 {
    val matches = waitForObjects(
      selectors = listOf(By.pkg(packageName).text(label), By.pkg(packageName).desc(label)),
      description = "launcher icon '$label' in $packageName",
    )
    return uniqueClickableAncestor(matches, "launcher icon '$label'")
  }

  private fun findUniqueClickableText(packageName: String, text: String): UiObject2 {
    val matches = waitForObjects(
      selectors = listOf(By.pkg(packageName).text(text), By.pkg(packageName).desc(text)),
      description = "editable anchor '$text' in $packageName",
    )
    return uniqueClickableAncestor(matches, "editable anchor '$text'")
  }

  private fun waitForObjects(
    selectors: List<androidx.test.uiautomator.BySelector>,
    description: String,
  ): List<UiObject2> {
    val deadline = SystemClock.elapsedRealtime() + UI_HANG_TIMEOUT_MS
    while (SystemClock.elapsedRealtime() < deadline) {
      val matches = selectors.flatMap(device::findObjects)
        .filter { node -> node.visibleBounds.width() > 0 && node.visibleBounds.height() > 0 }
        .distinctBy(::nodeIdentity)
      if (matches.isNotEmpty()) return matches
      SystemClock.sleep(UI_POLL_INTERVAL_MS)
    }
    fail("Timed out waiting for $description; timeout is a hang boundary, not a performance budget")
    return emptyList()
  }

  private fun uniqueClickableAncestor(nodes: List<UiObject2>, description: String): UiObject2 {
    val clickable = nodes.mapNotNull(::clickableAncestor)
      .filter { node -> node.isEnabled && node.visibleBounds.width() > 0 && node.visibleBounds.height() > 0 }
      .distinctBy(::nodeIdentity)
    assertEquals("Expected exactly one accessible $description", 1, clickable.size)
    return clickable.single()
  }

  private fun clickableAncestor(node: UiObject2): UiObject2? {
    var current: UiObject2? = node
    repeat(MAX_ANCESTOR_DEPTH) {
      if (current?.isClickable == true) return current
      current = current?.parent
    }
    return null
  }

  private fun nodeIdentity(node: UiObject2): String {
    return listOf(
      node.applicationPackage,
      node.visibleBounds.flattenToString(),
      node.text.orEmpty(),
      node.contentDescription.orEmpty(),
    ).joinToString("|")
  }

  private fun assertNoVisibleBrowserChrome() {
    val visibleChromeControls = CHROME_CONTROL_RESOURCE_IDS.flatMap { resourceId ->
      device.findObjects(By.res(CHROME_PACKAGE, resourceId))
    }.filter { node -> node.visibleBounds.width() > 0 && node.visibleBounds.height() > 0 }
    assertTrue(
      "Visible Custom Tab/browser chrome means this is not a trusted full-screen TWA",
      visibleChromeControls.isEmpty(),
    )
  }

  private fun assertTrustedLaunch(window: TelemetryWindow, expectedCount: Int) {
    val events = waitForLaunchEvents(window, expectedCount)
    assertEquals("Unexpected widget_twa_launch_started count", expectedCount, events.size)
    val launch = events.single()
    assertEquals("twa", launch.getString("entrySource"))
    assertEquals(
      "open-workspace",
      launch.getString("launchIntent").replace('_', '-'),
    )
    assertEquals(CHROME_PACKAGE, launch.getString("providerPackage"))
    assertEquals("trusted-web-activity", launch.getString("providerLaunchMode"))
    assertFalse("Ordinary launcher intent must not be marked as widget launch", launch.getBoolean("widgetLaunch"))
  }

  private fun waitForLaunchEvents(
    window: TelemetryWindow,
    expectedCount: Int,
  ): List<JSONObject> {
    val deadline = SystemClock.elapsedRealtime() + TELEMETRY_HANG_TIMEOUT_MS
    var latest = emptyList<JSONObject>()
    while (SystemClock.elapsedRealtime() < deadline) {
      latest = window.launchStartedEvents()
      if (latest.size > expectedCount) return latest
      if (latest.size == expectedCount) {
        SystemClock.sleep(TELEMETRY_DUPLICATE_WINDOW_MS)
        return window.launchStartedEvents()
      }
      SystemClock.sleep(UI_POLL_INTERVAL_MS)
    }
    return latest
  }

  private fun assertNoLaunchStarted(window: TelemetryWindow) {
    val deadline = SystemClock.elapsedRealtime() + TELEMETRY_NEGATIVE_WINDOW_MS
    while (SystemClock.elapsedRealtime() < deadline) {
      val events = window.launchStartedEvents()
      assertTrue("Warm task restore must not start TWA again", events.isEmpty())
      SystemClock.sleep(UI_POLL_INTERVAL_MS)
    }
  }

  private fun waitForCurrentPackage(packageName: String) {
    val deadline = SystemClock.elapsedRealtime() + UI_HANG_TIMEOUT_MS
    while (SystemClock.elapsedRealtime() < deadline) {
      if (device.currentPackageName == packageName) return
      SystemClock.sleep(UI_POLL_INTERVAL_MS)
    }
    fail("Timed out waiting for foreground package $packageName")
  }

  private fun forceStop(packageName: String) {
    requireSafePackageName(packageName)
    shell("am force-stop $packageName")
  }

  private fun resolveTargetPackage(): String {
    val runnerPackage = arguments.getString(ARG_TARGET_PACKAGE)?.trim()?.takeIf { it.isNotEmpty() }
    val candidate = runnerPackage ?: BuildConfig.NANOFLOW_TARGET_PACKAGE
    requireSafePackageName(candidate)
    assertTrue(
      "Resolved NanoFlow target package is not installed",
      shell("pm path $candidate").lineSequence().any { line -> line.startsWith("package:") },
    )
    return candidate
  }

  private fun requiredArgument(name: String): String {
    return arguments.getString(name)?.trim()?.takeIf { it.isNotEmpty() }
      ?: failValue("Missing required instrumentation argument: $name")
  }

  private fun requireSafePackageName(packageName: String) {
    assertTrue("Unsafe Android package name", PACKAGE_NAME_PATTERN.matches(packageName))
  }

  private fun reportElapsed(mode: String, elapsedMs: Long) {
    Log.i(
      METRIC_TAG,
      JSONObject()
        .put("mode", mode)
        .put("editableAnchorElapsedMs", elapsedMs)
        .put("budgetApplied", false)
        .toString(),
    )
  }

  private fun shell(command: String): String = device.executeShellCommand(command)

  private fun <T> failValue(message: String): T {
    fail(message)
    throw AssertionError(message)
  }

  private data class DeviceEnvironment(
    val targetPackage: String,
    val homePackage: String,
    val appLabel: String,
  )

  private class TelemetryWindow private constructor(
    private val device: UiDevice,
    private val marker: String,
  ) {
    fun launchStartedEvents(): List<JSONObject> {
      val output = device.executeShellCommand(LOGCAT_COMMAND)
      val lines = output.lineSequence().toList()
      val markerIndex = lines.indexOfLast { line -> line.contains("$WINDOW_PREFIX$marker") }
      assertTrue("Scoped telemetry marker is missing from logcat", markerIndex >= 0)
      return lines.drop(markerIndex + 1)
        .filter { line -> line.contains(WIDGET_LOG_TAG) }
        .mapNotNull(::parseJsonPayload)
        .filter { payload -> payload.optString("event") == LAUNCH_STARTED_EVENT }
    }

    companion object {
      fun open(device: UiDevice): TelemetryWindow {
        val marker = UUID.randomUUID().toString()
        device.executeShellCommand("log -t $WINDOW_LOG_TAG $WINDOW_PREFIX$marker")
        return TelemetryWindow(device, marker)
      }

      private fun parseJsonPayload(line: String): JSONObject? {
        val start = line.indexOf('{')
        if (start < 0) return null
        return runCatching { JSONObject(line.substring(start)) }.getOrNull()
      }
    }
  }

  private companion object {
    const val ARG_TARGET_PACKAGE = "nanoflowTargetPackage"
    const val ARG_EXPECTED_SERIAL = "nanoflowExpectedSerial"
    const val ARG_EXPECTED_PROJECT_LABEL = "nanoflowExpectedProjectLabel"
    const val CHROME_PACKAGE = "com.android.chrome"
    const val EDITABLE_ANCHOR_TEXT = "新建"
    const val ASSET_STATEMENTS_METADATA = "asset_statements"
    const val WIDGET_LOG_TAG = "NanoFlowWidget"
    const val WINDOW_LOG_TAG = "NanoFlowDeviceTest"
    const val WINDOW_PREFIX = "NANOFLOW_WINDOW_START:"
    const val LAUNCH_STARTED_EVENT = "widget_twa_launch_started"
    const val METRIC_TAG = "NanoFlowDeviceMetric"
    const val UI_HANG_TIMEOUT_MS = 30_000L
    const val TELEMETRY_HANG_TIMEOUT_MS = 5_000L
    const val TELEMETRY_DUPLICATE_WINDOW_MS = 750L
    const val TELEMETRY_NEGATIVE_WINDOW_MS = 1_500L
    const val UI_POLL_INTERVAL_MS = 100L
    const val MAX_ANCESTOR_DEPTH = 12
    val PACKAGE_NAME_PATTERN = Regex("[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)+")
    val CHROME_CONTROL_RESOURCE_IDS = listOf(
      "url_bar",
      "location_bar",
      "toolbar",
      "toolbar_container",
      "custom_tabs_toolbar",
    )
    const val LOGCAT_COMMAND =
      "logcat -d -v brief -t 2000 NanoFlowDeviceTest:I NanoFlowWidget:I *:S"
  }
}
