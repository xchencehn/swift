package io.agentstudio;

import android.content.Context;
import android.view.MotionEvent;
import android.widget.LinearLayout;

/**
 * 软键盘容器：横向滑动切换键盘层(小写 / 大写 / 符号 / 组合键),
 * 向左滑去下一层、向右滑回上一层,首尾相接。切换键仍然照旧可点。
 *
 * 层里铺满 Button,按键自己会消费触摸事件,所以判定必须放在
 * onInterceptTouchEvent 里:一旦认定是横向滑动就把事件截下来,被按住的那个键
 * 收到 ACTION_CANCEL,因此滑动不会顺带发出一次按键。
 *
 * 阈值与判据都取自 SwipeGesture,与终端、底栏的横向滑动手感一致。
 */
final class SwipeKeyboard extends LinearLayout {
    interface Listener {
        /** dx 为本次滑动的横向总位移,向右为正。方向语义由 SwipeGesture 决定。 */
        void onSwipe(float dx);
    }

    private final float swipeDistancePx;
    private float downX;
    private float downY;
    private boolean swiping;
    private Listener listener;

    SwipeKeyboard(Context context) {
        super(context);
        setOrientation(VERTICAL);
        swipeDistancePx = SwipeGesture.SWIPE_DISTANCE_DP
                * context.getResources().getDisplayMetrics().density;
    }

    void setSwipeListener(Listener value) {
        listener = value;
    }

    @Override
    public boolean onInterceptTouchEvent(MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                startTracking(event);
                return false;
            case MotionEvent.ACTION_MOVE:
                if (isHorizontalDrag(event)) {
                    swiping = true;
                    return true;
                }
                return false;
            default:
                return swiping;
        }
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                // 起点落在按键之间的空隙或组合键页的空行上时,DOWN 不经过拦截直接到这里。
                // 不在这里记下起点,后面算出来的位移就是拿上一次的起点减的。
                startTracking(event);
                return true;
            case MotionEvent.ACTION_MOVE:
                if (!swiping && isHorizontalDrag(event)) swiping = true;
                return true;
            case MotionEvent.ACTION_UP:
                float dx = event.getX() - downX;
                // 抬手时再按总位移确认一次:中途划出阈值又原路滑回来的,不该翻页。
                if (swiping && isHorizontalDrag(event) && listener != null) listener.onSwipe(dx);
                swiping = false;
                return true;
            case MotionEvent.ACTION_CANCEL:
                swiping = false;
                return true;
            default:
                return true;
        }
    }

    private void startTracking(MotionEvent event) {
        downX = event.getX();
        downY = event.getY();
        swiping = false;
    }

    private boolean isHorizontalDrag(MotionEvent event) {
        return SwipeGesture.isHorizontal(
                event.getX() - downX, event.getY() - downY, swipeDistancePx);
    }
}
