package com.nugggy.plexmediatracker;

import android.Manifest;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ScanKeeperPlugin.class);
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);
        }
    }

    /** While a scan runs, keep the web view awake when the app leaves the screen. */
    @Override
    public void onPause() {
        super.onPause();
        keepWebViewAwake();
    }

    @Override
    public void onStop() {
        super.onStop();
        keepWebViewAwake();
    }

    private void keepWebViewAwake() {
        if (ScanService.running && bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().onResume();
            bridge.getWebView().resumeTimers();
        }
    }
}
