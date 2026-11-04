package io.agentstudio.connection;
import android.app.Activity;
import android.content.*;
import android.os.*;
import android.webkit.CookieManager;
public final class ConnectionRuntime {
    private static volatile TokenConnection direct;
    private static final Handler MAIN=new Handler(Looper.getMainLooper());
    public static String baseUrl(){return direct.baseUrl;}
    public static String token(){return direct.token;}
    public static boolean requireSaved(Context context){return direct!=null || resume(context);}
    public static boolean require(Activity activity){if(requireSaved(activity))return true;settings(activity);activity.finish();return false;}
    public static boolean resume(Context context){
        SharedPreferences saved=context.getSharedPreferences("direct-computer",Context.MODE_PRIVATE);
        if(!saved.getString("mode", "").equals("direct"))return false;
        try{startDirect(new TokenConnection(saved.getString("baseUrl",""),saved.getString("token",""),true));return true;}catch(IllegalArgumentException error){return false;}
    }
    private static String cookiePath(String base){String path=android.net.Uri.parse(base).getPath();return path==null || path.isEmpty()?"/":path;}
    public static void startDirect(TokenConnection connection){
        direct=connection;
        CookieManager.getInstance().setCookie(connection.baseUrl,"agentStudioToken="+connection.token+"; Path="+cookiePath(connection.baseUrl)+"; HttpOnly; SameSite=Strict"+(connection.baseUrl.startsWith("https:")?"; Secure":""));
        CookieManager.getInstance().flush();
    }
    public static void startPrepared(Context context,ConnectionProfiles.Prepared connection){startDirect(connection.direct);}
    public static void verifyDirectAuthentication(Activity activity){
        TokenConnection expected=direct;if(expected==null)return;
        Thread worker=new Thread(()->{try{expected.verify();}catch(TokenConnection.AuthenticationException error){MAIN.post(()->{if(direct==expected && !activity.isFinishing() && !activity.isDestroyed())rejected(activity);});}catch(java.io.IOException error){}},"swift-authentication");worker.setDaemon(true);worker.start();
    }
    public static void rejected(Activity activity){activity.startActivity(new Intent(activity,ConnectActivity.class).putExtra("settings",true).putExtra("rejected",true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TASK));close();activity.finish();}
    public static void settings(Activity activity){activity.startActivity(new Intent(activity,ConnectActivity.class).putExtra("settings",true));}
    public static void forget(Context context){
        SharedPreferences saved=context.getSharedPreferences("direct-computer",Context.MODE_PRIVATE);String base=saved.getString("baseUrl","");
        if(!base.isEmpty())CookieManager.getInstance().setCookie(base,"agentStudioToken=; Path="+cookiePath(base)+"; Max-Age=0; HttpOnly");
        CookieManager.getInstance().flush();close();saved.edit().clear().commit();
    }
    public static void wake(){} public static void background(){} static void close(){direct=null;}
}
