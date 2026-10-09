package com.nugggy.plexmediatracker;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;

/**
 * Downloads a new version of the app and hands it to Android's installer. The
 * download is checked first: same app, signed with the same key, and newer
 * than what is installed. Android still shows its own install screen; a
 * sideloaded app is never allowed to replace itself silently.
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {
    /** Mirrors DOWNLOAD_PREFIX in mobile/updates.ts. */
    private static final String ALLOWED =
            "https://github.com/nugggy/plex-media-tracker/releases/download/";

    /** Mirrors LATEST_RELEASE_PAGE in mobile/updates.ts. */
    private static final String LATEST_PAGE =
            "https://github.com/nugggy/plex-media-tracker/releases/latest";

    /**
     * The newest release's tag, read from where the public releases page
     * redirects. Done here rather than in the web view because the page has no
     * CORS headers, and unlike the API it has no hourly cap.
     */
    @PluginMethod
    public void latestTag(PluginCall call) {
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(LATEST_PAGE).openConnection();
                c.setInstanceFollowRedirects(false);
                c.setRequestMethod("HEAD");
                c.setConnectTimeout(20_000);
                c.setReadTimeout(20_000);
                int code = c.getResponseCode();
                String location = c.getHeaderField("Location");
                c.disconnect();
                if (code / 100 != 3 || location == null || !location.contains("/releases/tag/")) {
                    call.reject("GitHub answered " + code, "CHECK_FAILED");
                    return;
                }
                JSObject r = new JSObject();
                r.put("tag", location.substring(location.lastIndexOf('/') + 1));
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Could not reach GitHub.", "CHECK_FAILED");
            }
        }).start();
    }

    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject r = new JSObject();
        r.put("allowed", getContext().getPackageManager().canRequestPackageInstalls());
        call.resolve(r);
    }

    /** Opens the phone's "Install unknown apps" switch for this app. */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                .setData(Uri.parse("package:" + getContext().getPackageName()));
        getActivity().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith(ALLOWED)) {
            call.reject("That download is not from this app's releases.", "BAD_URL");
            return;
        }
        if (!getContext().getPackageManager().canRequestPackageInstalls()) {
            call.reject("Allow Plex Media Tracker to install apps first.", "NEEDS_PERMISSION");
            return;
        }
        new Thread(() -> {
            try {
                File apk = download(url);
                String problem = checkApk(apk);
                if (problem != null) {
                    apk.delete();
                    call.reject(problem, "BAD_APK");
                    return;
                }
                Uri uri = FileProvider.getUriForFile(
                        getContext(), getContext().getPackageName() + ".fileprovider", apk);
                Intent install = new Intent(Intent.ACTION_VIEW)
                        .setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().startActivity(install);
                call.resolve();
            } catch (Exception e) {
                call.reject("The download did not work. " + e.getMessage(), "DOWNLOAD_FAILED");
            }
        }).start();
    }

    private File download(String url) throws Exception {
        File dir = new File(getContext().getCacheDir(), "updates");
        dir.mkdirs();
        File out = new File(dir, "update.apk");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        // GitHub answers with a redirect to its file store, also over https.
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(20_000);
        c.setReadTimeout(60_000);
        int code = c.getResponseCode();
        if (code == 403 || code == 429) {
            throw new Exception("GitHub is limiting downloads from your internet connection for now. Try again in an hour.");
        }
        if (code == 404) throw new Exception("GitHub does not have that version's file. Check again in a few minutes.");
        if (code != 200) throw new Exception("GitHub answered HTTP " + code + ". Try again shortly.");
        try (InputStream in = c.getInputStream(); OutputStream os = new FileOutputStream(out)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
        } finally {
            c.disconnect();
        }
        return out;
    }

    /** Null when the download is safe to offer, otherwise the reason it is not. */
    private String checkApk(File apk) throws Exception {
        PackageManager pm = getContext().getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : PackageManager.GET_SIGNATURES;
        PackageInfo next = pm.getPackageArchiveInfo(apk.getPath(), flags);
        if (next == null) return "The download is not a readable app.";
        PackageInfo current = pm.getPackageInfo(getContext().getPackageName(), flags);
        if (!current.packageName.equals(next.packageName)) return "The download is a different app.";
        if (versionOf(next) <= versionOf(current)) return "The download is not newer than this version.";
        if (!Arrays.equals(signersOf(next), signersOf(current))) {
            return "The download is not signed with this app's key.";
        }
        return null;
    }

    private static long versionOf(PackageInfo p) {
        return Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;
    }

    @SuppressWarnings("deprecation")
    private static Signature[] signersOf(PackageInfo p) {
        if (Build.VERSION.SDK_INT >= 28 && p.signingInfo != null) {
            return p.signingInfo.getApkContentsSigners();
        }
        return p.signatures;
    }
}
