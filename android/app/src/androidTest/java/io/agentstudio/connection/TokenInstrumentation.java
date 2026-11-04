package io.agentstudio.connection;

import android.app.*;
import android.content.Intent;
import android.os.Bundle;
import android.view.*;
import android.widget.*;
import android.webkit.WebView;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;

/** Isolated test runner helper; the fixture token is never a real credential. */
public final class TokenInstrumentation {
    private static <T extends View> T find(View view, Class<T> type, String label) {
        if (type.isInstance(view) && (label == null || label.contentEquals(view.getContentDescription() == null ? "" : view.getContentDescription())
                || view instanceof TextView && label.contentEquals(((TextView)view).getText()))) return type.cast(view);
        if (view instanceof ViewGroup) for (int i=0;i<((ViewGroup)view).getChildCount();i++) {
            T found=find(((ViewGroup)view).getChildAt(i),type,label); if(found!=null)return found;
        }
        return null;
    }
    private static String statusText(View view) {
        StringBuilder result=new StringBuilder();
        if(view instanceof TextView && !(view instanceof EditText))result.append(((TextView)view).getText()).append(" ");
        if(view instanceof ViewGroup)for(int i=0;i<((ViewGroup)view).getChildCount();i++)result.append(statusText(((ViewGroup)view).getChildAt(i)));
        return result.toString();
    }
    private static String evaluate(Instrumentation runner, WebView web, String script) throws Exception {
        CountDownLatch ready=new CountDownLatch(1); AtomicReference<String> value=new AtomicReference<>();
        runner.runOnMainSync(()->web.evaluateJavascript(script,result->{value.set(result);ready.countDown();}));
        if(!ready.await(10,TimeUnit.SECONDS))throw new Exception("WebView timed out"); return value.get();
    }
    public static void run(Instrumentation runner, Bundle arguments) {
        Bundle result=new Bundle();
        try {
            boolean direct=false;
            boolean chat=runner.getTargetContext().getPackageName().endsWith(".chat");
            Instrumentation.ActivityMonitor destination=runner.addMonitor(chat?"io.agentstudio.ChatActivity":"io.agentstudio.MainActivity",null,false);
            Activity entry=runner.startActivitySync(new Intent(runner.getTargetContext(),ConnectActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("settings",true));
            View page=entry.getWindow().getDecorView();
            runner.runOnMainSync(()->{
                find(page,EditText.class,"服务端名称").setText("WSL");
                find(page,EditText.class,"token").setText("wrong-fixture-token");
                find(page,Button.class,"连接").performClick();
            });
            long deadline=System.currentTimeMillis()+20000;
            if(!direct){ boolean failed=false;
            while(System.currentTimeMillis()<deadline){
                AtomicReference<Boolean> ready=new AtomicReference<>(false);
                runner.runOnMainSync(()->ready.set(find(page,Button.class,"连接").isEnabled()));
                if(ready.get()){failed=true;break;} Thread.sleep(200);
            }
            if(!failed || runner.getTargetContext().getSharedPreferences("direct-computer",0).contains("baseUrl"))throw new Exception("Failed token was saved");
            }
            runner.runOnMainSync(()->{
                find(page,EditText.class,"token").setText(direct ? "" : arguments.getString("token"));
                find(page,Button.class,"连接").performClick();
            });
            Activity connected=runner.waitForMonitorWithTimeout(destination,30000);
            if(connected==null) {
                AtomicReference<String> detail=new AtomicReference<>("");
                runner.runOnMainSync(()->detail.set(statusText(page)));
                throw new Exception("Token connection did not open the application: "+detail.get());
            }
            if(chat){
                AtomicReference<WebView> view=new AtomicReference<>(); runner.runOnMainSync(()->view.set(find(connected.getWindow().getDecorView(),WebView.class,null)));
                deadline=System.currentTimeMillis()+30000; boolean loaded=false;
                while(System.currentTimeMillis()<deadline){
                    if("true".equals(evaluate(runner,view.get(),"Boolean(document.querySelector('#chatLog')?.textContent.includes('codex 浏览器验收样例') && document.querySelector('#appShell')?.dataset.connection==='connected' && !location.href.includes('token='))"))){loaded=true;break;} Thread.sleep(300);
                }
                if(!loaded)throw new Exception("Token WebView did not load HTTP/WebSocket");
            }else{
                Thread.sleep(2500);
                runner.runOnMainSync(()->{find(connected.getWindow().getDecorView(),EditText.class,null).setText("native-terminal-token-probe");find(connected.getWindow().getDecorView(),Button.class,"填入").performClick();});
            }
            try(java.io.FileOutputStream file=new java.io.FileOutputStream(new java.io.File(runner.getTargetContext().getFilesDir(),"token-proof.png"))){runner.getUiAutomation().takeScreenshot().compress(android.graphics.Bitmap.CompressFormat.PNG,100,file);}
            result.putString("stream","PASS: Android token entry, token-only management, failed-token rejection, saved connection and "+(chat?"WebView HTTP/WebSocket":"terminal input")+"\n"); runner.finish(Activity.RESULT_OK,result);
        }catch(Throwable e){result.putString("stream","FAIL: "+e.getClass().getSimpleName()+": "+e.getMessage()+"\n");runner.finish(Activity.RESULT_CANCELED,result);}
    }
}
