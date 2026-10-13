package com.nugggy.plexmediatracker;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/** Keeps the process, and so the web view's scan, alive with the screen off. */
public class ScanService extends Service {
    static final String CHANNEL = "scan";
    static final int ID = 1;
    static volatile boolean running = false;

    /** Told when Android ends the service because its daily time allowance ran out. */
    static volatile Runnable onTimedOut = null;

    /*
     * Android crashes the app if a service started with startForegroundService
     * is stopped before it calls startForeground. So a stop that arrives while
     * a start is still on its way is held, and acted on once it lands.
     */
    private static final Object LOCK = new Object();
    private static boolean starting = false;
    private static boolean stopWhenStarted = false;

    private PowerManager.WakeLock lock;

    /** Called by the plugin just before it asks Android to start the service. */
    static void markStarting() {
        synchronized (LOCK) {
            starting = true;
            stopWhenStarted = false;
        }
    }

    /** Called by the plugin when Android refused the start, so none is on its way. */
    static void startFailed() {
        synchronized (LOCK) {
            starting = false;
            stopWhenStarted = false;
        }
    }

    /** Stops the service now, or as soon as a start still on its way has landed. */
    static void requestStop(Context ctx) {
        synchronized (LOCK) {
            if (starting) {
                stopWhenStarted = true;
                return;
            }
        }
        ctx.stopService(new Intent(ctx, ScanService.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null && intent.getStringExtra("title") != null
                ? intent.getStringExtra("title") : "Plex Media Tracker";
        String text = intent != null && intent.getStringExtra("text") != null
                ? intent.getStringExtra("text") : "Checking for updates";

        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(
                new NotificationChannel(CHANNEL, "Scans", NotificationManager.IMPORTANCE_LOW));
        Notification n = notification(title, text);
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(ID, n);
        }

        boolean stopNow;
        synchronized (LOCK) {
            starting = false;
            stopNow = stopWhenStarted;
            stopWhenStarted = false;
        }
        if (stopNow) {
            shutDown();
            return START_NOT_STICKY;
        }

        if (lock == null) {
            lock = getSystemService(PowerManager.class)
                    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pmt:scan");
            // Two hours is well past the longest scan; the lock can never leak for ever.
            lock.acquire(2 * 60 * 60 * 1000L);
        }
        running = true;
        return START_NOT_STICKY;
    }

    /**
     * Android 15 and later allow a data sync service about six hours a day, then
     * call this and expect it gone within seconds. Stop cleanly so the app is not
     * killed, and let the scan know so it can stop and save what it has.
     */
    @Override
    public void onTimeout(int startId, int fgsType) {
        shutDown();
        Runnable listener = onTimedOut;
        if (listener != null) listener.run();
    }

    private void shutDown() {
        running = false;
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private Notification notification(String title, String text) {
        return build(this, title, text);
    }

    /** Also used by the plugin to change the text without restarting the service. */
    static Notification build(Context ctx, String title, String text) {
        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(ctx, CHANNEL)
                .setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setOngoing(true)
                .setContentIntent(pi)
                .build();
    }

    @Override
    public void onDestroy() {
        running = false;
        if (lock != null && lock.isHeld()) lock.release();
        lock = null;
        super.onDestroy();
    }
}
