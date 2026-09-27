package com.nugggy.plexmediatracker;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
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

    private PowerManager.WakeLock lock;

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

        if (lock == null) {
            lock = getSystemService(PowerManager.class)
                    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pmt:scan");
            // Two hours is well past the longest scan; the lock can never leak for ever.
            lock.acquire(2 * 60 * 60 * 1000L);
        }
        running = true;
        return START_NOT_STICKY;
    }

    private Notification notification(String title, String text) {
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
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
