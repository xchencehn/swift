package io.agentstudio;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.graphics.Color;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * 聊天视图:直接嵌网页版的聊天页,而不是用原生控件复刻它。
 *
 * 🔑 这么做的理由是「一模一样」这个要求用原生控件达不到 —— 字号、行高、间距、
 * markdown 的每一种元素都要手工对齐 CSS,改一处网页就要跟一次,永远追不平。
 * 嵌进来之后两端从此是同一套实现,网页改了 APP 不必重新发包。
 *
 * 反过来终端仍然是原生的:那边要逐字节渲染 PTY 并处理输入法,WebView 做不好。
 * 一个 APP 里两种技术,各用在它擅长的那一半。
 *
 * 页面走 `?view=chat`,那个模式下网页只渲染聊天,终端与底栏都交给宿主。
 */
final class ChatWebView extends FrameLayout {
    private static final String TAG = "SwiftChat";

    interface Host {
        /** 网页里向左滑要回终端 —— 终端在原生这边,只能由宿主切。 */
        void onCloseChat();
        void onNotice(String message);
        boolean onChooseFile(Intent intent);
        void onSaveFile(Intent intent);
        void onThemeChanged(int background, boolean light);
    }

    private final WebView web;
    private WebView externalWeb;
    private final String url;
    private final Host host;
    private boolean loaded;
    private ValueCallback<Uri[]> fileCallback;
    private volatile SavedFiles savingFile;
    private volatile boolean destroyed;
    private final java.util.concurrent.ExecutorService connectionWorker = java.util.concurrent.Executors.newSingleThreadExecutor();
    private final java.util.concurrent.atomic.AtomicBoolean switchingConnection = new java.util.concurrent.atomic.AtomicBoolean();

    private void connectionResult(String requestId, boolean ok, String message) {
        post(() -> {
            if (destroyed) return;
            try {
                org.json.JSONObject result = new org.json.JSONObject().put("requestId", requestId).put("ok", ok).put("message", message);
                web.evaluateJavascript("window.dispatchEvent(new CustomEvent('swift:connection-result',{detail:" + result + "}))", null);
            } catch (org.json.JSONException ignored) { }
        });
    }

