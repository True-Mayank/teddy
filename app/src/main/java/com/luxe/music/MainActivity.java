package com.luxe.music;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.provider.Settings;
import android.util.Base64;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.concurrent.ConcurrentHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final int PICK_MUSIC_FOLDER = 7001;
    private static final int REQUEST_WRITE_ACCESS = 7002;
    private static final int REQUEST_AUDIO_PERMISSION = 9002;
    private static final String PREFS = "luxe_native_storage";
    private static final String TREE_KEY = "music_tree_uri";
    private static final String HOST = "luxe.local";

    private WebView webView;
    private final Map<String, Uri> audioUriMap = new ConcurrentHashMap<>();
    private final ExecutorService scanner = Executors.newSingleThreadExecutor();
    private SharedPreferences prefs;
    private boolean pageReady = false;
    private boolean restoreStarted = false;
    private volatile int scanGeneration = 0;

    // Rename / delete work. Android only lets LUXE change files in the music folder
    // after the user has granted edit access to that folder.
    private final ExecutorService fileWorker = Executors.newSingleThreadExecutor();
    private Runnable pendingFileOp = null;
    private Runnable pendingFileOpDenied = null;
    private boolean visualizerOpenInWeb = false;

    private final PlaybackKeepAliveService.VisualizerSink visualizerSink = levels -> {
        StringBuilder js = new StringBuilder("window.LuxeVisualizerFrame&&window.LuxeVisualizerFrame([");
        for (int i = 0; i < levels.length; i++) {
            if (i > 0) js.append(',');
            js.append(levels[i]);
        }
        js.append("]);");
        runJs(js.toString());
    };

    private final BroadcastReceiver playbackReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (!PlaybackKeepAliveService.ACTION_STATE.equals(intent.getAction())) return;
            try {
                JSONObject state = new JSONObject();
                state.put("id", intent.getStringExtra("id"));
                state.put("title", intent.getStringExtra("title"));
                state.put("artist", intent.getStringExtra("artist"));
                state.put("playing", intent.getBooleanExtra("playing", false));
                state.put("position", intent.getLongExtra("position", 0));
                state.put("duration", intent.getLongExtra("duration", 0));
                state.put("queueIndex", intent.getIntExtra("queueIndex", -1));
                state.put("queueSize", intent.getIntExtra("queueSize", 0));
                runJs("if(window.LuxeAndroidNativeState)window.LuxeAndroidNativeState(" + state + ");");
            } catch (Exception ignored) {}
        }
    };

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        webView = new WebView(this);
        webView.setBackgroundColor(0xFF09090B);
        setContentView(webView);

        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setDatabaseEnabled(true);
        webView.getSettings().setMediaPlaybackRequiresUserGesture(false);

        // Behave like an app, not a web page: no pinch or double-tap zoom, no zoom
        // controls, system font size cannot rescale the layout, no overscroll glow,
        // and long-press does not select text or open browser menus.
        WebSettings ws = webView.getSettings();
        ws.setSupportZoom(false);
        ws.setBuiltInZoomControls(false);
        ws.setDisplayZoomControls(false);
        ws.setTextZoom(100);
        ws.setLoadWithOverviewMode(false);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setLongClickable(false);
        webView.setOnLongClickListener(v -> true);
        webView.getSettings().setAllowFileAccess(true);
        webView.getSettings().setAllowContentAccess(true);
        webView.addJavascriptInterface(new AndroidBridge(), "LuxeAndroid");
        webView.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                try {
                    Uri u = Uri.parse(url);
                    if (HOST.equalsIgnoreCase(u.getHost()) && u.getPath() != null && u.getPath().startsWith("/audio/")) {
                        String token = u.getLastPathSegment();
                        Uri source = audioUriMap.get(token);
                        if (source == null) return new WebResourceResponse("audio/mpeg", null, 404, "Not Found", null, null);
                        InputStream stream = getContentResolver().openInputStream(source);
                        String mime = getContentResolver().getType(source);
                        if (mime == null) mime = "audio/mpeg";
                        return new WebResourceResponse(mime, null, stream);
                    }
                    if (HOST.equalsIgnoreCase(u.getHost()) && u.getPath() != null && u.getPath().startsWith("/artwork/")) {
                        File artwork = artworkFileForToken(u.getLastPathSegment());
                        if (artwork == null || !artwork.isFile()) return new WebResourceResponse("image/jpeg", null, 404, "Not Found", null, null);
                        return new WebResourceResponse("image/jpeg", null, new FileInputStream(artwork));
                    }
                } catch (Exception ignored) {}
                return super.shouldInterceptRequest(view, url);
            }
            @Override public void onPageFinished(WebView view, String url) {
                pageReady = true;
                if (!restoreStarted) { restoreStarted = true; restoreSavedFolder(); }
                PlaybackKeepAliveService.requestState(MainActivity.this);
            }
        });
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            registerReceiver(playbackReceiver, new IntentFilter(PlaybackKeepAliveService.ACTION_STATE), Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(playbackReceiver, new IntentFilter(PlaybackKeepAliveService.ACTION_STATE));
        }
        webView.loadUrl("file:///android_asset/index.html");
        if (android.os.Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 9001);
        }
    }

    private void restoreSavedFolder() {
        String raw = prefs.getString(TREE_KEY, null);
        if (raw == null) return;
        try {
            Uri tree = Uri.parse(raw);
            boolean hasReadGrant = false;
            for (android.content.UriPermission permission : getContentResolver().getPersistedUriPermissions()) {
                if (tree.toString().equals(permission.getUri().toString()) && permission.isReadPermission()) {
                    hasReadGrant = true;
                    break;
                }
            }
            if (!hasReadGrant) {
                sendNativeError("Android no longer grants access to the saved music folder. Please select the folder again.");
                return;
            }
            scanAndSend(tree, false);
        } catch (Exception e) {
            sendNativeError("Saved music folder is no longer accessible. Please select it again.");
        }
    }

    private void pickFolder() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(intent, PICK_MUSIC_FOLDER);
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_WRITE_ACCESS) { handleWriteAccessResult(resultCode, data); return; }
        if (requestCode != PICK_MUSIC_FOLDER || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri tree = data.getData();
        try {
            int grantFlags = data.getFlags()
                    & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            // SAF providers normally return READ; request it explicitly as a fallback
            // so the selected folder remains accessible after LUXE is reopened.
            if ((grantFlags & Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0) {
                grantFlags |= Intent.FLAG_GRANT_READ_URI_PERMISSION;
            }
            getContentResolver().takePersistableUriPermission(tree, grantFlags);
        } catch (Exception e) {
            android.util.Log.w("LUXEMainActivity", "Could not persist folder permission", e);
        }
        prefs.edit().putString(TREE_KEY, tree.toString()).apply();
        // Avoid a full metadata pass on the first folder selection; names are
        // available immediately and artwork is extracted progressively in background.
        scanAndSend(tree, false);
    }

    private void scanAndSend(Uri treeUri, boolean refreshMetadata) {
        final int thisGeneration = ++scanGeneration;
        scanner.execute(() -> {
            try {
                if (thisGeneration != scanGeneration) return;
                List<Entry> entries = queryAudioFiles(treeUri);
                audioUriMap.clear();
                JSONArray songs = new JSONArray();
                for (Entry e : entries) {
                    audioUriMap.put(token(e.uri.toString()), e.uri);
                    JSONObject song = new JSONObject();
                    song.put("id", e.uri.toString());
                    song.put("name", e.name);
                    song.put("mime", e.mime);
                    song.put("size", e.size);
                    song.put("lastModified", e.lastModified);
                    song.put("url", "https://" + HOST + "/audio/" + token(e.uri.toString()));
                    song.put("title", parseTitle(e.name));
                    song.put("artist", parseArtist(e.name));
                    song.put("album", "Local Music");
                    String cachedArtwork = cachedArtworkUrl(e.uri.toString());
                    song.put("artwork", cachedArtwork == null ? JSONObject.NULL : cachedArtwork);
                    songs.put(song);
                }
                JSONObject payload = new JSONObject();
                payload.put("folderUri", treeUri.toString());
                payload.put("count", songs.length());
                payload.put("songs", songs);
                if (thisGeneration != scanGeneration) return;
                sendLibraryToJavascript(payload);
                // Show the song list immediately, then fill missing artwork in the
                // background. Artwork is cached as small JPEG files, so later launches
                // can display it without passing large base64 strings through WebView.
                if (thisGeneration == scanGeneration) enrichSongs(entries, refreshMetadata);
                else sendNativeStatus("Music library ready.");
            } catch (Exception e) {
                sendNativeError("Unable to scan the music folder.");
            }
        });
    }

    private List<Entry> queryAudioFiles(Uri tree) {
        List<Entry> out = new ArrayList<>();
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
        String[] projection = {DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED};
        try (Cursor c = getContentResolver().query(children, projection, null, null, DocumentsContract.Document.COLUMN_DISPLAY_NAME + " ASC")) {
            if (c == null) return out;
            int idCol=c.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID), nameCol=c.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME), mimeCol=c.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE), sizeCol=c.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE), modCol=c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED);
            while(c.moveToNext()){
                String name=c.getString(nameCol); String mime=c.getString(mimeCol);
                if(!isAudio(name,mime)) continue;
                String docId=c.getString(idCol); Uri file=DocumentsContract.buildDocumentUriUsingTree(tree,docId);
                out.add(new Entry(file,name,mime,sizeCol>=0?c.getLong(sizeCol):0,modCol>=0?c.getLong(modCol):0));
            }
        } catch(Exception ignored){}
        return out;
    }

    private void enrichSongs(List<Entry> entries, boolean refreshMetadata) {
        for (Entry e : entries) {
            if (Thread.currentThread().isInterrupted()) return;
            File cached = artworkFile(e.uri.toString());
            if (cached.isFile() && cached.length() > 0) {
                if (!refreshMetadata) continue;
            }
            android.media.MediaMetadataRetriever r = null;
            try {
                r = new android.media.MediaMetadataRetriever();
                r.setDataSource(this, e.uri);
                if (refreshMetadata) {
                    String title = r.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_TITLE);
                    String artist = r.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_ARTIST);
                    String album = r.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_ALBUM);
                    if (title != null || artist != null || album != null) {
                        JSONObject m = new JSONObject();
                        m.put("id", e.uri.toString());
                        m.put("title", title);
                        m.put("artist", artist);
                        m.put("album", album);
                        sendSongMetadataUpdated(m);
                    }
                }
                if (!cached.isFile() || cached.length() == 0) {
                    byte[] picture = r.getEmbeddedPicture();
                    if (picture != null && picture.length > 0) {
                        String artworkUrl = saveArtwork(e.uri.toString(), picture);
                        if (artworkUrl != null) sendNativeArtworkUpdated(e.uri.toString(), artworkUrl);
                    }
                }
            } catch (Exception ignored) {
            } finally {
                if (r != null) try { r.release(); } catch (Exception ignored) {}
            }
        }
        sendNativeStatus("Music library ready.");
    }

    private File artworkDirectory() {
        File dir = new File(getFilesDir(), "luxe_artwork");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private File artworkFile(String id) {
        return artworkFileForToken(token(id));
    }

    private File artworkFileForToken(String value) {
        if (value == null || !value.matches("[a-fA-F0-9]{32,64}")) return null;
        return new File(artworkDirectory(), value + ".jpg");
    }

    private String cachedArtworkUrl(String id) {
        File file = artworkFile(id);
        return file.isFile() && file.length() > 0 ? "https://" + HOST + "/artwork/" + token(id) : null;
    }

    private String saveArtwork(String id, byte[] data) {
        Bitmap bitmap = null;
        try {
            bitmap = BitmapFactory.decodeByteArray(data, 0, data.length);
            if (bitmap == null) return null;
            int max = 500;
            float scale = Math.min(1f, max / (float) Math.max(bitmap.getWidth(), bitmap.getHeight()));
            if (scale < 1f) {
                Bitmap scaled = Bitmap.createScaledBitmap(bitmap, Math.max(1, (int)(bitmap.getWidth() * scale)), Math.max(1, (int)(bitmap.getHeight() * scale)), true);
                if (scaled != bitmap) bitmap.recycle();
                bitmap = scaled;
            }
            File target = artworkFile(id);
            try (FileOutputStream out = new FileOutputStream(target)) {
                bitmap.compress(Bitmap.CompressFormat.JPEG, 82, out);
                out.flush();
            }
            return "https://" + HOST + "/artwork/" + token(id);
        } catch (Exception e) {
            return null;
        } finally {
            if (bitmap != null && !bitmap.isRecycled()) bitmap.recycle();
        }
    }

    private boolean isAudio(String name,String mime){ if(mime!=null&&mime.toLowerCase().startsWith("audio/"))return true; return name!=null&&name.matches("(?i).+\\.(mp3|m4a|flac|wav|aac|ogg|opus|webm|oga)$"); }
    private String parseTitle(String name){ String n=name.replaceFirst("(?i)\\.[^.]+$",""); int p=n.indexOf(" - "); return p>=0?n.substring(p+3).trim():n; }
    private String parseArtist(String name){ String n=name.replaceFirst("(?i)\\.[^.]+$",""); int p=n.indexOf(" - "); return p>=0?n.substring(0,p).trim():"Unknown Artist"; }
    private String token(String value){ try{MessageDigest d=MessageDigest.getInstance("SHA-256");byte[] h=d.digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));StringBuilder s=new StringBuilder();for(byte b:h)s.append(String.format("%02x",b));return s.toString();}catch(Exception e){return Integer.toHexString(value.hashCode());} }

    private void runJs(String js){ runOnUiThread(()->{if(pageReady&&webView!=null)webView.evaluateJavascript(js,null);}); }
    private void sendLibraryToJavascript(JSONObject p){ runJs("window.LUXEAndroid&&window.LUXEAndroid.onFolderSelected("+JSONObject.quote(p.toString())+");"); }
    private void sendNativeArtworkUpdated(String id,String art){ runJs("window.LUXEAndroid&&window.LUXEAndroid.onNativeArtworkUpdated("+JSONObject.quote(id)+","+JSONObject.quote(art)+");"); }
    private void sendSongMetadataUpdated(JSONObject song){ runJs("window.LUXEAndroid&&window.LUXEAndroid.onNativeSongMetadataUpdated("+JSONObject.quote(song.toString())+");"); }
    private void sendNativeStatus(String msg){ runJs("window.LUXEAndroid&&window.LUXEAndroid.onNativeStatus("+JSONObject.quote(msg)+");"); }
    private void sendNativeError(String msg){ runJs("window.LUXEAndroid&&window.LUXEAndroid.onError("+JSONObject.quote(msg)+");"); }
    private void sendFolderCleared(){ runJs("window.LUXEAndroid&&window.LUXEAndroid.onFolderCleared();"); }

    public class AndroidBridge {
        @JavascriptInterface public boolean isAndroidNative(){return true;}
        @JavascriptInterface public void pickMusicFolder(){runOnUiThread(MainActivity.this::pickFolder);}
        @JavascriptInterface public void rescanMusicFolder(){String raw=prefs.getString(TREE_KEY,null);if(raw!=null)scanAndSend(Uri.parse(raw),true);}
        @JavascriptInterface public void forgetMusicFolder(){scanGeneration++;String raw=prefs.getString(TREE_KEY,null);if(raw!=null)try{getContentResolver().releasePersistableUriPermission(Uri.parse(raw),Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);}catch(Exception ignored){} prefs.edit().remove(TREE_KEY).apply();audioUriMap.clear();sendFolderCleared();}
        @JavascriptInterface public void nativePlayQueue(String queueJson,int index,boolean repeatMode){Intent i=new Intent(MainActivity.this,PlaybackKeepAliveService.class).setAction(PlaybackKeepAliveService.ACTION_PLAY_QUEUE).putExtra("queue",queueJson).putExtra("index",index).putExtra("repeat",repeatMode);startService(i);}
        @JavascriptInterface public void nativePlay(){startService(new Intent(MainActivity.this,PlaybackKeepAliveService.class).setAction(PlaybackKeepAliveService.ACTION_PLAY));}
        @JavascriptInterface public void nativePause(){startService(new Intent(MainActivity.this,PlaybackKeepAliveService.class).setAction(PlaybackKeepAliveService.ACTION_PAUSE));}
        @JavascriptInterface public void nativeNext(){startService(new Intent(MainActivity.this,PlaybackKeepAliveService.class).setAction(PlaybackKeepAliveService.ACTION_NEXT));}
        @JavascriptInterface public void nativePrevious(){startService(new Intent(MainActivity.this,PlaybackKeepAliveService.class).setAction(PlaybackKeepAliveService.ACTION_PREVIOUS));}
        @JavascriptInterface public void nativeStop(){startService(new Intent(MainActivity.this,PlaybackKeepAliveService.class).setAction(PlaybackKeepAliveService.ACTION_STOP));}
        @JavascriptInterface public void nativeSeek(long positionMs){startService(new Intent(MainActivity.this,PlaybackKeepAliveService.class).setAction(PlaybackKeepAliveService.ACTION_SEEK).putExtra("position",positionMs));}
        @JavascriptInterface public void nativeSetRepeat(boolean value){startService(new Intent(MainActivity.this,PlaybackKeepAliveService.class).setAction(PlaybackKeepAliveService.ACTION_SET_REPEAT).putExtra("repeat",value));}

        /* ---- LUXE feature pack ---- */

        // Light tap feedback (kind 1) or a firmer press (kind 2).
        @JavascriptInterface public void haptic(int kind){
            runOnUiThread(() -> {
                try { webView.performHapticFeedback(kind == 2 ? HapticFeedbackConstants.LONG_PRESS : HapticFeedbackConstants.VIRTUAL_KEY); } catch (Exception ignored) {}
            });
        }

        // Speed, Slow Reverb, crossfade and per-song settings, sent as JSON by the web UI.
        @JavascriptInterface public void nativeSetEffects(String json){PlaybackKeepAliveService.setEffectsJson(json);}

        // Keeps the native queue in step after a song was renamed or removed.
        @JavascriptInterface public void nativeUpdateQueue(String queueJson,int index){PlaybackKeepAliveService.updateQueue(queueJson,index);}

        @JavascriptInterface public void renameSong(String id,String newBaseName){
            final String songId=id, base=newBaseName;
            fileWorker.execute(() -> doRename(songId, base, false));
        }

        @JavascriptInterface public void deleteSongs(String idsJson){
            final String ids=idsJson;
            fileWorker.execute(() -> doDelete(ids, false));
        }

        @JavascriptInterface public boolean hasAudioPermission(){
            return android.os.Build.VERSION.SDK_INT < 23 || checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface public void requestAudioPermission(){
            runOnUiThread(() -> { if (android.os.Build.VERSION.SDK_INT >= 23) requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_AUDIO_PERMISSION); });
        }

        @JavascriptInterface public void setVisualizer(boolean on){
            visualizerOpenInWeb = on;
            PlaybackKeepAliveService.visualizerSink = on ? visualizerSink : null;
            PlaybackKeepAliveService.setVisualizerEnabled(on);
        }

        @JavascriptInterface public void keepScreenOn(boolean on){
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface public double getSystemVolume(){
            try {
                AudioManager am=(AudioManager)getSystemService(Context.AUDIO_SERVICE);
                int max=am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                return max<=0 ? 0.5 : am.getStreamVolume(AudioManager.STREAM_MUSIC)/(double)max;
            } catch (Exception e) { return 0.5; }
        }

        @JavascriptInterface public void setSystemVolume(double value){
            try {
                AudioManager am=(AudioManager)getSystemService(Context.AUDIO_SERVICE);
                int max=am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                int level=(int)Math.round(Math.max(0d,Math.min(1d,value))*max);
                am.setStreamVolume(AudioManager.STREAM_MUSIC, level, 0);
            } catch (Exception ignored) {}
        }

        @JavascriptInterface public double getScreenBrightness(){
            try {
                float b=getWindow().getAttributes().screenBrightness;
                if (b>=0f) return b;
                return Settings.System.getInt(getContentResolver(), Settings.System.SCREEN_BRIGHTNESS)/255d;
            } catch (Exception e) { return 0.5; }
        }

        @JavascriptInterface public void setScreenBrightness(double value){
            final float level=(float)Math.max(0.02d,Math.min(1d,value));
            runOnUiThread(() -> {
                WindowManager.LayoutParams lp=getWindow().getAttributes();
                lp.screenBrightness=level;
                getWindow().setAttributes(lp);
            });
        }
    }

    /* =====================================================================
     * LUXE feature pack: rename and delete files in the music folder
     * ===================================================================== */

    private Uri savedTree() {
        String raw = prefs.getString(TREE_KEY, null);
        return raw == null ? null : Uri.parse(raw);
    }

    private boolean hasWriteGrant(Uri tree) {
        if (tree == null) return false;
        try {
            for (UriPermission permission : getContentResolver().getPersistedUriPermissions()) {
                if (tree.toString().equals(permission.getUri().toString()) && permission.isWritePermission()) return true;
            }
        } catch (Exception ignored) {}
        return false;
    }

    /** Asks the user to allow LUXE to edit files in the music folder, then runs op (or denied). */
    private void requestWriteAccess(Runnable op, Runnable denied) {
        runOnUiThread(() -> {
            pendingFileOp = op;
            pendingFileOpDenied = denied;
            try {
                Uri tree = savedTree();
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
                if (tree != null && android.os.Build.VERSION.SDK_INT >= 26) {
                    intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, tree);
                }
                sendNativeStatus("Choose your music folder again and allow LUXE to edit files in it.");
                startActivityForResult(intent, REQUEST_WRITE_ACCESS);
            } catch (Exception e) {
                Runnable fail = pendingFileOpDenied;
                pendingFileOp = null;
                pendingFileOpDenied = null;
                if (fail != null) fileWorker.execute(fail);
            }
        });
    }

    private void handleWriteAccessResult(int resultCode, Intent data) {
        Runnable ok = pendingFileOp;
        Runnable denied = pendingFileOpDenied;
        pendingFileOp = null;
        pendingFileOpDenied = null;
        boolean granted = false;
        if (resultCode == RESULT_OK && data != null && data.getData() != null) {
            Uri picked = data.getData();
            Uri saved = savedTree();
            try {
                getContentResolver().takePersistableUriPermission(picked,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (Exception e) {
                android.util.Log.w("LUXEMainActivity", "Could not persist edit access", e);
            }
            if (saved != null && picked.toString().equals(saved.toString())) {
                granted = hasWriteGrant(saved);
            } else {
                sendNativeError("Please choose the same music folder you selected before, so LUXE can edit files in it.");
            }
        }
        if (granted && ok != null) fileWorker.execute(ok);
        else if (denied != null) fileWorker.execute(denied);
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_AUDIO_PERMISSION) return;
        boolean granted = grantResults != null && grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        runJs("window.LUXEAndroid&&window.LUXEAndroid.onAudioPermission&&window.LUXEAndroid.onAudioPermission(" + granted + ");");
        if (granted && visualizerOpenInWeb) PlaybackKeepAliveService.setVisualizerEnabled(true);
    }

    /** Back closes panels and the player first; with nothing left to close LUXE goes to the background and the music keeps playing. */
    @Override public void onBackPressed() {
        if (webView == null || !pageReady) { moveTaskToBack(true); return; }
        webView.evaluateJavascript(
                "(function(){try{return !!(window.LuxeBack&&window.LuxeBack());}catch(e){return false;}})()",
                value -> { if (!"true".equals(value)) moveTaskToBack(true); });
    }

    @Override protected void onPause() {
        // No point capturing the spectrum while LUXE is not on screen; music keeps playing.
        if (visualizerOpenInWeb) PlaybackKeepAliveService.setVisualizerEnabled(false);
        super.onPause();
    }

    @Override protected void onResume() {
        super.onResume();
        if (visualizerOpenInWeb) PlaybackKeepAliveService.setVisualizerEnabled(true);
    }

    private String queryDisplayName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {}
        return null;
    }

    private String cleanFileName(String raw) {
        if (raw == null) return "";
        String name = raw.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", " ").replaceAll("\\s+", " ").trim();
        while (name.startsWith(".")) name = name.substring(1).trim();
        if (name.length() > 120) name = name.substring(0, 120).trim();
        return name;
    }

    private void doRename(String id, String baseName, boolean afterGrant) {
        Uri tree = savedTree();
        if (tree == null) { sendRenameFailed(id, "no-folder"); return; }
        if (!hasWriteGrant(tree)) {
            if (afterGrant) { sendRenameFailed(id, "permission"); return; }
            requestWriteAccess(() -> doRename(id, baseName, true), () -> sendRenameFailed(id, "permission"));
            return;
        }
        try {
            Uri oldUri = Uri.parse(id);
            String oldName = queryDisplayName(oldUri);
            String extension = "";
            if (oldName != null) {
                int dot = oldName.lastIndexOf('.');
                if (dot > 0) extension = oldName.substring(dot);
            }
            String clean = cleanFileName(baseName);
            if (clean.isEmpty()) { sendRenameFailed(id, "invalid-name"); return; }
            String newName = clean + extension;

            Uri newUri = oldUri;
            if (!newName.equals(oldName)) {
                Uri renamed = DocumentsContract.renameDocument(getContentResolver(), oldUri, newName);
                if (renamed == null) { sendRenameFailed(id, "rename-failed"); return; }
                // Keep the folder-based address form that the rest of LUXE uses.
                newUri = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getDocumentId(renamed));
            }

            String newId = newUri.toString();
            if (!newId.equals(id)) {
                audioUriMap.remove(token(id));
                audioUriMap.put(token(newId), newUri);
                File oldArt = artworkFile(id);
                File newArt = artworkFile(newId);
                if (oldArt != null && newArt != null && oldArt.isFile() && !newArt.exists()) oldArt.renameTo(newArt);
            }

            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("oldId", id);
            result.put("newId", newId);
            result.put("name", newName);
            result.put("url", "https://" + HOST + "/audio/" + token(newId));
            String art = cachedArtworkUrl(newId);
            result.put("artwork", art == null ? JSONObject.NULL : art);
            runJs("window.LUXEAndroid&&window.LUXEAndroid.onSongRenamed(" + JSONObject.quote(result.toString()) + ");");
        } catch (SecurityException e) {
            sendRenameFailed(id, "permission");
        } catch (Exception e) {
            android.util.Log.w("LUXEMainActivity", "Rename failed", e);
            sendRenameFailed(id, "rename-failed");
        }
    }

    private void sendRenameFailed(String id, String error) {
        try {
            JSONObject result = new JSONObject();
            result.put("ok", false);
            result.put("oldId", id);
            result.put("error", error);
            runJs("window.LUXEAndroid&&window.LUXEAndroid.onSongRenamed(" + JSONObject.quote(result.toString()) + ");");
        } catch (Exception ignored) {}
    }

    private void doDelete(String idsJson, boolean afterGrant) {
        final List<String> ids = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(idsJson);
            for (int i = 0; i < array.length(); i++) ids.add(array.getString(i));
        } catch (Exception e) { sendDeleteResult(new ArrayList<>(), ids, "error"); return; }
        if (ids.isEmpty()) return;

        Uri tree = savedTree();
        if (tree == null) { sendDeleteResult(new ArrayList<>(), ids, "no-folder"); return; }
        if (!hasWriteGrant(tree)) {
            if (afterGrant) { sendDeleteResult(new ArrayList<>(), ids, "permission"); return; }
            requestWriteAccess(() -> doDelete(idsJson, true), () -> sendDeleteResult(new ArrayList<>(), ids, "permission"));
            return;
        }

        List<String> deleted = new ArrayList<>();
        List<String> failed = new ArrayList<>();
        String failure = "delete-failed";
        for (String id : ids) {
            try {
                if (DocumentsContract.deleteDocument(getContentResolver(), Uri.parse(id))) {
                    deleted.add(id);
                    audioUriMap.remove(token(id));
                    File art = artworkFile(id);
                    if (art != null && art.isFile()) art.delete();
                } else {
                    failed.add(id);
                }
            } catch (SecurityException e) {
                failed.add(id);
                failure = "permission";
            } catch (Exception e) {
                android.util.Log.w("LUXEMainActivity", "Delete failed", e);
                failed.add(id);
            }
        }
        sendDeleteResult(deleted, failed, failure);
    }

    private void sendDeleteResult(List<String> deleted, List<String> failed, String error) {
        try {
            JSONObject result = new JSONObject();
            JSONArray ok = new JSONArray();
            for (String id : deleted) ok.put(id);
            JSONArray bad = new JSONArray();
            for (String id : failed) {
                JSONObject entry = new JSONObject();
                entry.put("id", id);
                entry.put("error", error);
                bad.put(entry);
            }
            result.put("deleted", ok);
            result.put("failed", bad);
            runJs("window.LUXEAndroid&&window.LUXEAndroid.onSongsDeleted(" + JSONObject.quote(result.toString()) + ");");
        } catch (Exception ignored) {}
    }

    private static class Entry { final Uri uri; final String name,mime; final long size,lastModified; Entry(Uri u,String n,String m,long s,long l){uri=u;name=n;mime=m;size=s;lastModified=l;} }

    @Override protected void onDestroy(){try{unregisterReceiver(playbackReceiver);}catch(Exception ignored){}PlaybackKeepAliveService.visualizerSink=null;PlaybackKeepAliveService.setVisualizerEnabled(false);scanner.shutdownNow();fileWorker.shutdownNow();if(webView!=null)webView.destroy();super.onDestroy();}
}
