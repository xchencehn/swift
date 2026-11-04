package io.agentstudio;

import org.junit.Test;
import static org.junit.Assert.*;

public class ChatThemeTest {
    @Test public void acceptsOnlyOpaqueHexColors() {
        assertTrue(ChatTheme.validBackground("#f7f7f5"));
        assertTrue(ChatTheme.validBackground("#ABCDEF"));
        for (String value : new String[] {null, "", "red", "#fff", "#00000000", "#123456;", "#12345g"})
            assertFalse(ChatTheme.validBackground(value));
    }
    @Test public void preservesNativeBackgroundAcrossStartup() {
        assertEquals(0xfff7f7f5, ChatTheme.backgroundColor("#f7f7f5"));
        assertEquals(0xff17171a, ChatTheme.backgroundColor(null));
        assertEquals(0xff17171a, ChatTheme.backgroundColor("corrupt"));
    }
}
