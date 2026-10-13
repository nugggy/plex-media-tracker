package com.nugggy.plexmediatracker;

import android.Manifest;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ScanKeeperPlugin.class);
        registerPlugin(UpdaterPlugin.class);
        super.onCreate(savedInstanceState);
        askOnceForNotifications();
    }

    /**
     * The scan's notification needs permission on Android 13 and later. Ask the
     * first time only: a no stays a no, and can be changed in the phone's settings.
     */
    private void askOnceForNotifications() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        SharedPreferences prefs = getSharedPreferences("pmt", MODE_PRIVATE);
        if (prefs.getBoolean("asked-notifications", false)) return;
        prefs.edit().putBoolean("asked-notifications", true).apply();
        requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);
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
