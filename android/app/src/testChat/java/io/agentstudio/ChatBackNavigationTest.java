package io.agentstudio;
import org.junit.Test;
import static org.junit.Assert.*;
public class ChatBackNavigationTest {
    @Test public void exitOnlyWhenThePageDidNotConsumeBack() {
        assertTrue(ChatBackNavigation.handled("true"));
        assertFalse(ChatBackNavigation.handled("false"));
        assertFalse(ChatBackNavigation.handled("null"));
        assertFalse(ChatBackNavigation.handled(null));
    }
    @Test public void webHistoryReturnsToThePreservedChatBeforeExiting() {
        assertEquals(ChatBackNavigation.Action.WEB_BACK, ChatBackNavigation.action(true, true, null));
        assertEquals(ChatBackNavigation.Action.CLOSE_WEB, ChatBackNavigation.action(true, false, "false"));
        assertEquals(ChatBackNavigation.Action.PAGE_HANDLED, ChatBackNavigation.action(false, true, "true"));
        assertEquals(ChatBackNavigation.Action.EXIT, ChatBackNavigation.action(false, false, "false"));
    }
    @Test public void onlyTheExactAppDocumentKeepsTheNativeBridge() {
        String app = "https://app.example/swift/?view=chat";
        assertTrue(ChatLinkNavigation.isAppPage("https://app.example:443/swift/?view=chat#latest", app));
        for (String link : new String[] {"https://example.com/", "https://app.example/other/",
                "https://app.example.evil.test/swift/", "http://app.example/swift/",
                "https://user@app.example/swift/", "javascript:alert(1)", "not a url"})
            assertFalse(ChatLinkNavigation.isAppPage(link, app));
        assertTrue(ChatLinkNavigation.isWebUrl("https://example.com/article"));
        assertFalse(ChatLinkNavigation.isWebUrl("mailto:user@example.com"));
    }
}
