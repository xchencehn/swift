package io.agentstudio;

import android.util.Log;

import com.termux.terminal.TerminalSession;
import com.termux.terminal.TerminalSessionClient;

final class TerminalCallbacks implements TerminalSessionClient {
    private final Runnable redraw;

    TerminalCallbacks(Runnable redraw) {
        this.redraw = redraw;
    }

    @Override public void onTextChanged(TerminalSession session) { redraw.run(); }
    @Override public void onTitleChanged(TerminalSession session) {}
    @Override public void onSessionFinished(TerminalSession session) {}
    @Override public void onCopyTextToClipboard(TerminalSession session, String text) {}
    @Override public void onPasteTextFromClipboard(TerminalSession session) {}
    @Override public void onBell(TerminalSession session) {}
    @Override public void onColorsChanged(TerminalSession session) { redraw.run(); }
    @Override public void onTerminalCursorStateChange(boolean state) { redraw.run(); }
    @Override public Integer getTerminalCursorStyle() { return null; }
    @Override public void logError(String tag, String message) { Log.e(tag, message); }
    @Override public void logWarn(String tag, String message) { Log.w(tag, message); }
    @Override public void logInfo(String tag, String message) { Log.i(tag, message); }
    @Override public void logDebug(String tag, String message) { Log.d(tag, message); }
    @Override public void logVerbose(String tag, String message) { Log.v(tag, message); }
    @Override public void logStackTraceWithMessage(String tag, String message, Exception e) {
        Log.e(tag, message, e);
    }
    @Override public void logStackTrace(String tag, Exception e) { Log.e(tag, "terminal", e); }
}
