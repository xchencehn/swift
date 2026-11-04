package io.agentstudio;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Choreographer;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;

import com.termux.terminal.TerminalEmulator;
import com.termux.terminal.TerminalOutput;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

final class NativeTerminalView extends View {
    private static final long PTY_QUIET_WINDOW_MS = 12;
    private static final long PTY_MAX_FRAME_DELAY_MS = 40;


    interface OutputListener {
        void onOutput(byte[] bytes);
        void onResize(int columns, int rows);
        void onTerminalTap();
    }

    private final CjkTerminalRenderer renderer;
    private final TerminalEmulator emulator;
    private final OutputListener output;
    private final Choreographer choreographer = Choreographer.getInstance();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ByteArrayOutputStream pendingPty = new ByteArrayOutputStream();
    private final ByteArrayOutputStream batchedTerminalOutput = new ByteArrayOutputStream();
    private final java.util.List<Runnable> pendingConsumers = new java.util.ArrayList<>();
    private int topRow;
    private float lastY;
    private float scrollRemainder;
    private final int touchSlop;
    private float downX;
    private float downY;
    private boolean dragged;
    private boolean ptyFlushScheduled;
    private boolean wheelFrameScheduled;
    private boolean batchingTerminalOutput;
    private int pendingWheelRows;
    private int pendingWheelColumn = 1;
    private int pendingWheelRow = 1;
    private float dragVelocityPixelsPerMs;
    private long lastMoveTime;
    private final float swipeDistance;

    private final Choreographer.FrameCallback wheelFrameCallback;
    private final Runnable quietPtyFlush = this::flushPtyOutput;
    private final Runnable maximumPtyFlush = this::flushPtyOutput;

