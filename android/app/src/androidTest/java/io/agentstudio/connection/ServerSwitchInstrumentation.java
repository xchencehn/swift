package io.agentstudio.connection;

import android.app.*;
import android.content.*;
import android.os.Bundle;
import android.view.*;
import android.webkit.WebView;
import android.widget.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import org.json.*;

/** Runs only in the disposable connection-test AVD, with fixture credentials. */
public final class ServerSwitchInstrumentation {
    private static <T extends View> T find(View view, Class<T> type, String label) {
        if (type.isInstance(view) && (label == null || label.contentEquals(view.getContentDescription()==null?"":view.getContentDescription())
                || view instanceof TextView && label.contentEquals(((TextView)view).getText()))) return type.cast(view);
        if(view instanceof ViewGroup) for(int i=0;i<((ViewGroup)view).getChildCount();i++) {
            T found=find(((ViewGroup)view).getChildAt(i),type,label); if(found!=null)return found;
        }
        return null;
    }
    private static String evaluate(Instrumentation runner, WebView web, String script) throws Exception {
        CountDownLatch ready=new CountDownLatch(1); AtomicReference<String> value=new AtomicReference<>();
        runner.runOnMainSync(()->web.evaluateJavascript(script,result->{value.set(result);ready.countDown();}));
        if(!ready.await(10,TimeUnit.SECONDS))throw new Exception("WebView timed out"); return value.get();
    }
    private static WebView ready(Instrumentation runner, Activity activity) throws Exception {
        AtomicReference<WebView> view=new AtomicReference<>();
        runner.runOnMainSync(()->view.set(find(activity.getWindow().getDecorView(),WebView.class,null)));
        long deadline=System.currentTimeMillis()+30000;
        while(System.currentTimeMillis()<deadline) {
            if("true".equals(evaluate(runner,view.get(),"Boolean(document.querySelector('#serverSwitch') && document.querySelector('#appShell')?.dataset.connection==='connected')")))return view.get();
            Thread.sleep(200);
        }
        throw new Exception("Server-switch WebView did not become ready");
    }
    private static void expect(Instrumentation runner, WebView web, String expression, String label) throws Exception {
        long deadline=System.currentTimeMillis()+20000;
        while(System.currentTimeMillis()<deadline) {
            if("true".equals(evaluate(runner,web,expression)))return;
            Thread.sleep(150);
        }
        throw new Exception(label);
    }
    private static void open(Instrumentation runner, WebView web) throws Exception {
        evaluate(runner,web,"if(!document.querySelector('#chatSidebar').classList.contains('open'))document.querySelector('#chatDrawerToggle').click();if(document.querySelector('#serverPopover').hidden)document.querySelector('#serverSwitch').click();true");
        expect(runner,web,"Boolean(document.querySelector('.server-option') && !document.querySelector('#serverPopover').hidden && document.querySelector('#chatSidebar').classList.contains('open'))","Saved profiles missing");
        Thread.sleep(300); // Wait for the drawer transform before taking native screenshots.
    }
    private static Activity switchTo(Instrumentation runner, WebView web, String id) throws Exception {
        open(runner,web);
        Instrumentation.ActivityMonitor changed=runner.addMonitor("io.agentstudio.ChatActivity",null,false);
        evaluate(runner,web,"document.querySelector('[data-server-id=\""+id+"\"]').click();true");
        Activity next=runner.waitForMonitorWithTimeout(changed,30000);
        runner.removeMonitor(changed);
        if(next==null)throw new Exception("Native switch did not recreate the selected connection");
        return next;
    }
    private static void capture(Instrumentation runner, WebView web, String name) throws Exception {
        CountDownLatch painted=new CountDownLatch(1);
        runner.runOnMainSync(()->web.postVisualStateCallback(1,new WebView.VisualStateCallback(){
            @Override public void onComplete(long id){web.invalidate();painted.countDown();}
        }));
        if(!painted.await(10,TimeUnit.SECONDS))throw new Exception("WebView paint timed out");
        runner.waitForIdleSync(); Thread.sleep(700);
        try(java.io.FileOutputStream file=new java.io.FileOutputStream(new java.io.File(runner.getTargetContext().getFilesDir(),name))) {
            runner.getUiAutomation().takeScreenshot().compress(android.graphics.Bitmap.CompressFormat.PNG,100,file);
        }
    }
    public static void run(Instrumentation runner, Bundle arguments) {
        Bundle result=new Bundle();
        try {
            Context context=runner.getTargetContext();
            Activity first=runner.startActivitySync(new Intent().setClassName(context,"io.agentstudio.ChatActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            WebView firstWeb=ready(runner,first);
            evaluate(runner,firstWeb,"localStorage.setItem('agentStudioToken',"+JSONObject.quote(arguments.getString("token"))+");true");
            runner.runOnMainSync(firstWeb::reload);
            expect(runner,firstWeb,"!location.href.includes('token=') && !document.cookie.includes("+JSONObject.quote(arguments.getString("token"))+") && !Object.values(localStorage).some(value=>value.includes("+JSONObject.quote(arguments.getString("token"))+"))","Native credentials leaked into the webpage");
            firstWeb=ready(runner,first);
            String firstId=new JSONObject(ConnectionProfiles.publicProfiles(context)).getString("active");
            evaluate(runner,firstWeb,"document.querySelector('#commandInput').value='WSL 独立草稿';document.querySelector('#commandInput').dispatchEvent(new Event('input',{bubbles:true}));true");
            Activity entry=runner.startActivitySync(new Intent(context,ConnectActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("settings",true));
            Instrumentation.ActivityMonitor connected=runner.addMonitor("io.agentstudio.ChatActivity",null,false);
            runner.runOnMainSync(()->{
                View page=entry.getWindow().getDecorView();
                find(page,EditText.class,"服务端名称").setText("194");
                find(page,EditText.class,"token").setText(arguments.getString("secondToken"));
                find(page,Button.class,"连接").performClick();
            });
            Activity second=runner.waitForMonitorWithTimeout(connected,30000); runner.removeMonitor(connected);
            if(second==null)throw new Exception("Adding the second server failed");
            WebView secondWeb=ready(runner,second);
            JSONObject profiles=new JSONObject(ConnectionProfiles.publicProfiles(context));
            if(profiles.getJSONArray("profiles").length()!=2 || profiles.toString().contains(arguments.getString("secondToken")))throw new Exception("Native profile isolation failed");
            String secondId=profiles.getString("active");
            expect(runner,secondWeb,"document.querySelector('#commandInput').value!=='WSL 独立草稿'","First server draft leaked into second");
            evaluate(runner,secondWeb,"document.querySelector('#commandInput').value='194 独立草稿';document.querySelector('#commandInput').dispatchEvent(new Event('input',{bubbles:true}));true");
            open(runner,secondWeb); capture(runner,secondWeb,"server-switch-proof.png");
            expect(runner,secondWeb,"['#serverSwitch','.server-manage'].every(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return r.width>=48&&r.height>=48;})","Android touch targets are too small");
            runner.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
            expect(runner,secondWeb,"document.querySelector('#serverPopover').hidden && document.querySelector('#chatSidebar').classList.contains('open')","Android Back did not close only the server list");
            Activity restoredFirst=switchTo(runner,secondWeb,firstId);
            WebView restoredFirstWeb=ready(runner,restoredFirst);
            expect(runner,restoredFirstWeb,"document.querySelector('#commandInput').value==='WSL 独立草稿'","First server draft was lost");
            Activity restoredSecond=switchTo(runner,restoredFirstWeb,secondId);
            WebView restoredSecondWeb=ready(runner,restoredSecond);
            expect(runner,restoredSecondWeb,"document.querySelector('#commandInput').value==='194 独立草稿'","Second server draft was lost");
            // A revoked saved credential must not replace the active server.
            SharedPreferences saved=context.getSharedPreferences("direct-computer",0);
            JSONObject nativeState=new JSONObject(saved.getString("connections","{}"));
            String failedId="ffffffff-ffff-4fff-8fff-ffffffffffff";
            nativeState.getJSONArray("profiles").put(new JSONObject().put("id",failedId).put("name","已撤销授权")
                    .put("mode","remote").put("address","http://127.0.0.1:1").put("token","revoked-fixture-only-token"));
            if(!saved.edit().putString("connections",nativeState.toString()).commit())throw new Exception("Fixture save failed");
            open(runner,restoredSecondWeb);
            evaluate(runner,restoredSecondWeb,"document.querySelector('[data-server-id=\""+failedId+"\"]').click();true");
            expect(runner,restoredSecondWeb,"document.querySelector('#serverStatus').textContent.includes('token') && document.querySelector('#commandInput').value==='194 独立草稿'","Revoked token did not preserve current server and draft");
            if(!new JSONObject(ConnectionProfiles.publicProfiles(context)).getString("active").equals(secondId))throw new Exception("Failed switch changed active server");
            capture(runner,restoredSecondWeb,"server-switch-error.png");
            if(ConnectionProfiles.remove(context,failedId))throw new Exception("Inactive removal changed the active server");
            WebView finalWeb=ready(runner,switchTo(runner,restoredSecondWeb,firstId));
            expect(runner,finalWeb,"document.querySelector('#commandInput').value==='WSL 独立草稿'","Final first-server draft was lost");
            result.putString("stream","PASS: Android saved servers, Tencent-only connections, native bridge switching, separate drafts, revoked credentials and inactive removal\n");
            runner.finish(Activity.RESULT_OK,result);
        } catch(Throwable error) {
            result.putString("stream","FAIL: "+error.getClass().getSimpleName()+": "+error.getMessage()+"\n");
            runner.finish(Activity.RESULT_CANCELED,result);
        }
    }
}
