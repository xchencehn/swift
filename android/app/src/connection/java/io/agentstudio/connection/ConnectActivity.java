package io.agentstudio.connection;

import android.app.*;
import android.os.*;
import android.content.*;
import android.graphics.Color;
import android.text.InputType;
import android.view.*;
import android.widget.*;
import java.util.concurrent.*;
import org.json.JSONArray;
import org.json.JSONObject;

/** Official account login and discovery, with independent manual direct and pairing connections. */
public final class ConnectActivity extends Activity {
    private TextView status;
    private EditText name, token, invitation, relayCode;
    private Button scan, pair;
    private Button connect;
    private LinearLayout savedList;

    private EditText directAddress;
    private Button directConnect;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean destroyed;
    private boolean connecting;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (!getIntent().getBooleanExtra("settings", false) && ConnectionRuntime.requireSaved(this)) { launch(); return; }
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true);
        LinearLayout page = new LinearLayout(this); page.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (24 * getResources().getDisplayMetrics().density); page.setPadding(pad, pad, pad, pad);
        page.setBackgroundColor(Color.rgb(23, 23, 26));
        TextView title = new TextView(this); title.setText("Swift"); title.setTextSize(26); title.setTextColor(Color.WHITE); page.addView(title);
        status = new TextView(this); status.setTextSize(16); status.setTextColor(Color.LTGRAY); status.setPadding(0, pad / 2, 0, pad / 2);
        status.setText("本机直接连接；局域网请粘贴服务器执行 swift 后显示的完整连接链接。"); page.addView(status);
        savedList = new LinearLayout(this); savedList.setOrientation(LinearLayout.VERTICAL); page.addView(savedList);
        LinearLayout rootPage = page;
        LinearLayout manual = new LinearLayout(this); manual.setOrientation(LinearLayout.VERTICAL); manual.setVisibility(View.VISIBLE);
        page.addView(manual);
        directAddress = field(manual, "直连服务器地址", "http://192.168.1.10:8792/swift", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        directConnect = button(manual, "直接连接", v -> direct());
        renderProfiles();
        scroll.addView(rootPage); setContentView(scroll);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if (getIntent().getBooleanExtra("rejected", false)) status.setText("连接 token 不正确或已失效，请重新粘贴服务器显示的完整连接链接。");
    }
    private void renderProfiles() {
        savedList.removeAllViews();
        try {
            JSONObject state = new JSONObject(ConnectionProfiles.publicProfiles(this));
            if (state.has("error")) { status.setText(state.getString("error")); return; }
            JSONArray profiles = state.getJSONArray("profiles");
            for (int i=0;i<profiles.length();i++) {
                JSONObject profile=profiles.getJSONObject(i);
                String id=profile.getString("id"), label=profile.getString("name");
                boolean remote=profile.getString("mode").equals("remote"), paired=profile.getString("mode").equals("paired"), direct=profile.getString("mode").equals("direct"), account=profile.getString("mode").equals("account");
                TextView caption=new TextView(this); caption.setText(label+(state.optString("active").equals(id)?" · 当前":"")
                        +(account?" · Swift 账号":paired?" · 端到端加密":remote?" · 旧版管理端":direct?" · 直接连接":" · 请重新添加")); caption.setTextColor(Color.LTGRAY); caption.setPadding(0,12,0,4); savedList.addView(caption);
                LinearLayout actions=new LinearLayout(this); savedList.addView(actions);
                Button open=button(actions,"连接 "+label,v->activate(id)); open.setEnabled((remote||paired||direct||account)&&!connecting);
                button(actions,"移除 "+label,v->new AlertDialog.Builder(this).setMessage("移除服务端“"+label+"”？")
                        .setNegativeButton("取消",null).setPositiveButton("移除",(d,w)->{
                            try { if(ConnectionProfiles.remove(this,id)) ConnectionRuntime.close(); renderProfiles(); }
                            catch(Exception error){status.setText(ConnectionProfiles.errorMessage(error));}
                        }).show()).setEnabled(!connecting);
            }
        } catch(Exception error){status.setText("无法读取已保存的服务端。");}
    }
    private EditText field(LinearLayout page, String label, String hint, int inputType) {
        TextView caption = new TextView(this); caption.setText(label); caption.setTextColor(Color.LTGRAY); page.addView(caption);
        EditText field = new EditText(this); field.setContentDescription(label); field.setHint(hint); field.setTextColor(Color.WHITE);
        field.setHintTextColor(Color.GRAY); field.setInputType(inputType); field.setSingleLine(true); page.addView(field); return field;
    }
    private Button button(LinearLayout page, String text, View.OnClickListener action) { Button b = new Button(this); b.setText(text); b.setOnClickListener(action); page.addView(b); return b; }
    private void busy(boolean value) {
        connecting=value;
            renderProfiles();
        directAddress.setEnabled(!value); directConnect.setEnabled(!value);
    }
    private interface CheckedSave { void save(TokenConnection connection) throws Exception; }
    private void direct() {
        if (connecting) return; final String address = directAddress.getText().toString(); busy(true); status.setText("正在连接服务器…");
        worker.execute(() -> {
            try { TokenConnection connection = new TokenConnection(address, "", true);
                JSONObject config = new JSONObject(connection.verify()); if (!config.optBoolean("ok") || !config.optString("role").equals("execution")) throw new java.io.IOException("这个地址不是 Swift 执行端。");
                runOnUiThread(() -> { if (destroyed) return; try { ConnectionProfiles.saveDirect(this, connection, "直连服务器"); ConnectionRuntime.startDirect(connection); launch(); }
                    catch (Exception error) { busy(false); status.setText(ConnectionProfiles.errorMessage(error)); } });
            } catch (Exception error) { runOnUiThread(() -> { if (!destroyed) { busy(false); status.setText(ConnectionProfiles.errorMessage(error)); } }); }
        });
    }
    private void activate(String id) {
        if (connecting) return;
        busy(true); status.setText("正在验证连接…");
        worker.execute(() -> {
            try {
                ConnectionProfiles.Prepared prepared = ConnectionProfiles.prepare(this, id);
                runOnUiThread(() -> {
                    if (destroyed) return;
                    try { ConnectionProfiles.selectPrepared(this, id, prepared); ConnectionRuntime.startPrepared(this, prepared); launch(); }
                    catch (Exception error) { busy(false); status.setText(ConnectionProfiles.errorMessage(error)); }
                });
            } catch (Exception error) { runOnUiThread(() -> { if (!destroyed) { busy(false); status.setText(ConnectionProfiles.errorMessage(error)); } }); }
        });
    }
    private void launch() {
        Intent launch = new Intent().setClassName(this, getPackageName().endsWith(".chat") ? "io.agentstudio.ChatActivity" : "io.agentstudio.MainActivity");
        launch.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP); startActivity(launch); finish();
    }
    @Override protected void onStart() { super.onStart();  }
    @Override protected void onStop() {  super.onStop(); }
    @Override protected void onDestroy() { destroyed = true;  worker.shutdownNow(); super.onDestroy(); }
}
