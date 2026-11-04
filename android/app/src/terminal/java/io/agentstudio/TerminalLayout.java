package io.agentstudio;



/** Pure layout calculations shared by terminal controls. */
final class TerminalLayout {
    private TerminalLayout() {}

    static int contentInset(int availableWidth, int maxContentWidth) {
        if (availableWidth <= 0 || maxContentWidth <= 0) return 0;
        return Math.max(0, (availableWidth - maxContentWidth) / 2);
    }

}
