package io.agentstudio;

/** Only an explicit true response consumes a system Back action. */
final class ChatBackNavigation {
    private ChatBackNavigation() { }
    static boolean handled(String result) { return "true".equals(result); }
    enum Action { WEB_BACK, CLOSE_WEB, PAGE_HANDLED, EXIT }
    static Action action(boolean externalPage, boolean canGoBack, String pageResult) {
        if (externalPage) return canGoBack ? Action.WEB_BACK : Action.CLOSE_WEB;
        return handled(pageResult) ? Action.PAGE_HANDLED : Action.EXIT;
    }
}
