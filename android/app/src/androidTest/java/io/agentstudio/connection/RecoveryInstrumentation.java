package io.agentstudio.connection;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Exercises the installed WebView against fixture services, with no production endpoints. */
public final class RecoveryInstrumentation {
    private static WebView find(View view) {
        if (view instanceof WebView) return (WebView)view;
        if (view instanceof ViewGroup) for (int i=0;i<((ViewGroup)view).getChildCount();i++) {
            WebView result=find(((ViewGroup)view).getChildAt(i)); if(result!=null)return result;
        }
        return null;
    }
    private static String evaluate(Instrumentation runner, WebView view, String script) throws Exception {
        CountDownLatch ready=new CountDownLatch(1); AtomicReference<String> result=new AtomicReference<>();
        runner.runOnMainSync(()->view.evaluateJavascript(script,value->{result.set(value);ready.countDown();}));
        if(!ready.await(10,TimeUnit.SECONDS))throw new Exception("WebView evaluation timed out");
        return result.get();
    }
    private static void waitFor(Instrumentation runner, WebView view, String expression, String name) throws Exception {
        long deadline=System.currentTimeMillis()+45000;
        while(System.currentTimeMillis()<deadline) {
            if("true".equals(evaluate(runner,view,"Boolean("+expression+")")))return;
            Thread.sleep(200);
        }
        throw new Exception(name+" timed out");
    }
    public static void run(Instrumentation runner, Bundle args) {
        Bundle result=new Bundle(); String stage=args.getString("recovery");
        try {
            Intent intent=new Intent().setClassName(runner.getTargetContext(),"io.agentstudio.ChatActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            Activity activity=runner.startActivitySync(intent);
            AtomicReference<WebView> found=new AtomicReference<>();runner.runOnMainSync(()->found.set(find(activity.getWindow().getDecorView())));
            WebView view=found.get(); if(view==null)throw new Exception("Missing Chat WebView");
            waitFor(runner,view,"document.querySelector('#appShell')?.dataset.connection==='connected' && document.querySelector('#chatLog')?.textContent.includes('codex 浏览器验收样例')","connected history");
            if("prepare".equals(stage)) {
                evaluate(runner,view,"document.querySelector('#commandInput').value='ANDROID_RECOVERY_SEND';document.querySelector('#commandInput').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#sendButton').click();true");
                waitFor(runner,view,"document.querySelector('#chatLog')?.textContent.includes('ANDROID_RECOVERY_SEND')","submitted message");
                waitFor(runner,view,"!document.querySelector('#chatModeToggle').disabled","native observation ready");
                evaluate(runner,view,"document.querySelector('#commandInput').value='ANDROID_RECOVERY_DRAFT';document.querySelector('#commandInput').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#chatModeToggle').click();true");
                waitFor(runner,view,"document.querySelector('.xterm-rows')?.textContent.includes('OpenAI Codex') && document.querySelector('.shell-terminal-notice')?.hidden","interactive Terminal ready");
                evaluate(runner,view,"(()=>{const area=document.querySelector('.xterm-helper-textarea');area.focus();const data=new DataTransfer();data.setData('text/plain','ANDROID_TERMINAL_中文');area.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));area.dispatchEvent(new KeyboardEvent('keydown',{key:'b',code:'KeyB',keyCode:66,which:66,ctrlKey:true,bubbles:true,cancelable:true}));return true;})()");
                waitFor(runner,view,"document.querySelector('.xterm-rows')?.textContent.includes('ANDROID_TERMINAL_中文')","terminal input echo");
                evaluate(runner,view,"document.querySelector('#chatModeToggle').click();true");
                waitFor(runner,view,"document.querySelector('#commandInput').value==='ANDROID_RECOVERY_DRAFT'","draft after view switch");
                Thread.sleep(1500);
            } else {
                waitFor(runner,view,"document.querySelector('#commandInput').value==='ANDROID_RECOVERY_DRAFT'","draft after process restart");
                if("cycle".equals(stage)) {
                    Bundle ready=new Bundle();ready.putString("stream","READY: Android recovery cycle\n");runner.sendStatus(0,ready);
                    waitFor(runner,view,"document.querySelector('#appShell')?.dataset.connection!=='connected' && document.querySelector('#sendButton').disabled","disconnected send guard");
                    runner.runOnMainSync(()->view.reload());
                    waitFor(runner,view,"document.querySelector('#chatLog')?.textContent.includes('codex 浏览器验收样例') && document.querySelector('#commandInput').value==='ANDROID_RECOVERY_DRAFT'","offline WebView reload");
                    waitFor(runner,view,"document.querySelector('#appShell')?.dataset.connection==='connected' && document.querySelector('#chatLog')?.textContent.includes('重连后 Android 历史已追平')","reconnected history");
                    waitFor(runner,view,"document.querySelector('#commandInput').value==='ANDROID_RECOVERY_DRAFT'","draft after reconnect");
                }
            }
            try(java.io.FileOutputStream file=new java.io.FileOutputStream(new java.io.File(runner.getTargetContext().getFilesDir(),"recovery-"+stage+".png"))){runner.getUiAutomation().takeScreenshot().compress(android.graphics.Bitmap.CompressFormat.PNG,100,file);}
            result.putString("stream","PASS: Android recovery "+stage+"\n");runner.finish(Activity.RESULT_OK,result);
        } catch(Throwable error) {result.putString("stream","FAIL: Android recovery "+stage+": "+error.getMessage()+"\n");runner.finish(Activity.RESULT_CANCELED,result);}
    }
}
