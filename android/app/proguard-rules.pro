-keep class com.termux.terminal.** { *; }
-keep class com.termux.view.** { *; }

# 网页通过 SwiftApp.closeChat() 这个名字调进来(聊天视图是嵌进来的网页,
# 向左滑要回原生终端)。R8 默认会把方法名混淆掉,那样 debug 正常、release
# 静默失效 —— 侧滑没反应,还查不出原因。按注解保住所有 JS 接口方法。
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
