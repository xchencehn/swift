package io.agentstudio;

import java.net.URI;

/** Only the app document may use the WebView that owns the native bridge. */
final class ChatLinkNavigation {
    private ChatLinkNavigation() { }

    static boolean isWebUrl(String value) {
        try {
            URI uri = URI.create(value);
            return uri.getHost() != null && ("https".equalsIgnoreCase(uri.getScheme())
                    || "http".equalsIgnoreCase(uri.getScheme()));
        } catch (RuntimeException error) { return false; }
    }

    static boolean isAppPage(String value, String appUrl) {
        if (!isWebUrl(value)) return false;
        try {
            URI target = URI.create(value), app = URI.create(appUrl);
            return target.getUserInfo() == null && target.getScheme().equalsIgnoreCase(app.getScheme())
                    && target.getHost().equalsIgnoreCase(app.getHost()) && port(target) == port(app)
                    && isAppPath(target.getPath(), app.getPath());
        } catch (RuntimeException error) { return false; }
    }

    private static boolean isAppPath(String target, String app) {
        if (target == null || app == null) return false;
        if (target.equals(app)) return true;
        String prefix = app.endsWith("/") ? app : app + "/";
        if (!target.startsWith(prefix)) return false;
        String relative = target.substring(prefix.length());
        if (relative.startsWith("machines/")) {
            String[] parts = relative.split("/", 3);
            if (parts.length != 3 || !parts[1].matches("[a-f0-9-]{36}")) return false;
            relative = parts[2];
        }
        if (relative.startsWith("herdr-sessions/")) {
            String[] parts = relative.split("/", 3);
            if (parts.length != 3 || !parts[1].matches("[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}")) return false;
            relative = parts[2];
        }
        return relative.isEmpty() || relative.equals("index.html");
    }

    private static int port(URI uri) {
        return uri.getPort() >= 0 ? uri.getPort() : "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }
}
