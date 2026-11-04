package io.agentstudio;

import static org.junit.Assert.assertEquals;
import org.junit.Test;

public class TerminalLayoutTest {
    @Test
    public void contentInsetOnlyKicksInOnWideScreens() {
        // 手机:窄于上限,不该白白挤掉宽度
        assertEquals(0, TerminalLayout.contentInset(1080, 1380));
        assertEquals(0, TerminalLayout.contentInset(1380, 1380));
        // 平板:多出来的宽度对半分到两侧,内容正好居中在 460dp 内
        assertEquals(310, TerminalLayout.contentInset(2000, 1380));
        assertEquals(1310, TerminalLayout.contentInset(4000, 1380));
        // 异常输入不能返回负数,否则 setPadding 会把内容顶出屏幕
        assertEquals(0, TerminalLayout.contentInset(0, 1380));
        assertEquals(0, TerminalLayout.contentInset(-100, 1380));
        assertEquals(0, TerminalLayout.contentInset(2000, 0));
    }
}
