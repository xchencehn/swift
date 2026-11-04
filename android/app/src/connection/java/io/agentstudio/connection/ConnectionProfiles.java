package io.agentstudio.connection;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** Native connection storage. Tokens never cross the WebView bridge. */
public final class ConnectionProfiles {
    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences("direct-computer", Context.MODE_PRIVATE);
    }
    private static JSONObject read(Context context) throws Exception {
        SharedPreferences saved = preferences(context);
        String value = saved.getString("connections", null);
        if (value != null) return new JSONObject(value);
        JSONObject state = new JSONObject().put("profiles", new JSONArray()).put("active", "");
        String base = saved.getString("baseUrl", "");
        if (!base.isEmpty()) {
            String mode = saved.getString("mode", "legacy");
            JSONObject profile = profile(base, saved.getString("token", ""), mode, "已保存的服务端");
            state.getJSONArray("profiles").put(profile);
            state.put("active", profile.getString("id"));
        }
        return state;
    }
    private static JSONObject profile(String base, String token, String mode, String name) throws Exception {
        String id = UUID.nameUUIDFromBytes((mode + ":" + base).getBytes(StandardCharsets.UTF_8)).toString();
        return new JSONObject().put("id", id).put("name", name).put("address", base).put("token", token).put("mode", mode);
    }
    public static synchronized String publicProfiles(Context context) {
        try {
            JSONObject state = read(context), visible = new JSONObject().put("active", state.optString("active"));
            JSONArray profiles = state.getJSONArray("profiles"), result = new JSONArray();
            for (int i = 0; i < profiles.length(); i++) {
                JSONObject profile = profiles.getJSONObject(i);
                if (!profile.optString("mode").equals("direct")) continue;
                result.put(new JSONObject().put("id", profile.getString("id")).put("name", profile.getString("name"))
                        .put("mode", profile.getString("mode")).put("address", profile.getString("address")));
            }
            return visible.put("profiles", result).toString();
        } catch (Exception error) { return "{\"profiles\":[],\"error\":\"无法读取已保存的服务端，请打开连接设置。\"}"; }
    }
    public static TokenConnection verified(Context context, String id) throws Exception {
        JSONArray profiles;
        synchronized (ConnectionProfiles.class) { profiles = read(context).getJSONArray("profiles"); }
        for (int i = 0; i < profiles.length(); i++) {
            JSONObject item = profiles.getJSONObject(i);
            if (!item.getString("id").equals(id)) continue;
            if (item.optString("mode").equals("direct")) {
                TokenConnection connection = new TokenConnection(item.getString("address"), item.optString("token"), true);
                if (!new JSONObject(connection.verify()).optBoolean("ok")) throw new IOException("这个地址不是 Swift 执行端。"); return connection;
            }
            throw new IOException("此连接属于已封存的商业版，请使用服务器直连链接重新添加。");
        }
        throw new IOException("服务端已被移除，请重新打开列表。");
    }
    public static synchronized void save(Context context, TokenConnection connection, String name) throws Exception {
        saveDirectOrRemote(context, connection, name, "direct");
    }
    public static synchronized void saveDirect(Context context, TokenConnection connection, String name) throws Exception { saveDirectOrRemote(context, connection, name, "direct"); }
    private static void saveDirectOrRemote(Context context, TokenConnection connection, String name, String mode) throws Exception {
        JSONObject state = read(context), item = profile(connection.baseUrl, connection.token, mode, name == null || name.trim().isEmpty() ? "服务器" : name.trim());
        JSONArray previous = state.getJSONArray("profiles"), profiles = new JSONArray();
        for (int i = 0; i < previous.length(); i++)
            if (!previous.getJSONObject(i).getString("id").equals(item.getString("id"))) profiles.put(previous.getJSONObject(i));
        if (profiles.length() >= 64) throw new IOException("最多保存 64 个服务端，请先移除不需要的连接。");
        profiles.put(item);
        state.put("profiles", profiles).put("active", item.getString("id"));
        commit(context, state, connection, mode);
    }
    public static synchronized void select(Context context, String id, TokenConnection connection) throws Exception {
        JSONObject state = read(context);
        boolean found = false; String mode = "direct";
        JSONArray profiles = state.getJSONArray("profiles");
        for (int i = 0; i < profiles.length(); i++) if (profiles.getJSONObject(i).getString("id").equals(id)) {
            JSONObject item = profiles.getJSONObject(i);
            if (!item.getString("token").equals(connection.token)) throw new IOException("连接已改变，请重新选择。");
            item.put("address", connection.baseUrl);
            mode = item.getString("mode");
            found = true;
        }
        if (!found) throw new IOException("服务端已被移除，请重新打开列表。");
        state.put("active", id);
        commit(context, state, connection, mode);
    }
    private static void commit(Context context, JSONObject state, TokenConnection connection, String mode) throws IOException {
        if (!preferences(context).edit().putString("connections", state.toString()).putString("baseUrl", connection.baseUrl)
                .putString("token", connection.token).putString("mode", mode).commit())
            throw new IOException("连接信息保存失败，请重试。");
    }
    public static synchronized boolean remove(Context context, String id) throws Exception {
        JSONObject state = read(context);
        JSONArray previous = state.getJSONArray("profiles"), profiles = new JSONArray();
        for (int i = 0; i < previous.length(); i++) if (!previous.getJSONObject(i).getString("id").equals(id))
            profiles.put(previous.getJSONObject(i));
        boolean active = state.optString("active").equals(id);
        String previousBase = preferences(context).getString("baseUrl", "");
        state.put("profiles", profiles);
        SharedPreferences.Editor editor = preferences(context).edit();
        if (active) {
            state.put("active", "");
            editor.remove("baseUrl").remove("token").remove("mode");
        }
        if (!editor.putString("connections", state.toString()).commit()) throw new IOException("无法移除连接，请重试。");
        if (active && !previousBase.isEmpty()) {
            String path = android.net.Uri.parse(previousBase).getPath();
            android.webkit.CookieManager.getInstance().setCookie(previousBase, "agentStudioToken=; Path=" + (path == null || path.isEmpty() ? "/" : path) + "; Max-Age=0; HttpOnly");
            android.webkit.CookieManager.getInstance().flush();
        }
        return active;
    }
    public static String errorMessage(Exception error) {
        if (error instanceof java.net.SocketTimeoutException) return "连接超时，请检查服务端是否在线。";
        if (error instanceof javax.net.ssl.SSLException) return "无法验证连接身份，请核对电脑并重新配对，不要跳过证书校验。";
        if (error instanceof IOException || error instanceof IllegalArgumentException) return error.getMessage();
        return "连接失败，请检查网络和 token 后重试。";
    }
    public static final class Prepared {
        public final TokenConnection direct; final String id;
        Prepared(String id,TokenConnection direct) {this.id=id;this.direct=direct;}
    }
    public static Prepared prepare(Context context,String id)throws Exception {return new Prepared(id,verified(context,id));}
    public static synchronized void selectPrepared(Context context,String id,Prepared prepared)throws Exception {
        if(!id.equals(prepared.id)) throw new IOException("连接身份已改变，请重新选择。"); select(context,id,prepared.direct);
    }
}