    @SuppressLint("SetJavaScriptEnabled")
    ChatWebView(Context context, String baseUrl, Host host) {
        super(context);
        this.host = host;
        // ConnectionRuntime installs the HttpOnly management cookie natively.
        this.url = baseUrl.replaceAll("/+$", "") + "/?view=chat";
        int initialBackground = ChatTheme.backgroundColor(context.getSharedPreferences(
                ChatTheme.PREFERENCES, Context.MODE_PRIVATE).getString("background", ChatTheme.DEFAULT_BACKGROUND));
        setBackgroundColor(initialBackground);

        web = new WebView(context);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        // 侧栏的折叠状态、分栏宽度都存在 localStorage 里,不开这个会每次回到默认值。
        settings.setDomStorageEnabled(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        web.setBackgroundColor(initialBackground);
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                finishFileChooser(null);
                fileCallback = callback;
                try {
                    if (!host.onChooseFile(params.createIntent())) finishFileChooser(null);
                } catch (RuntimeException error) {
                    finishFileChooser(null);
                    host.onNotice("无法打开文件选择器");
                }
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                String target = request.getUrl().toString();
                if (ChatLinkNavigation.isAppPage(target, url)) return false;
                openLink(target);
                return true;
            }
            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                // A rejected main document cannot load JavaScript to call the authentication bridge.
                if (request != null && request.isForMainFrame() && response != null
                        && (response.getStatusCode() == 401 || response.getStatusCode() == 403)
                        && ChatLinkNavigation.isAppPage(request.getUrl().toString(), url)) {
                    post(() -> io.agentstudio.connection.ConnectionRuntime.rejected((android.app.Activity) getContext()));
                }
            }
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // 只报主文档的失败。页面里某个图标没加载不该弹提示。
                if (request != null && request.isForMainFrame()) {
                    host.onNotice("聊天页加载失败：" + error.getDescription());
                }
            }
        });
        web.addJavascriptInterface(new Bridge(), "StudioApp");
        addView(web, new FrameLayout.LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void openLink(String target) {
        if (!ChatLinkNavigation.isWebUrl(target)) {
            try { getContext().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(target))); }
            catch (RuntimeException error) { host.onNotice("无法打开链接"); }
            return;
        }
        if (externalWeb == null) {
            externalWeb = new WebView(getContext());
            externalWeb.setBackgroundColor(Color.rgb(21, 21, 23));
            externalWeb.getSettings().setJavaScriptEnabled(true);
            externalWeb.getSettings().setDomStorageEnabled(true);
            // Keep the chat document and its drafts alive underneath. External
            // pages receive neither the native bridge nor the app auth URL.
            externalWeb.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    if (!request.isForMainFrame()) return false;
                    String next = request.getUrl().toString();
                    if (ChatLinkNavigation.isAppPage(next, url)) { closeLink(); return true; }
                    if (ChatLinkNavigation.isWebUrl(next)) return false;
                    openLink(next); return true;
                }
            });
            addView(externalWeb, new FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        }
        externalWeb.loadUrl(target);
    }

    private void closeLink() {
        if (externalWeb == null) return;
        WebView closing = externalWeb;
        externalWeb = null;
        removeView(closing); closing.destroy();
        web.requestFocus();
        web.evaluateJavascript("window.dispatchEvent(new Event('focus'))", null);
    }

    private final class Bridge {
        @JavascriptInterface
        public void selectionHaptic() {
            post(() -> {
                if (!destroyed && externalWeb == null && web.isShown() && web.hasWindowFocus()) {
                    web.performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK);
                }
            });
        }

        @JavascriptInterface
        public void authenticationRequired() {
            post(() -> io.agentstudio.connection.ConnectionRuntime.rejected((android.app.Activity) getContext()));
        }
        @JavascriptInterface
        public void connectionSettings() {
            post(() -> io.agentstudio.connection.ConnectionRuntime.settings((android.app.Activity) getContext()));
        }

        @JavascriptInterface
        public String savedConnections() {
            return io.agentstudio.connection.ConnectionProfiles.publicProfiles(getContext());
        }

        @JavascriptInterface
        public void switchConnection(String id, String requestId) {
            if (destroyed || id == null || requestId == null || !id.matches("[a-f0-9-]{36}") || !requestId.matches("[a-f0-9-]{36}")) return;
            if (!switchingConnection.compareAndSet(false, true)) {
                connectionResult(requestId, false, "正在切换服务端，请稍候。"); return;
            }
            connectionWorker.execute(() -> {
                try {
                    io.agentstudio.connection.ConnectionProfiles.Prepared connection = io.agentstudio.connection.ConnectionProfiles.prepare(getContext(), id);
                    post(() -> {
                        if (destroyed) return;
                        try {
                            io.agentstudio.connection.ConnectionProfiles.selectPrepared(getContext(), id, connection);
                            io.agentstudio.connection.ConnectionRuntime.startPrepared(getContext(), connection);
                            connectionResult(requestId, true, "");
                            ((android.app.Activity) getContext()).recreate();
                        } catch (Exception error) {
                            switchingConnection.set(false);
                            connectionResult(requestId, false, io.agentstudio.connection.ConnectionProfiles.errorMessage(error));
                        }
                    });
                } catch (Exception error) {
                    switchingConnection.set(false);
                    connectionResult(requestId, false, io.agentstudio.connection.ConnectionProfiles.errorMessage(error));
                }
            });
        }

        @JavascriptInterface
        public void setTheme(String background, boolean light) {
            if (!ChatTheme.validBackground(background)) return;
            post(() -> {
                int color = ChatTheme.backgroundColor(background);
                setBackgroundColor(color);
                web.setBackgroundColor(color);
                getContext().getSharedPreferences(ChatTheme.PREFERENCES, Context.MODE_PRIVATE)
                        .edit().putString("background", background).putBoolean("light", light).apply();
                host.onThemeChanged(color, light);
            });
        }

        /** 网页在 WebView 的 JS 线程上调,切视图必须回到主线程。 */
        @JavascriptInterface
        public void closeChat() {
            post(host::onCloseChat);
        }

        @JavascriptInterface
        public synchronized boolean beginSaveFile(String id, String name, String mime) {
            if (savingFile != null) return false;
            try { savingFile = new SavedFiles(getContext().getCacheDir(), id, name, mime); return true; }
            catch (java.io.IOException error) { return false; }
        }

        @JavascriptInterface
        public synchronized boolean appendSaveFile(String id, String base64) {
            if (savingFile == null || !savingFile.id.equals(id) || savingFile.finished()) return false;
            try { savingFile.append(base64); return true; }
            catch (java.io.IOException error) { discardSavingFile(); return false; }
        }

        @JavascriptInterface
        public synchronized boolean finishSaveFile(String id) {
            if (savingFile == null || !savingFile.id.equals(id) || savingFile.finished()) return false;
            try { savingFile.finish(); }
            catch (java.io.IOException error) { discardSavingFile(); return false; }
            SavedFiles item = savingFile;
            post(() -> {
                try { host.onSaveFile(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                        .setType(item.mime).putExtra(Intent.EXTRA_TITLE, item.name)); }
                catch (RuntimeException error) { savedResult(item, "无法打开保存位置选择器。"); }
            });
            return true;
        }

        @JavascriptInterface
        public synchronized void abortSaveFile(String id) {
            if (savingFile != null && savingFile.id.equals(id)) discardSavingFile();
        }

        /**
         * 文件页里长按图片「保存到本地」：存进系统相册的 Pictures/AgentStudio。
         * WebView 不会自己处理网页发起的下载，只能由这里接手。
         */
        @JavascriptInterface
        public void saveImage(String base64, String name, String declaredMime) {
            String error = saveImageResult(base64, name, declaredMime);
            if (!error.isEmpty()) post(() -> host.onNotice(error));
        }

        @JavascriptInterface
        public String saveImageResult(String base64, String name, String declaredMime) {
            String mime = SharedImages.mimeType(declaredMime, name);
            byte[] bytes = SharedImages.decode(base64);
            if (mime == null || bytes == null) { return "这张图片没法保存"; }
            String fileName = SharedImages.fileName(name, mime);
            try {
                if (android.os.Build.VERSION.SDK_INT < 29) throw new IllegalStateException("系统版本太旧，暂不支持保存到相册");
                android.content.ContentResolver resolver = getContext().getContentResolver();
                android.content.ContentValues values = new android.content.ContentValues();
                values.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                values.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mime);
                values.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, android.os.Environment.DIRECTORY_PICTURES + "/AgentStudio");
                Uri target = resolver.insert(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
                if (target == null) throw new IllegalStateException("相册拒绝写入");
                try (java.io.OutputStream out = resolver.openOutputStream(target)) {
                    if (out == null) throw new IllegalStateException("相册拒绝写入");
                    out.write(bytes);
                }
                return "";
            } catch (Exception error) {
                Log.w(TAG, "save image failed", error);
                String message = error.getMessage() == null ? "保存失败" : error.getMessage();
                return message;
            }
        }

        /** 「分享…」：调起系统分享面板，微信、QQ 都在里面。图片先写到缓存，再给一个只读地址。 */
        @JavascriptInterface
        public void shareImage(String base64, String name, String declaredMime) {
            String mime = SharedImages.mimeType(declaredMime, name);
            byte[] bytes = SharedImages.decode(base64);
            if (mime == null || bytes == null) { post(() -> host.onNotice("这张图片没法分享")); return; }
            String fileName = SharedImages.fileName(name, mime);
            try {
                java.io.File directory = SharedImageProvider.directory(getContext());
                if (!directory.isDirectory() && !directory.mkdirs()) throw new java.io.IOException("缓存目录不可用");
                java.io.File[] old = directory.listFiles();
                if (old != null) for (java.io.File item : old) item.delete();
                try (java.io.FileOutputStream out = new java.io.FileOutputStream(new java.io.File(directory, fileName))) { out.write(bytes); }
                Uri uri = SharedImageProvider.uri(getContext(), fileName);
                Intent send = new Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                send.setClipData(android.content.ClipData.newRawUri(fileName, uri));
                post(() -> {
                    try { getContext().startActivity(Intent.createChooser(send, "分享图片")); }
                    catch (RuntimeException error) { host.onNotice("没有可以分享的应用"); }
                });
            } catch (Exception error) {
                Log.w(TAG, "share image failed", error);
                post(() -> host.onNotice("分享失败"));
            }
        }
    }

    void setOpen(boolean open) {
        setVisibility(open ? VISIBLE : GONE);
        if (!open) return;
        if (!loaded) {
            // 首次打开才加载,免得启动时就为一个还没看的页面花时间和流量。
            loaded = true;
            Log.i(TAG, "loading chat view");
            web.loadUrl(url);
            io.agentstudio.connection.ConnectionRuntime.verifyDirectAuthentication((android.app.Activity) getContext());
        } else {
            // 回到聊天时让页面自己刷一遍,省得看到离开前的旧内容。
            web.evaluateJavascript("window.dispatchEvent(new Event('focus'))", null);
        }
    }

    /**
     * 会话版 APP 里返回键的去处:页面自己能后退就先后退(比如从某个会话回到列表),
     * 退到底了才让 Activity 关掉。返回 true 表示这一下已经被页面消化掉了。
     */
    private boolean handlingBack;

    void handleBack(Runnable exit) {
        if (externalWeb != null) {
            if (ChatBackNavigation.action(true, externalWeb.canGoBack(), null) == ChatBackNavigation.Action.WEB_BACK)
                externalWeb.goBack();
            else closeLink();
            return;
        }
        if (!loaded) { exit.run(); return; }
        if (handlingBack) return;
        handlingBack = true;
        web.evaluateJavascript("Boolean(window.StudioServerSwitcher?.closeOpen?.() || window.StudioNavigation && window.StudioNavigation.back())", result -> {
            handlingBack = false;
            if (ChatBackNavigation.action(false, false, result) == ChatBackNavigation.Action.EXIT) exit.run();
        });
    }

    void destroy() {
        destroyed = true;
        connectionWorker.shutdownNow();
        finishFileChooser(null);
        discardSavingFile();
        if (externalWeb != null) { removeView(externalWeb); externalWeb.destroy(); externalWeb = null; }
        removeView(web);
        web.destroy();
    }

    private synchronized void discardSavingFile() {
        if (savingFile == null) return;
        try { savingFile.close(); } catch (java.io.IOException error) { Log.w(TAG, "Cannot close saved file", error); }
        savingFile = null;
    }

    private void savedResult(SavedFiles item, String error) {
        post(() -> {
            synchronized (ChatWebView.this) { if (savingFile != item) return; discardSavingFile(); }
            String detail = "{id:" + org.json.JSONObject.quote(item.id) + ",error:" + org.json.JSONObject.quote(error == null ? "" : error) + "}";
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('swift.file.saved',{detail:" + detail + "}))", null);
        });
    }

    void onSaveFileChosen(int resultCode, Intent data) {
        final SavedFiles item = savingFile;
        if (item == null) return;
        if (resultCode != android.app.Activity.RESULT_OK || data == null || data.getData() == null) { savedResult(item, null); return; }
        final Uri target = data.getData();
        new Thread(() -> {
            try (java.io.InputStream input = new java.io.FileInputStream(item.file);
                 java.io.OutputStream output = getContext().getContentResolver().openOutputStream(target, "wt")) {
                if (output == null) throw new java.io.IOException("保存位置不可写入");
                byte[] buffer = new byte[64 * 1024]; int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            } catch (java.io.IOException error) { savedResult(item, "文件保存失败，请重新选择位置。"); return; }
            savedResult(item, null);
        }, "swift-save-file").start();
    }

    void onFileChosen(int resultCode, Intent data) {
        finishFileChooser(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
    }

    private void finishFileChooser(Uri[] files) {
        ValueCallback<Uri[]> callback = fileCallback;
        fileCallback = null;
        if (callback != null) callback.onReceiveValue(files);
    }
}
