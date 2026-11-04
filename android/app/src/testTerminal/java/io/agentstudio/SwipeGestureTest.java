package io.agentstudio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class SwipeGestureTest {
    private static final float D = 56f;  // 阈值,按 1dp = 1px 取整

    @Test
    public void horizontalNeedsBothDistanceAndDominance() {
        assertTrue(SwipeGesture.isHorizontal(80, 5, D));
        assertTrue(SwipeGesture.isHorizontal(-80, 5, D));
        assertFalse("位移不够不算", SwipeGesture.isHorizontal(30, 0, D));
        assertFalse("纵向为主的斜拖不算,否则滚动会被误判成切换",
                SwipeGesture.isHorizontal(60, 50, D));
        assertFalse("纯纵向滚动不算", SwipeGesture.isHorizontal(0, 200, D));
    }

    @Test
    public void keyboardLayersWrapInBothDirections() {
        // 向左滑翻到后面一层,向右滑翻回前面一层。
        assertEquals(1, SwipeGesture.swipeToLayer(0, -80, 4));
        assertEquals(2, SwipeGesture.swipeToLayer(1, -80, 4));
        assertEquals(1, SwipeGesture.swipeToLayer(2, 80, 4));
        // 两端首尾相接:末层继续向左回到首层,首层向右滑到末层 ——
        // 取模只做一次会得到 -1,直接把组合键页滑成下标越界。
        assertEquals(0, SwipeGesture.swipeToLayer(3, -80, 4));
        assertEquals(3, SwipeGesture.swipeToLayer(0, 80, 4));
        // 层数非法时不能抛异常,更不能返回负下标
        assertEquals(0, SwipeGesture.swipeToLayer(0, 80, 0));
        assertEquals(0, SwipeGesture.swipeToLayer(2, -80, 1));
    }
}
