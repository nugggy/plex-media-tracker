package com.nugggy.plexmediatracker;

import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Opens Plex's sign-in page in the phone's own browser, where the person may
 * already be signed in to Plex. Only that page: the web view cannot use this
 * to send the phone anywhere else.
 */
@CapacitorPlugin(name = "Links")
public class LinksPlugin extends Plugin {
    private static final String PLEX_SIGN_IN = "https://app.plex.tv/auth#";

    @PluginMethod
    public void openPlexSignIn(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || !url.startsWith(PLEX_SIGN_IN)) {
            call.reject("Only Plex's sign-in page can be opened this way.", "NOT_ALLOWED");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("No browser on this phone could open Plex's sign-in page.", "NO_BROWSER");
        }
    }
}
