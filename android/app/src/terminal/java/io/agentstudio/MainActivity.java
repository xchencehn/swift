package io.agentstudio;

import android.app.Activity;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.Toast;

import java.util.List;

public final class MainActivity extends Activity {
    private static final String TAG = "HerdrTerminal";
    private static final int BG = Color.rgb(9, 9, 11);
    private static final int KEY_BG = Color.rgb(39, 39, 42);
    private static final int KEY_TEXT = Color.rgb(244, 244, 245);
    /** 底栏内容的最大宽度,与网页端的 max-width: 460px 对齐。 */
    private static final int DECK_MAX_WIDTH_DP = 460;
    /**
     * 底栏快捷键行:Esc / Tab / 方向键 / 斜杠 / 退格 / Enter,见 buildShortcutRow()。
     *
     * 🔑 这排键曾被换成「推理档位 / 停止推理 / 恢复会话」三颗功能钮,理由是「方向键
     * 只是手段,人要的是那三件事」。那个判断**只对网页会话版成立**:会话版收发的是
     * 整条消息,没有光标可挪。终端版操作的对象就是终端本身 —— agent 的 TUI 要靠方向键
     * 选项目、靠 Esc 退出、靠斜杠起命令,手机软键盘又打不出这些键,拿掉就等于没法操作。
     * 所以终端版保留这排键,三颗功能钮只留在网页会话版,两边刻意不一致。
     */
    /** 软键盘层数：小写、大写、符号、组合键。 */
    private static final int LAYER_COUNT = 4;
    /** 组合键页沿用字符页的八列栅格，单键占两列。 */
    private static final float COMBO_ROW_COLUMNS = 8f;
    private static final float COMBO_KEY_WIDTH = 2f;
    /**
     * 组合键页：手机软键盘打不出来、但在 Codex 和 Claude Code 里要用的键。
     * 每项为 {按键标签, 发往 PTY 的字节, 长按提示}。
     *
     * 序列用 xterm 的 CSI 修饰符格式。已实测 Node 的 readline 把 `ESC [1;3A` 解析成
     * 「up + meta」、把 `ESC [Z` 解析成「tab + shift」；而 `ESC ESC [A` 那种写法
     * meta 修饰符会丢失，解析结果与普通方向键无异，**不要用**。
     *
     * Ctrl 系按键不走 CSI，直接发对应的控制字符：Ctrl+C 是 0x03，由远端 PTY 的
     * 行规程翻成 SIGINT，所以它中断的是前台进程本身，与在真键盘上按一样。
     */
    private static final String[][][] COMBO_ROWS = {
            {
                    {"Ctrl+C", "\u0003",
                            "Ctrl+C：向前台进程发 SIGINT，打断正在跑的命令或正在生成的回答"},
                    {"\u21e7Tab", "\u001b[Z",
                            "Shift+Tab：Claude Code 循环切换权限模式 default / acceptEdits / plan"},
                    {"Alt+\u2191", "\u001b[1;3A",
                            "Alt+\u2191：CSI 1;3A，终端里解析为 up 带 meta 修饰符"},
                    {"\u21e7\u2191", "\u001b[1;2A", "Shift+上方向键"},
            },
            // 空行占位：各页必须等高，否则切页时终端跟着变高、TUI 会重排。
            // 往后加组合键就是把它们填进这几行。
            {
                    {"Ctrl+A", "\u0001", "移到行首"},
                    {"Ctrl+E", "\u0005", "移到行尾"},
                    {"Ctrl+L", "\u000c", "清屏"},
                    {"Ctrl+D", "\u0004", "Ctrl+D"},
            }, {}, {},
    };

    private HerdrConnection connection;
    private NativeTerminalView terminal;
    private SwipeKeyboard keyboard;
    private LinearLayout deck;
    private View inputRow;
    private int keyboardLayer;
    private boolean imeWasVisible;
    private boolean landscapeTerminalMode;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (!io.agentstudio.connection.ConnectionRuntime.require(this)) return;
        landscapeTerminalMode = getResources().getConfiguration().orientation ==
                Configuration.ORIENTATION_LANDSCAPE;
        getWindow().setStatusBarColor(Color.rgb(5, 5, 5));
        getWindow().setNavigationBarColor(BG);

