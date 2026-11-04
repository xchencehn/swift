package io.agentstudio;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

final class HerdrConnection {
    private static final MediaType JSON_TYPE = MediaType.get("application/json; charset=utf-8");

    interface Listener {
        void onBytes(byte[] bytes, Runnable consumed);
        void onState(String state);
        default void onUnauthorized() { }
    }


    private final OkHttpClient client = new OkHttpClient.Builder()
            .followRedirects(false).followSslRedirects(false)
            .pingInterval(20, TimeUnit.SECONDS)
            .connectTimeout(12, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final String baseUrl;
    private final String token;
    private final Listener listener;
    private WebSocket socket;
    private boolean stopped;
    private int columns = 80;
    private int rows = 24;
    private int reconnectAttempt;
    private JSONObject pendingFlow;

    HerdrConnection(String baseUrl, String token, Listener listener) {
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.token = token;
        this.listener = listener;
    }

    void start() {
        stopped = false;
        connect();
    }

    void stop() {
        stopped = true;
        main.removeCallbacksAndMessages(null);
        if (socket != null) socket.close(1000, "activity stopped");
        socket = null;
    }

    void send(byte[] bytes) {
        WebSocket active = socket;
        if (active != null && bytes.length > 0) active.send(ByteString.of(bytes));
    }

    void send(String text) {
        send(text.getBytes(StandardCharsets.UTF_8));
    }

    void resize(int columns, int rows) {
        this.columns = Math.max(20, columns);
        this.rows = Math.max(5, rows);
        WebSocket active = socket;
        if (active != null) {
            active.send("{\"type\":\"terminal.resize\",\"cols\":" + this.columns +
                    ",\"rows\":" + this.rows + "}");
        }
    }

    /**
     * 切换标签页。切换结果直接体现在终端画面上，因此这里不回调界面，
     * 只在失败时留下一条日志。
     */
    /** 聊天视图用的两个只读接口,与网页端同源:agent 列表来自快照,对话来自会话存档。 */
    interface JsonCallback {
        void onJson(JSONObject payload);
        void onError(String message);
    }

    void fetchAgents(JsonCallback callback) {
        get("/api/snapshot", callback, "读取 agent 列表失败");
    }

    void fetchTranscript(String paneId, int limit, JsonCallback callback) {
        String encoded;
        try {
            encoded = java.net.URLEncoder.encode(paneId, "UTF-8");
        } catch (java.io.UnsupportedEncodingException error) {
            encoded = paneId;
        }
        get("/api/transcript?pane=" + encoded + "&limit=" + limit, callback, "读取对话失败");
    }

    private void get(String path, JsonCallback callback, String failureLabel) {
        Request request = new Request.Builder()
                .url(baseUrl + path)
                .header("x-agent-studio-token", token)
                .get()
                .build();
        client.newCall(request).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException error) {
                main.post(() -> callback.onError(failureLabel + "：" + error.getMessage()));
            }

            @Override
            public void onResponse(Call call, Response response) {
                JSONObject payload = null;
                String message = null;
                try (ResponseBody body = response.body()) {
                    payload = new JSONObject(body == null ? "{}" : body.string());
                    if (!response.isSuccessful() || !payload.optBoolean("ok")) {
                        message = payload.optString("message", failureLabel);
                        payload = null;
                    }
                } catch (Exception error) {
                    message = failureLabel;
                    payload = null;
                }
                final JSONObject result = payload;
                final String failure = message;
                main.post(() -> {
                    if (result != null) callback.onJson(result);
                    else callback.onError(failure);
                });
            }
        });
    }

private void connect() {
        if (stopped) return;
        String wsBase = baseUrl.startsWith("https://")
                ? "wss://" + baseUrl.substring(8)
                : "ws://" + baseUrl.substring(7);
        String url = wsBase + "/api/terminal?cols=" + columns + "&rows=" + rows + "&flow=ack";
        Request request = new Request.Builder()
                .url(url)
                .header("x-agent-studio-token", token)
                .build();
        listener.onState(reconnectAttempt == 0 ? "连接中" : "重新连接中");
        socket = client.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                main.post(() -> {
                    if (socket != webSocket || stopped) return;
                    pendingFlow = null; reconnectAttempt = 0;
                    listener.onState("已连接");
                    resize(columns, rows);
                });
            }

            @Override
            public void onMessage(WebSocket webSocket, ByteString bytes) {
                byte[] value = bytes.toByteArray();
                main.post(() -> {
                    if (socket != webSocket || stopped) return;
                    JSONObject credit = pendingFlow; pendingFlow = null;
                    listener.onBytes(value, () -> {
                        if (socket != webSocket || stopped || credit == null) return;
                        try {
                            JSONObject ack = new JSONObject(); ack.put("type", "terminal.ack");
                            ack.put("streamId", credit.getString("streamId")); ack.put("offset", credit.getLong("offset"));
                            webSocket.send(ack.toString());
                        } catch (Exception ignored) { }
                    });
                });
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                main.post(() -> { if (socket == webSocket && !stopped) handleControl(text); });
            }

            @Override
            public void onClosing(WebSocket webSocket, int code, String reason) {
                webSocket.close(code, reason);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                main.post(() -> {
                    if (socket != webSocket || stopped) return;
                    if (code == 4008) { socket = null; listener.onState("接收速度不足，请重新打开终端连接"); return; }
                    scheduleReconnect("连接已断开");
                });
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable error, Response response) {
                main.post(() -> {
                    if (socket != webSocket || stopped) return;
                    if (response != null && (response.code() == 401 || response.code() == 403)) {
                        stop(); listener.onUnauthorized(); return;
                    }
                    scheduleReconnect("网络不可用");
                });
            }
        });
    }

    private void handleControl(String text) {
        try {
            JSONObject message = new JSONObject(text);
            String type = message.optString("type");
            if ("terminal.flow".equals(type)) { pendingFlow = message;
            } else if ("terminal.error".equals(type)) {
                listener.onState(message.optString("message", "终端错误"));
            } else if ("terminal.exit".equals(type)) {
                listener.onState("远端终端已退出");
            }
        } catch (Exception ignored) {
            // Raw terminal output is binary. Unknown text frames are deliberately ignored.
        }
    }

    private void scheduleReconnect(String state) {
        if (stopped) return;
        socket = null;
        listener.onState(state);
        long delay = Math.min(10_000L, 750L << Math.min(reconnectAttempt++, 4));
        main.removeCallbacksAndMessages(null);
        main.postDelayed(this::connect, delay);
    }
}
