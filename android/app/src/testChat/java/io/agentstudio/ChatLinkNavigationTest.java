package io.agentstudio;
import org.junit.Test;
import static org.junit.Assert.*;
public class ChatLinkNavigationTest {
    @Test public void nativeNamespacesStayInsideTrustedAppNavigation() {
        String base = "https://example.test/swift/";
        assertTrue(ChatLinkNavigation.isAppPage(base + "herdr-sessions/work/?pane=w1", base));
        assertTrue(ChatLinkNavigation.isAppPage(base + "machines/12345678-1234-1234-1234-123456789abc/herdr-sessions/work/", base));
        assertFalse(ChatLinkNavigation.isAppPage("https://other.test/swift/herdr-sessions/work/", base));
        assertFalse(ChatLinkNavigation.isAppPage(base + "api/config", base));
        assertFalse(ChatLinkNavigation.isAppPage(base + "herdr-sessions/../", base));
        assertFalse(ChatLinkNavigation.isAppPage(base + "herdr-sessions/work/api/config", base));
        assertFalse(ChatLinkNavigation.isAppPage(base + "doc-files/read", base));
    }
}
