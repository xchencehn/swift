package io.agentstudio.connection;
import android.app.Instrumentation;
import android.os.Bundle;
public final class DirectInstrumentation extends Instrumentation {
    @Override public void onCreate(Bundle args){start();}
    @Override public void onStart(){Bundle result=new Bundle();result.putString("edition","open-source-direct");finish(RESULT_OK,result);}
}
