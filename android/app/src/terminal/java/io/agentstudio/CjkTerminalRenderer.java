package io.agentstudio;

import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.Typeface;

import com.termux.terminal.TerminalBuffer;
import com.termux.terminal.TerminalEmulator;
import com.termux.terminal.TerminalRow;
import com.termux.terminal.TextStyle;
import com.termux.terminal.WcWidth;

/**
 * Termux-compatible renderer that preserves the natural aspect ratio of CJK
 * glyphs supplied by Android's system font fallback.
 */
final class CjkTerminalRenderer {
    private final Paint paint = new Paint();
    private final float fontWidth;
    private final int lineSpacing;
    private final int fontAscent;
    private final int lineSpacingAndAscent;
    private final float[] asciiMeasures = new float[127];

    CjkTerminalRenderer(int textSize, Typeface typeface) {
        paint.setTypeface(typeface);
        paint.setAntiAlias(true);
        paint.setSubpixelText(true);
        paint.setTextSize(textSize);
        lineSpacing = (int) Math.ceil(paint.getFontSpacing());
        fontAscent = (int) Math.ceil(paint.ascent());
        lineSpacingAndAscent = lineSpacing + fontAscent;
        fontWidth = paint.measureText("X");
        StringBuilder value = new StringBuilder(" ");
        for (int i = 0; i < asciiMeasures.length; i++) {
            value.setCharAt(0, (char) i);
            asciiMeasures[i] = paint.measureText(value, 0, 1);
        }
    }

    void render(TerminalEmulator emulator, Canvas canvas, int topRow) {
        boolean reverseVideo = emulator.isReverseVideo();
        int endRow = topRow + emulator.mRows;
        int columns = emulator.mColumns;
        int cursorCol = emulator.getCursorCol();
        int cursorRow = emulator.getCursorRow();
        boolean cursorVisible = emulator.shouldCursorBeVisible();
        TerminalBuffer screen = emulator.getScreen();
        int[] palette = emulator.mColors.mCurrentColors;
        int cursorShape = emulator.getCursorStyle();
        if (reverseVideo) {
            canvas.drawColor(palette[TextStyle.COLOR_INDEX_FOREGROUND], PorterDuff.Mode.SRC);
        }

        float y = lineSpacingAndAscent;
        for (int row = topRow; row < endRow; row++) {
            y += lineSpacing;
            int cursorX = row == cursorRow && cursorVisible ? cursorCol : -1;
            TerminalRow terminalRow =
                    screen.allocateFullLineIfNecessary(screen.externalToInternalRow(row));
            char[] text = terminalRow.mText;
            int charsUsed = terminalRow.getSpaceUsed();
            int charIndex = 0;
            for (int column = 0; column < columns && charIndex < charsUsed;) {
                int codePoint = Character.codePointAt(text, charIndex, charsUsed);
                int charCount = Character.charCount(codePoint);
                int cellCount = Math.max(1, WcWidth.width(codePoint));
                int runStartIndex = charIndex;
                int runStartColumn = column;
                long style = terminalRow.getStyle(column);
                boolean cursor = cursorX == column ||
                        (cellCount == 2 && cursorX == column + 1);
                boolean preserveCjk = isCjk(codePoint);
                float measured = measure(text, charIndex, charCount, codePoint);

                charIndex += charCount;
                while (charIndex < charsUsed && WcWidth.width(text, charIndex) <= 0) {
                    charIndex += Character.isHighSurrogate(text[charIndex]) ? 2 : 1;
                }
                column += cellCount;

                // Keep ordinary same-style, same-width ASCII in one draw call.
                if (!preserveCjk && !cursor &&
                        Math.abs(measured / fontWidth - cellCount) <= 0.01f) {
                    while (column < columns && charIndex < charsUsed) {
                        int next = Character.codePointAt(text, charIndex, charsUsed);
                        int nextChars = Character.charCount(next);
                        int nextCells = Math.max(1, WcWidth.width(next));
                        if (isCjk(next) || terminalRow.getStyle(column) != style ||
                                cursorX == column ||
                                Math.abs(measure(text, charIndex, nextChars, next) /
                                        fontWidth - nextCells) > 0.01f) {
                            break;
                        }
                        measured += measure(text, charIndex, nextChars, next);
                        charIndex += nextChars;
                        while (charIndex < charsUsed && WcWidth.width(text, charIndex) <= 0) {
                            charIndex += Character.isHighSurrogate(text[charIndex]) ? 2 : 1;
                        }
                        column += nextCells;
                    }
                }

                drawRun(canvas, text, palette, y, runStartColumn,
                        column - runStartColumn, runStartIndex,
                        charIndex - runStartIndex, measured,
                        cursor ? emulator.mColors.mCurrentColors[
                                TextStyle.COLOR_INDEX_CURSOR] : 0,
                        cursorShape, style, reverseVideo, preserveCjk);
            }
        }
    }

