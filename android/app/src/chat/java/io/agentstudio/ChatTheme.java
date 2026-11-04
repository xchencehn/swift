package io.agentstudio;

/** Validated device appearance shared by the WebView and its Activity. */
final class ChatTheme {
    static final String PREFERENCES = "chat-appearance";
    static final String DEFAULT_BACKGROUND = "#17171a";

    static boolean validBackground(String value) {
        return value != null && value.matches("#[0-9a-fA-F]{6}");
    }

    static int backgroundColor(String value) {
        String safe = validBackground(value) ? value : DEFAULT_BACKGROUND;
        return (int) (0xff000000L | Long.parseLong(safe.substring(1), 16));
    }
}