        connection = new HerdrConnection(
                io.agentstudio.connection.ConnectionRuntime.baseUrl(),
                io.agentstudio.connection.ConnectionRuntime.token(),
                new HerdrConnection.Listener() {
                    @Override public void onBytes(byte[] bytes, Runnable consumed) { terminal.append(bytes, consumed); }
                    // 终端界面刻意不显示任何状态气泡；状态只写入 logcat 供排障使用。
                    @Override public void onState(String value) { Log.i(TAG, value); }
                    @Override public void onUnauthorized() { io.agentstudio.connection.ConnectionRuntime.rejected(MainActivity.this); }
                });

        FrameLayout root = new FrameLayout(this);
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setBackgroundColor(BG);
        column.setFitsSystemWindows(!landscapeTerminalMode);
        root.addView(column, match());

        terminal = new NativeTerminalView(this, new NativeTerminalView.OutputListener() {
            @Override public void onOutput(byte[] bytes) { connection.send(bytes); }
            @Override public void onResize(int columns, int rows) {
                connection.resize(columns, rows);
            }
            @Override public void onTerminalTap() {
                hideSystemKeyboard();
            }
        });
        // 这个 APP 只有终端。会话是**另一个 APP**(`io.swift.chat`),
        // 所以这里既不嵌 WebView,也没有「滑动切到会话」那回事 —— 用系统的任务切换来回。
        FrameLayout stage = new FrameLayout(this);
        stage.addView(terminal, match());

        column.addView(stage, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

        {
            // 底栏固定两行:上面快捷键,下面输入框,两行都常驻。
            //
            // 这里以前按可用宽度在「一排紧凑」和「两排」之间选,宽屏收成一排。那套判据
            // 连同它的手势(左滑收起、右滑展开输入行)已整套删掉:底栏是打字和按键的地方,
            // 让它自己变形、还得先滑一下才出现输入框,等于每次用都要先想一下现在是哪种形态。
            //
            // 按键是正方形的(行高取实测按键宽度,见 SquareKeyRow),所以要限宽居中 ——
            // 不限宽的话屏幕越宽按键越高,横屏和平板上底栏会胀掉半个屏。
            int widthPx = getResources().getDisplayMetrics().widthPixels;
            int inset = TerminalLayout.contentInset(widthPx, dp(DECK_MAX_WIDTH_DP));

            keyboard = new SwipeKeyboard(this);
            keyboard.setPadding(inset + dp(4), dp(4), inset + dp(4), dp(4));
            // 横向滑动切换键盘层;切换键点一圈走的是同一个环,滑动只是能反着走。
            keyboard.setSwipeListener(dx -> {
                keyboardLayer = SwipeGesture.swipeToLayer(keyboardLayer, dx, LAYER_COUNT);
                renderKeyboard();
            });
            keyboard.setBackgroundColor(BG);
            keyboard.setVisibility(View.GONE);
            column.addView(keyboard, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

            deck = new LinearLayout(this);
            deck.setOrientation(LinearLayout.VERTICAL);
            deck.setBackgroundColor(BG);
            deck.setPadding(inset, 0, inset, 0);
            // 快捷键行的高度必须给 WRAP_CONTENT:它由 SquareKeyRow 按实测按键宽度决定,
            // 写死高度就会把按键拉成竖条。
            deck.addView(buildShortcutRow(), new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            inputRow = buildInputRow();
            deck.addView(inputRow, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, dp(52)));
            column.addView(deck, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        }

        setContentView(root);
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::showConnectionActions);
        }
        // 横屏仍然进沉浸式全屏(系统栏让位给终端),底栏照常是两行。
        if (landscapeTerminalMode) root.post(this::enterLandscapeFullscreen);
        observeImeVisibility(root);
        renderKeyboard();
    }

    // API 33+ uses the platform callback; older Android keeps the legacy callback.
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Override public void onBackPressed() { showConnectionActions(); }

    private void showConnectionActions() {
        new android.app.AlertDialog.Builder(this).setItems(new String[]{"连接设置", "退出终端"}, (dialog, which) -> {
            if (which == 0) io.agentstudio.connection.ConnectionRuntime.settings(this); else finish();
        }).show();
    }

    @Override protected void onStart() {
        super.onStart();
        io.agentstudio.connection.ConnectionRuntime.wake();
        if (connection != null) connection.start();
    }

