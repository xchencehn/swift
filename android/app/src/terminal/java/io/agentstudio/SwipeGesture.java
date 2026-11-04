package io.agentstudio;

/**
 * 横向滑动的判定。刻意不引用任何 Android 类型,这样能在纯 JVM 单元测试里跑 ——
 * 本机既没有 ADB 设备也没有模拟器,手势只能靠这一层的测试兜住。
 *
 * 这个 APP 里的横向滑动只剩两处,判据互不重叠:
 *
 *   区域            手势        动作
 *   终端右上四分之一  水平滑动     切换标签页(NativeTerminalView 自己处理)
 *   软键盘          水平滑动     切换键盘层(SwipeKeyboard 自己处理)
 *
 * ⚠️ 另外两套都已删除,别再照着旧注释找它们:
 *   - 底栏的「左滑收起、右滑展开输入行」连同「一排还是两排」的判据 —— 底栏现在
 *     固定两行、输入行常驻,没有要展开的东西。
 *   - 「终端 ↔ 会话」—— 会话曾经是同一个 APP 里的另一个视图,2026-09-18 拆成
 *     两个独立 APP 之后这条手势没有去处了,换 APP 走系统的任务切换。
 */
final class SwipeGesture {
    /** 判定为横向滑动所需的最小位移,与切标签的阈值取同一个值,手感才一致。 */
    static final int SWIPE_DISTANCE_DP = 56;

    private SwipeGesture() {}

    /**
     * 这一次拖动是不是「横向」的。要求横向分量既超过阈值,又明显大于纵向分量 ——
     * 只看横向分量会把斜着的滚动误判成切换。
     */
    static boolean isHorizontal(float dx, float dy, float distancePx) {
        return Math.abs(dx) >= distancePx && Math.abs(dx) > Math.abs(dy) * 1.5f;
    }

    /**
     * 软键盘上横向滑动之后落到第几层。
     *
     * 方向与翻页一致:向左滑(dx < 0)是把后面一层拉过来,也就是去下一层;向右滑回上一层。
     * 两端首尾相接,和切换键点一圈走的是同一个环,只是滑动可以反着走。
     */
    static int swipeToLayer(int current, float dx, int layerCount) {
        if (layerCount <= 0) return 0;
        int next = current + (dx < 0 ? 1 : -1);
        // Java 的 % 对负数返回负值,不取模两次会滑出下标范围。
        return ((next % layerCount) + layerCount) % layerCount;
    }

}
