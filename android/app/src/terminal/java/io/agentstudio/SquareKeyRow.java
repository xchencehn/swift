package io.agentstudio;

import android.content.Context;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;

/**
 * 按键为正方形的一行：行高取最窄按键的实测宽度，而不是写死 dp。
 *
 * 按键宽度由 weight 分配、随屏宽和横竖屏变化,所以行高只能等测完宽度才知道。
 * 写死行高会把按键拉成竖条 —— 这行有十颗单字符键,固定高度和分配到的宽度对不上,
 * 键就不再是方的。
 *
 * 曾经这里有个 `setSquare(boolean)` 开关,给「底栏收成一排」那套布局用:一排里按键
 * 有固定边长,再按宽度撑成正方形会让底栏随屏宽一起胀。一排/两排的判据现在整套去掉了
 * (底栏固定两行),所以开关也一并删掉,不留一个永远为 true 的字段。
 */
final class SquareKeyRow extends LinearLayout {
    SquareKeyRow(Context context) {
        super(context);
        setOrientation(HORIZONTAL);
        setGravity(Gravity.CENTER);
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        super.onMeasure(widthMeasureSpec, heightMeasureSpec);
        View narrowest = null;
        for (int index = 0; index < getChildCount(); index += 1) {
            View child = getChildAt(index);
            if (child.getVisibility() == GONE) continue;
            if (narrowest == null || child.getMeasuredWidth() < narrowest.getMeasuredWidth()) {
                narrowest = child;
            }
        }
        if (narrowest == null || narrowest.getMeasuredWidth() <= 0) return;
        LayoutParams params = (LayoutParams) narrowest.getLayoutParams();
        int height = narrowest.getMeasuredWidth()
                + getPaddingTop() + getPaddingBottom()
                + params.topMargin + params.bottomMargin;
        // 子项高度是 MATCH_PARENT，因此第二次测量会让每个按键正好收敛成正方形。
        super.onMeasure(widthMeasureSpec, MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY));
    }
}