    @Override protected void onStop() {
        if (connection != null) connection.stop();
        io.agentstudio.connection.ConnectionRuntime.background();
        super.onStop();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && landscapeTerminalMode) enterLandscapeFullscreen();
    }

    private SquareKeyRow buildShortcutRow() {
        SquareKeyRow row = squareKeyRow();
        addKey(row, "Esc", "\u001b", 1);
        addKey(row, "Tab", "\t", 1);
        addKey(row, "↑", "\u001b[A", 1);
        addKey(row, "↓", "\u001b[B", 1);
        addKey(row, "←", "\u001b[D", 1);
        addKey(row, "→", "\u001b[C", 1);
        addKey(row, "/", "/", 1);
        addKey(row, "⌫", "\u007f", 1);
        // Enter 标签有五个字符,给 1.2 倍宽才不被挤成一条。
        addKey(row, "Enter", "\r", 1.2f);
        // ⋯ 打开字符与组合键面板:手机软键盘上打不出的符号、⇧Tab、Ctrl+C 都在那里,
        // 它是这排方向键之外的第二个入口,不是同一批东西。
        Button more = key("⋯");
        more.setOnClickListener(view -> {
            keyboard.setVisibility(keyboard.getVisibility() == View.VISIBLE
                    ? View.GONE : View.VISIBLE);
        });
        row.addView(more, weighted(1));
        return row;
    }

    private View buildInputRow() {
        LinearLayout row = keyRow();
        row.setPadding(dp(6), dp(6), dp(6), dp(6));
        EditText input = new EditText(this);
        input.setSingleLine(false);
        input.setMaxLines(2);
        input.setTextColor(KEY_TEXT);
        input.setTextSize(14);
        input.setHint("");
        input.setPadding(dp(10), 0, dp(8), 0);
        input.setBackground(rounded(Color.rgb(24, 24, 27), 9));
        input.setInputType(InputType.TYPE_CLASS_TEXT |
                InputType.TYPE_TEXT_FLAG_MULTI_LINE |
                InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        row.addView(input, new LinearLayout.LayoutParams(0, dp(38), 1));
        // 「填入」只把文本写进终端的输入框,不替你按回车 —— 发送是第二步,由上面那排
        // 快捷键里的 Enter 完成。这两段之前被合并成一颗按钮(填入即发送),结果是同一颗
        // 按钮有时把话直接发出去、有时只是填进去,取决于 agent 当时在不在跑;分成两段
        // 之后行为恒定,填进去之后还能在终端里接着改。
        Button fill = key("填入");
        fill.setTextSize(13);
        fill.setOnClickListener(view -> {
            String value = input.getText().toString();
            if (!value.isEmpty()) {
                terminal.sendText(value);
                input.setText("");
            }
        });
        LinearLayout.LayoutParams fillParams = new LinearLayout.LayoutParams(dp(56), dp(38));
        fillParams.leftMargin = dp(6);
        row.addView(fill, fillParams);
        input.setOnFocusChangeListener((view, focused) -> {
            if (focused) keyboard.setVisibility(View.GONE);
        });
        return row;
    }

    private void renderKeyboard() {
        keyboard.removeAllViews();
        // mode 是**下一层**的名字，也就是按下切换键会去到哪里。
        String mode;
        if (keyboardLayer == 0) {
            addCharacterRows(List.of("1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"));
            mode = "ABC";
        } else if (keyboardLayer == 1) {
            addCharacterRows(List.of("1234567890", "QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"));
            mode = "#+=";
        } else if (keyboardLayer == 2) {
            addCharacterRows(List.of("1234567890", "!\"$%&'(),:", ";<=>?[\\]^_", "`{|}~"));
            mode = "组合";
        } else {
            addComboRows();
            mode = "abc";
        }

        LinearLayout common = keyRow();
        // 这个环也可以在键盘上横向滑动来走,见 SwipeKeyboard。
        Button switcher = key(mode);
        switcher.setOnClickListener(view -> {
            keyboardLayer = (keyboardLayer + 1) % LAYER_COUNT;
            renderKeyboard();
        });
        common.addView(switcher, weighted(1.2f));
        for (String value : List.of("@", "#", "+", "-")) addKey(common, value, value, 1);
        addKey(common, "空格", " ", 2.4f);
        for (String value : List.of("*", "/", ".")) addKey(common, value, value, 1);
        keyboard.addView(common, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(46)));
    }

    private void addCharacterRows(List<String> lines) {
        for (String line : lines) {
            LinearLayout row = keyRow();
            for (int offset = 0; offset < line.length();) {
                int point = line.codePointAt(offset);
                String value = new String(Character.toChars(point));
                addKey(row, value, value, 1);
                offset += Character.charCount(point);
            }
            keyboard.addView(row, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, dp(42)));
        }
    }

    private void addComboRows() {
        for (String[][] line : COMBO_ROWS) {
            LinearLayout row = keyRow();
            // 每个组合键占两格字符键的宽度，余下的对半分到两侧，
            // 否则两个键会各自横跨半个屏幕。
            float spare = Math.max(0f, COMBO_ROW_COLUMNS - line.length * COMBO_KEY_WIDTH) / 2f;
            if (spare > 0) row.addView(new View(this), weighted(spare));
            for (String[] combo : line) {
                addComboKey(row, combo[0], combo[1], combo[2]);
            }
            if (spare > 0) row.addView(new View(this), weighted(spare));
            keyboard.addView(row, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, dp(42)));
        }
    }

    private void addComboKey(LinearLayout row, String label, String sequence, String hint) {
        addHintedKey(row, label, sequence, hint, COMBO_KEY_WIDTH);
    }

    /** 点一下发出对应字节，长按说明它做什么 —— 组合键页和底栏功能钮都是这个行为。 */
    private void addHintedKey(LinearLayout row, String label, String sequence, String hint,
                              float weight) {
        Button button = key(label);
        button.setOnClickListener(view -> terminal.sendText(sequence));
        button.setOnLongClickListener(view -> {
            Toast.makeText(this, label + "\u3000" + hint, Toast.LENGTH_LONG).show();
            return true;
        });
        row.addView(button, weighted(weight));
    }

    private void addKey(LinearLayout row, String label, String value, float weight) {
        Button button = key(label);
        button.setOnClickListener(view -> terminal.sendText(value));
        row.addView(button, weighted(weight));
    }

    private Button key(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(KEY_TEXT);
        button.setTextSize(label.length() > 3 ? 12 : 15);
        button.setAllCaps(false);
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setMinHeight(0);
        button.setMinimumHeight(0);
        button.setPadding(dp(2), 0, dp(2), 0);
        button.setBackground(rounded(KEY_BG, 9));
        return button;
    }

    private SquareKeyRow squareKeyRow() {
        SquareKeyRow row = new SquareKeyRow(this);
        row.setPadding(dp(2), dp(2), dp(2), dp(2));
        return row;
    }

    private LinearLayout keyRow() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER);
        row.setPadding(dp(2), dp(2), dp(2), dp(2));
        return row;
    }

    private LinearLayout.LayoutParams weighted(float weight) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.MATCH_PARENT, weight);
        params.setMargins(dp(2), dp(1), dp(2), dp(1));
        return params;
    }

    private void hideSystemKeyboard() {
        View focused = getCurrentFocus();
        if (focused != null) {
            ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE))
                    .hideSoftInputFromWindow(focused.getWindowToken(), 0);
            focused.clearFocus();
        }
    }

    private void observeImeVisibility(View root) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                updateImeVisibility(insets.isVisible(WindowInsets.Type.ime()));
                return insets;
            });
            return;
        }
        root.getViewTreeObserver().addOnGlobalLayoutListener(() -> {
            Rect visibleArea = new Rect();
            root.getWindowVisibleDisplayFrame(visibleArea);
            int obscuredHeight = root.getRootView().getHeight() - visibleArea.bottom;
            updateImeVisibility(obscuredHeight > root.getRootView().getHeight() * 0.18f);
        });
    }

    private void updateImeVisibility(boolean visible) {
        if (imeWasVisible && !visible) {
            // ⚠️ 只收字符面板,**不要动 inputRow**:输入行现在是常驻的,在这里把它隐掉
            // 就等于点一次「填入」之后再也看不到输入框(这条路径正是当初那个 bug 的来源)。
            if (keyboard != null) keyboard.setVisibility(View.GONE);
        }
        imeWasVisible = visible;
    }

    private void enterLandscapeFullscreen() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
                        View.SYSTEM_UI_FLAG_FULLSCREEN |
                        View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
                        View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
                        View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
                        View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    private GradientDrawable rounded(int color, int radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radiusDp));
        return drawable;
    }

    private FrameLayout.LayoutParams match() {
        return new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
