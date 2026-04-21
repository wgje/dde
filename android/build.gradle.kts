plugins {
  id("com.android.application") version "8.7.3" apply false
  kotlin("android") version "2.0.21" apply false
  kotlin("plugin.serialization") version "2.0.21" apply false
  kotlin("plugin.compose") version "2.0.21" apply false
  // 2026-04-21 FCM 接入：google-services 插件在 :app 模块按需 apply（取决于
  // google-services.json 是否存在），缺 json 时自动降级到非 FCM 构建。
  id("com.google.gms.google-services") version "4.4.2" apply false
}