    NativeTerminalView(Context context, OutputListener output) {
        super(context);
        this.output = output;
        boolean phone = getResources().getConfiguration().smallestScreenWidthDp < 600;
        int textSize = Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_SP, phone ? 6 : 12, getResources().getDisplayMetrics()));
        renderer = new CjkTerminalRenderer(textSize, Typeface.MONOSPACE);
        TerminalOutput terminalOutput = new TerminalOutput() {
            @Override public void write(byte[] data, int offset, int count) {
                if (batchingTerminalOutput) {
                    batchedTerminalOutput.write(data, offset, count);
                    return;
                }
                byte[] copy = new byte[count];
                System.arraycopy(data, offset, copy, 0, count);
                output.onOutput(copy);
            }
            @Override public void titleChanged(String oldTitle, String newTitle) {}
            @Override public void onCopyTextToClipboard(String text) {}
            @Override public void onPasteTextFromClipboard() {}
            @Override public void onBell() {}
            @Override public void onColorsChanged() {}
        };
        emulator = new TerminalEmulator(
                terminalOutput, 80, 24, 10_000,
                new TerminalCallbacks(() -> {}));
        wheelFrameCallback = frameTimeNanos -> {
            wheelFrameScheduled = false;
            flushWheelInput(false);
        };
        setBackgroundColor(Color.rgb(5, 5, 5));
        setFocusable(false);
        setFocusableInTouchMode(false);
        touchSlop = ViewConfiguration.get(context).getScaledTouchSlop();
        swipeDistance = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP,
                SwipeGesture.SWIPE_DISTANCE_DP, getResources().getDisplayMetrics());
    }

    void append(byte[] bytes, Runnable consumed) {
        pendingConsumers.add(consumed);
        synchronized (pendingPty) {
            pendingPty.write(bytes, 0, bytes.length);
        }
        mainHandler.removeCallbacks(quietPtyFlush);
        mainHandler.postDelayed(quietPtyFlush, PTY_QUIET_WINDOW_MS);
        if (!ptyFlushScheduled) {
            ptyFlushScheduled = true;
            mainHandler.postDelayed(maximumPtyFlush, PTY_MAX_FRAME_DELAY_MS);
        }
    }

    private void flushPtyOutput() {
        mainHandler.removeCallbacks(quietPtyFlush);
        mainHandler.removeCallbacks(maximumPtyFlush);
        ptyFlushScheduled = false;
        byte[] bytes;
        synchronized (pendingPty) {
            bytes = pendingPty.toByteArray();
            pendingPty.reset();
        }
        if (bytes.length == 0) return;
        boolean followingLatest = topRow == 0;
        emulator.append(bytes, bytes.length);
        for (Runnable consumer : new java.util.ArrayList<>(pendingConsumers)) consumer.run();
        pendingConsumers.clear();
        if (followingLatest) topRow = 0;
        postInvalidateOnAnimation();
    }

    void sendText(String text) {
        output.onOutput(text.getBytes(StandardCharsets.UTF_8));
    }

    @Override
    protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight) {
        super.onSizeChanged(width, height, oldWidth, oldHeight);
        int columns = Math.max(20, (int) (width / cellWidth()));
        int rows = Math.max(5, height / renderer.getFontLineSpacing());
        emulator.resize(columns, rows);
        topRow = Math.max(-emulator.getScreen().getActiveTranscriptRows(), Math.min(0, topRow));
        output.onResize(columns, rows);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        renderer.render(emulator, canvas, topRow);
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downX = event.getX();
                downY = event.getY();
                lastY = event.getY();
                scrollRemainder = 0;
                dragged = false;
                pendingWheelRows = 0;
                dragVelocityPixelsPerMs = 0;
                lastMoveTime = event.getEventTime();
                getParent().requestDisallowInterceptTouchEvent(true);
                return true;
            case MotionEvent.ACTION_MOVE:
                if (!dragged && (Math.abs(event.getX() - downX) > touchSlop ||
                        Math.abs(event.getY() - downY) > touchSlop)) {
                    dragged = true;
                }
                float rawDistance = lastY - event.getY();
                float distance = rawDistance + scrollRemainder;
                long elapsed = Math.max(1, event.getEventTime() - lastMoveTime);
                dragVelocityPixelsPerMs = Math.abs(rawDistance) / elapsed;
                lastMoveTime = event.getEventTime();
                lastY = event.getY();
                int rows = (int) (distance / renderer.getFontLineSpacing());
                scrollRemainder = distance - rows * renderer.getFontLineSpacing();
                if (dragged && rows != 0) scrollRows(event.getX(), event.getY(), rows);
                return true;
            case MotionEvent.ACTION_UP:
                performClick();
                if (!dragged) {
                    output.onTerminalTap();
                    if (emulator.isMouseTrackingActive()) {
                        sendTerminalClick(event.getX(), event.getY());
                    }
                } else {
                    flushWheelInput(true);
                }
                getParent().requestDisallowInterceptTouchEvent(false);
                return true;
            case MotionEvent.ACTION_CANCEL:
                pendingWheelRows = 0;
                getParent().requestDisallowInterceptTouchEvent(false);
                return true;
            default:
                return true;
        }
    }


    private void sendTerminalClick(float x, float y) {
        int column = Math.max(1, Math.min(emulator.mColumns,
                (int) (x / cellWidth()) + 1));
        int row = Math.max(1, Math.min(emulator.mRows,
                (int) (y / renderer.getFontLineSpacing()) + 1));
        emulator.sendMouseEvent(TerminalEmulator.MOUSE_LEFT_BUTTON, column, row, true);
        emulator.sendMouseEvent(TerminalEmulator.MOUSE_LEFT_BUTTON, column, row, false);
    }

    @Override
    public boolean performClick() {
        super.performClick();
        return true;
    }

    private void scrollRows(float x, float y, int rows) {
        if (emulator.isAlternateBufferActive() || emulator.isMouseTrackingActive()) {
            pendingWheelRows = Math.max(-12, Math.min(12, pendingWheelRows + rows));
            pendingWheelColumn = Math.max(1, Math.min(emulator.mColumns,
                    (int) (x / cellWidth()) + 1));
            pendingWheelRow = Math.max(1, Math.min(emulator.mRows,
                    (int) (y / renderer.getFontLineSpacing()) + 1));
            if (!wheelFrameScheduled) {
                wheelFrameScheduled = true;
                choreographer.postFrameCallback(wheelFrameCallback);
            }
        } else {
            topRow = Math.max(-emulator.getScreen().getActiveTranscriptRows(),
                    Math.min(0, topRow + rows));
            invalidate();
        }
    }

    private void flushWheelInput(boolean gestureEnded) {
        int queued = pendingWheelRows;
        pendingWheelRows = 0;
        if (queued == 0) return;
        int limit;
        if (dragVelocityPixelsPerMs < 0.18f) limit = 1;
        else if (dragVelocityPixelsPerMs < 0.55f) limit = 2;
        else if (dragVelocityPixelsPerMs < 1.1f) limit = 4;
        else limit = 6;
        int steps = Math.min(Math.abs(queued), limit);
        int button = queued > 0
                ? TerminalEmulator.MOUSE_WHEELDOWN_BUTTON
                : TerminalEmulator.MOUSE_WHEELUP_BUTTON;
        batchingTerminalOutput = true;
        batchedTerminalOutput.reset();
        for (int i = 0; i < steps; i++) {
            emulator.sendMouseEvent(button, pendingWheelColumn, pendingWheelRow, true);
        }
        batchingTerminalOutput = false;
        byte[] bytes = batchedTerminalOutput.toByteArray();
        batchedTerminalOutput.reset();
        if (bytes.length > 0) output.onOutput(bytes);
        // Deliberately discard surplus on every frame and at gesture end. Stale
        // wheel input must never keep moving the TUI after the finger stops.
        if (gestureEnded) pendingWheelRows = 0;
    }

    @Override
    protected void onDetachedFromWindow() {
        choreographer.removeFrameCallback(wheelFrameCallback);
        mainHandler.removeCallbacks(quietPtyFlush);
        mainHandler.removeCallbacks(maximumPtyFlush);
        ptyFlushScheduled = false;
        wheelFrameScheduled = false;
        super.onDetachedFromWindow();
    }

    private float cellWidth() {
        return renderer.getFontWidth();
    }
}
