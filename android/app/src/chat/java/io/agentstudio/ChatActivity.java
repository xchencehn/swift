package io.agentstudio;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Build;
import android.window.OnBackInvokedDispatcher;
import android.util.Log;
import android.view.ViewGroup;
import android.view.View;
import android.widget.FrameLayout;

/**
 * 会话版 APP 的全部内容:一个装着网页版会话页的壳。
 *
 * 🔑 为什么是壳而不是原生:会话页要求和网页「一模一样」,而字号、行高、间距、
 * markdown 的每一种元素用原生控件都得手工对齐 CSS,网页改一处就要跟一次,永远追不平。
 * 嵌进来之后两端从此是同一套实现,**网页改了这个 APP 不必重新发包**。
 * 终端那半反过来必须原生(逐字节渲染 PTY、处理输入法),所以它是另一个 APP。
 *
 * 这里不再有「切回终端」那座桥:终端是独立的另一个 APP,由系统的任务切换来回。
 */
public final class ChatActivity extends Activity {
    private static final String TAG = "SwiftChat";
    private ChatWebView chat;
    private FrameLayout root;
    private static final int PICK_ATTACHMENT = 101;
    private static final int SAVE_FILE = 102;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (!io.agentstudio.connection.ConnectionRuntime.require(this)) return;
        root = new FrameLayout(this);
        android.content.SharedPreferences appearance = getSharedPreferences(ChatTheme.PREFERENCES, MODE_PRIVATE);
        applyTheme(ChatTheme.backgroundColor(appearance.getString("background", ChatTheme.DEFAULT_BACKGROUND)),
                appearance.getBoolean("light", false));
        root.setFitsSystemWindows(true);
        chat = new ChatWebView(this, io.agentstudio.connection.ConnectionRuntime.baseUrl(),
                new ChatWebView.Host() {
                    // 没有终端可切了 —— 会话是这个 APP 的全部。
                    @Override public void onCloseChat() { }
                    // 加载失败会反复发生,写进 logcat 就好,不要弹成一串 Toast 打断使用。
                    @Override public void onNotice(String message) { Log.i(TAG, message); }
                    @Override public void onThemeChanged(int background, boolean light) {
                        applyTheme(background, light);
                    }
                    @Override public void onSaveFile(Intent intent) { startActivityForResult(intent, SAVE_FILE); }
                    @Override public boolean onChooseFile(Intent intent) {
                        startActivityForResult(intent, PICK_ATTACHMENT);
                        return true;
                    }
                });
        root.addView(chat, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        chat.setOpen(true);
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
    }

    private void applyTheme(int background, boolean light) {
        root.setBackgroundColor(background);
        getWindow().setStatusBarColor(background);
        getWindow().setNavigationBarColor(background);
        View decor = getWindow().getDecorView();
        int mask = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= 26) mask |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        int flags = decor.getSystemUiVisibility() & ~mask;
        decor.setSystemUiVisibility(light ? flags | mask : flags);
    }

    @Override
    protected void onStop() {
        // 退到后台还让页面继续轮询纯属耗电;回到前台再续上。
        if (chat != null) chat.setOpen(false);
        io.agentstudio.connection.ConnectionRuntime.background();
        super.onStop();
    }

    @Override
    protected void onStart() {
        super.onStart();
        io.agentstudio.connection.ConnectionRuntime.wake();   // 后台期间连接可能被系统断掉，回来先补齐
        if (chat != null) chat.setOpen(true);
    }

    // API 33+ uses the registered platform callback; this handles older Android.
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Override
    public void onBackPressed() {
        handleBack();
    }

    private void handleBack() {
        if (chat != null) chat.handleBack(this::finish);
        else finish();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_ATTACHMENT && chat != null) chat.onFileChosen(resultCode, data);
        if (requestCode == SAVE_FILE && chat != null) chat.onSaveFileChosen(resultCode, data);
    }

    @Override
    protected void onDestroy() {
        if (chat != null) chat.destroy();
        super.onDestroy();
    }
}