    private float measure(char[] text, int index, int count, int codePoint) {
        return codePoint < asciiMeasures.length
                ? asciiMeasures[codePoint]
                : paint.measureText(text, index, count);
    }

    private void drawRun(Canvas canvas, char[] text, int[] palette, float y,
                         int startColumn, int widthColumns, int startIndex,
                         int widthChars, float measuredWidth, int cursor,
                         int cursorStyle, long style, boolean reverseVideo,
                         boolean preserveCjk) {
        int foreground = TextStyle.decodeForeColor(style);
        int background = TextStyle.decodeBackColor(style);
        int effect = TextStyle.decodeEffect(style);
        boolean bold = (effect & (TextStyle.CHARACTER_ATTRIBUTE_BOLD |
                TextStyle.CHARACTER_ATTRIBUTE_BLINK)) != 0;
        if ((foreground & 0xff000000) != 0xff000000) {
            if (bold && foreground >= 0 && foreground < 8) foreground += 8;
            foreground = palette[foreground];
        }
        if ((background & 0xff000000) != 0xff000000) background = palette[background];
        if (reverseVideo ^ (effect & TextStyle.CHARACTER_ATTRIBUTE_INVERSE) != 0) {
            int swap = foreground;
            foreground = background;
            background = swap;
        }

        float left = startColumn * fontWidth;
        float right = left + widthColumns * fontWidth;
        if (background != palette[TextStyle.COLOR_INDEX_BACKGROUND]) {
            paint.setColor(background);
            canvas.drawRect(left, y - lineSpacingAndAscent + fontAscent, right, y, paint);
        }
        if (cursor != 0) {
            paint.setColor(cursor);
            float cursorHeight = lineSpacingAndAscent - fontAscent;
            if (cursorStyle == TerminalEmulator.TERMINAL_CURSOR_STYLE_UNDERLINE) {
                cursorHeight /= 4f;
            } else if (cursorStyle == TerminalEmulator.TERMINAL_CURSOR_STYLE_BAR) {
                right -= (right - left) * 0.75f;
            }
            canvas.drawRect(left, y - cursorHeight, right, y, paint);
        }
        if ((effect & TextStyle.CHARACTER_ATTRIBUTE_INVISIBLE) != 0) return;
        if ((effect & TextStyle.CHARACTER_ATTRIBUTE_DIM) != 0) {
            int red = ((foreground >> 16) & 0xff) * 2 / 3;
            int green = ((foreground >> 8) & 0xff) * 2 / 3;
            int blue = (foreground & 0xff) * 2 / 3;
            foreground = 0xff000000 | red << 16 | green << 8 | blue;
        }
        paint.setFakeBoldText(bold);
        paint.setUnderlineText((effect & TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE) != 0);
        paint.setTextSkewX((effect & TextStyle.CHARACTER_ATTRIBUTE_ITALIC) != 0
                ? -0.35f : 0f);
        paint.setStrikeThruText(
                (effect & TextStyle.CHARACTER_ATTRIBUTE_STRIKETHROUGH) != 0);
        paint.setColor(foreground);
        float baseline = y - lineSpacingAndAscent;
        float expectedWidth = widthColumns * fontWidth;
        if (preserveCjk) {
            // The system fallback glyph keeps its natural shape and is centered
            // in the two terminal cells reserved by wcwidth().
            float naturalLeft = left + (expectedWidth - measuredWidth) / 2f;
            canvas.drawText(text, startIndex, widthChars, naturalLeft, baseline, paint);
        } else if (Math.abs(measuredWidth - expectedWidth) > fontWidth * 0.01f) {
            canvas.save();
            float scale = expectedWidth / measuredWidth;
            canvas.scale(scale, 1f);
            canvas.drawText(text, startIndex, widthChars, left / scale, baseline, paint);
            canvas.restore();
        } else {
            canvas.drawText(text, startIndex, widthChars, left, baseline, paint);
        }
    }

    private boolean isCjk(int codePoint) {
        return codePoint >= 0x2e80 && codePoint <= 0x2fdf ||
                codePoint >= 0x3000 && codePoint <= 0x303f ||
                codePoint >= 0x31c0 && codePoint <= 0x31ef ||
                codePoint >= 0x3400 && codePoint <= 0x4dbf ||
                codePoint >= 0x4e00 && codePoint <= 0x9fff ||
                codePoint >= 0xf900 && codePoint <= 0xfaff ||
                codePoint >= 0x20000 && codePoint <= 0x323af ||
                codePoint >= 0xff00 && codePoint <= 0xffef;
    }

    float getFontWidth() {
        return fontWidth;
    }

    int getFontLineSpacing() {
        return lineSpacing;
    }
}
