package com.nugggy.plexmediatracker;

import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Starts and stops the scan service from JavaScript, and sends a `tick` event
 * once a second while it runs, for scans that cannot trust web view timers.
 */
@CapacitorPlugin(name = "ScanKeeper")
public class ScanKeeperPlugin extends Plugin {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean ticking = false;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!ticking) return;
            notifyListeners("tick", new JSObject());
            handler.postDelayed(this, 1000);
        }
    };

    @PluginMethod
    public void start(PluginCall call) {
        Intent intent = new Intent(getContext(), ScanService.class)
                .putExtra("title", call.getString("title"))
                .putExtra("text", call.getString("text"));
        getContext().startForegroundService(intent);
        if (!ticking) {
            ticking = true;
            handler.post(tick);
        }
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        if (ScanService.running) {
            Intent intent = new Intent(getContext(), ScanService.class)
                    .putExtra("title", "Plex Media Tracker")
                    .putExtra("text", call.getString("text"));
            getContext().startForegroundService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        ticking = false;
        getContext().stopService(new Intent(getContext(), ScanService.class));
        call.resolve();
    }

    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        PowerManager pm = getContext().getSystemService(PowerManager.class);
        String pkg = getContext().getPackageName();
        if (!pm.isIgnoringBatteryOptimizations(pkg)) {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:" + pkg));
            getActivity().startActivity(i);
        }
        JSObject result = new JSObject();
        result.put("granted", pm.isIgnoringBatteryOptimizations(pkg));
        call.resolve(result);
    }
}
