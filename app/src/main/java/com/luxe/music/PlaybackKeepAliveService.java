package com.luxe.music;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadataRetriever;
import android.media.MediaPlayer;
import android.media.MediaMetadata;
import android.media.PlaybackParams;
import android.media.audiofx.EnvironmentalReverb;
import android.media.audiofx.PresetReverb;
import android.media.audiofx.Visualizer;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

public class PlaybackKeepAliveService extends Service {

    private static final String TAG = "LUXEPlaybackService";

    private static final String CHANNEL_ID = "luxe_music_playback";
    private static final int NOTIFICATION_ID = 1201;

    public static final String ACTION_STATE = "com.luxe.music.PLAYBACK_STATE";
    private static final String ACTION_REQUEST_STATE = "com.luxe.music.REQUEST_PLAYBACK_STATE";

    public static void requestState(Context context) {
        Intent intent = new Intent(context, PlaybackKeepAliveService.class);
        intent.setAction(ACTION_REQUEST_STATE);
        context.startService(intent);
    }

    public static final String ACTION_PLAY_QUEUE = "PLAY_QUEUE";
    public static final String ACTION_PLAY = "PLAY";
    public static final String ACTION_PAUSE = "PAUSE";
    public static final String ACTION_NEXT = "NEXT";
    public static final String ACTION_PREVIOUS = "PREVIOUS";
    public static final String ACTION_SEEK = "SEEK";
    public static final String ACTION_SET_REPEAT = "SET_REPEAT";
    public static final String ACTION_STOP = "STOP";

    private static final String ACTION_NOTIFICATION_PLAY =
            "com.luxe.music.NOTIFICATION_PLAY";
    private static final String ACTION_NOTIFICATION_PAUSE =
            "com.luxe.music.NOTIFICATION_PAUSE";
    private static final String ACTION_NOTIFICATION_NEXT =
            "com.luxe.music.NOTIFICATION_NEXT";
    private static final String ACTION_NOTIFICATION_PREVIOUS =
            "com.luxe.music.NOTIFICATION_PREVIOUS";

    private MediaPlayer player;
    private MediaSession mediaSession;
    private PowerManager.WakeLock wakeLock;
    private Bitmap currentArtwork;
    private final ExecutorService artworkExecutor = Executors.newSingleThreadExecutor();

    private final Handler handler = new Handler(Looper.getMainLooper());

    private final List<Track> queue = new ArrayList<>();

    private int currentIndex = -1;
    private int repeatMode = 0;

    private boolean isPreparing = false;
    private boolean serviceDestroyed = false;

    private String currentTitle = "LUXE Music";
    private String currentArtist = "Unknown Artist";
    private String currentAlbum = "Local Music";

    /*
     * IMPORTANT:
     * Use an anonymous Runnable so it can reschedule itself with "this".
     * This avoids the Java self-reference-in-initializer compilation error.
     */
    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            publishState();

            if (player != null && player.isPlaying()) {
                handler.postDelayed(this, 1000);
            }
        }
    };

    private static class Track {
        String id;
        String title;
        String artist;
        String album;
        String url;

        Track(
                String id,
                String title,
                String artist,
                String album,
                String url
        ) {
            this.id = id;
            this.title = title;
            this.artist = artist;
            this.album = album;
            this.url = url;
        }
    }

    /* =====================================================================
     * LUXE FEATURE PACK: playback speed, slow + reverb, crossfade, visualizer
     * ===================================================================== */

    /** Receives 32 spectrum levels (0-100) about 20 times a second while the visualizer is open. */
    public interface VisualizerSink {
        void onFrame(int[] levels);
    }

    public static volatile VisualizerSink visualizerSink;
    private static volatile PlaybackKeepAliveService instance;
    private static volatile String latestEffectsJson = null;
    private static volatile boolean visualizerRequested = false;

    /** Called by the activity (any thread) whenever the web UI changes an audio setting. */
    public static void setEffectsJson(String json) {
        latestEffectsJson = json;
        final PlaybackKeepAliveService s = instance;
        if (s != null) s.handler.post(s::onEffectsChanged);
    }

    /** Called by the activity after a song was renamed or removed, so the queue keeps valid ids. */
    public static void updateQueue(final String json, final int index) {
        final PlaybackKeepAliveService s = instance;
        if (s == null || json == null) return;
        s.handler.post(() -> {
            if (s.queue.isEmpty()) return;
            s.parseQueue(json);
            if (index >= 0 && index < s.queue.size()) s.currentIndex = index;
            else if (s.currentIndex >= s.queue.size()) s.currentIndex = s.queue.size() - 1;
        });
    }

    /** Turns the visualizer capture on or off (needs the RECORD_AUDIO permission to deliver data). */
    public static void setVisualizerEnabled(final boolean on) {
        visualizerRequested = on;
        final PlaybackKeepAliveService s = instance;
        if (s != null) s.handler.post(() -> s.setVisualizerWanted(on));
    }

    private static class Fx {
        float speed = 1f;      // Playback Speed: tempo only, pitch unchanged
        boolean slowOn = false; // Slow Reverb switch
        float rate = 1f;       // Slow Reverb rate: tempo and pitch together, like a slowed record
        int reverb = 0;        // 0-100 wet amount
        int room = 50;         // 0-100 room size
    }

    private Fx globalFx = new Fx();
    private final Map<String, Fx> songFx = new HashMap<>();
    private int crossfadeMs = 0;

    private float appliedTempo = 1f;
    private float appliedPitch = 1f;
    private boolean paramsDirty = false;

    private EnvironmentalReverb envReverb;
    private PresetReverb presetReverb;
    private boolean reverbTried = false;

    private MediaPlayer fadeOutPlayer;
    private Runnable fadeRunnable;

    private Visualizer visualizer;
    private boolean vizWanted = false;
    private int[] vizEdges;

    private static float clampF(double value, double min, double max) {
        return (float) Math.max(min, Math.min(max, value));
    }

    private static Fx readFx(JSONObject o) {
        Fx fx = new Fx();
        fx.speed = clampF(o.optDouble("speed", 1.0), 0.5, 2.0);
        JSONObject slow = o.optJSONObject("slow");
        if (slow != null) {
            fx.slowOn = slow.optBoolean("on", false);
            fx.rate = clampF(slow.optDouble("rate", 1.0), 0.5, 1.5);
            fx.reverb = (int) clampF(slow.optInt("reverb", 0), 0, 100);
            fx.room = (int) clampF(slow.optInt("room", 50), 0, 100);
        }
        return fx;
    }

    private void parseEffects(String json) {
        try {
            JSONObject root = new JSONObject(json);
            Fx global = readFx(root);
            Map<String, Fx> perSong = new HashMap<>();
            JSONObject songs = root.optJSONObject("songs");
            if (songs != null) {
                Iterator<String> keys = songs.keys();
                while (keys.hasNext()) {
                    String id = keys.next();
                    JSONObject entry = songs.optJSONObject(id);
                    if (entry != null) perSong.put(id, readFx(entry));
                }
            }
            globalFx = global;
            songFx.clear();
            songFx.putAll(perSong);
            crossfadeMs = (int) clampF(root.optInt("crossfadeMs", 0), 0, 12000);
        } catch (Exception e) {
            Log.w(TAG, "Unable to read audio effect settings", e);
        }
    }

    private Fx effectiveFx(Track track) {
        Fx fx = track == null ? null : songFx.get(track.id);
        return fx != null ? fx : globalFx;
    }

    private Track currentTrack() {
        return (currentIndex >= 0 && currentIndex < queue.size()) ? queue.get(currentIndex) : null;
    }

    /** The settings changed while the app is running. */
    private void onEffectsChanged() {
        String json = latestEffectsJson;
        if (json != null) parseEffects(json);

        if (player != null && !isPreparing) {
            Fx fx = effectiveFx(currentTrack());
            applyReverb(player, fx);
            try {
                if (player.isPlaying()) {
                    applyPlaybackParams(player, fx);
                } else {
                    // Changing the speed of a paused MediaPlayer would restart it,
                    // so the new speed is applied when playback resumes.
                    paramsDirty = true;
                }
            } catch (IllegalStateException e) {
                paramsDirty = true;
            }
        }
        scheduleFadeWatcher();
    }

    /** Speed and pitch. Only call this while playing, or right before start(). */
    private void applyPlaybackParams(MediaPlayer mp, Fx fx) {
        if (mp == null) return;
        float tempo = clampF(fx.speed * (fx.slowOn ? fx.rate : 1f), 0.25, 3.0);
        float pitch = fx.slowOn ? clampF(fx.rate, 0.5, 1.5) : 1f;
        if (Math.abs(tempo - appliedTempo) < 0.001f && Math.abs(pitch - appliedPitch) < 0.001f) {
            paramsDirty = false;
            return;
        }
        try {
            PlaybackParams params = new PlaybackParams();
            params.setSpeed(tempo);
            params.setPitch(pitch);
            mp.setPlaybackParams(params);
            appliedTempo = tempo;
            appliedPitch = pitch;
            paramsDirty = false;
        } catch (Exception e) {
            Log.w(TAG, "Playback speed/pitch is not supported for this file", e);
        }
    }

    private void ensureReverb() {
        if (reverbTried) return;
        reverbTried = true;
        try {
            envReverb = new EnvironmentalReverb(0, 0);
            envReverb.setEnabled(true);
        } catch (Throwable t) {
            envReverb = null;
            Log.w(TAG, "EnvironmentalReverb is not available on this phone", t);
        }
        if (envReverb == null) {
            try {
                presetReverb = new PresetReverb(0, 0);
                presetReverb.setEnabled(true);
            } catch (Throwable t) {
                presetReverb = null;
                Log.w(TAG, "PresetReverb is not available on this phone", t);
            }
        }
    }

    /** Reverb is an auxiliary effect: attach it to the player and set how much of the song goes to it. */
    private void applyReverb(MediaPlayer mp, Fx fx) {
        if (mp == null) return;
        float amount = fx.slowOn ? Math.max(0, Math.min(100, fx.reverb)) / 100f : 0f;
        int room = Math.max(0, Math.min(100, fx.room));
        try {
            if (amount <= 0.001f) {
                if (reverbTried) mp.setAuxEffectSendLevel(0f);
                return;
            }
            ensureReverb();
            if (envReverb != null) {
                envReverb.setDecayTime(700 + room * 70);          // 0.7 s to 7.7 s
                envReverb.setDecayHFRatio((short) 700);
                envReverb.setDensity((short) 1000);
                envReverb.setDiffusion((short) 1000);
                envReverb.setReverbDelay(30 + room / 3);           // ms
                envReverb.setReverbLevel((short) 0);
                envReverb.setReflectionsLevel((short) -800);
                envReverb.setReflectionsDelay(10 + room / 4);      // ms
                envReverb.setRoomLevel((short) -600);
                envReverb.setRoomHFLevel((short) -300);
                mp.attachAuxEffect(envReverb.getId());
            } else if (presetReverb != null) {
                short preset = room < 25 ? PresetReverb.PRESET_SMALLROOM
                        : room < 45 ? PresetReverb.PRESET_MEDIUMROOM
                        : room < 65 ? PresetReverb.PRESET_LARGEROOM
                        : room < 85 ? PresetReverb.PRESET_MEDIUMHALL
                        : PresetReverb.PRESET_LARGEHALL;
                presetReverb.setPreset(preset);
                mp.attachAuxEffect(presetReverb.getId());
            } else {
                return;
            }
            mp.setAuxEffectSendLevel(amount);
        } catch (Throwable t) {
            Log.w(TAG, "Unable to apply reverb", t);
        }
    }

    private void releaseReverb() {
        try { if (envReverb != null) envReverb.release(); } catch (Throwable ignored) { }
        try { if (presetReverb != null) presetReverb.release(); } catch (Throwable ignored) { }
        envReverb = null;
        presetReverb = null;
        reverbTried = false;
    }

    /* ------------------- Audio focus and headphones ------------------- */

    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private boolean resumeOnFocusGain = false;
    private boolean ducked = false;

    private float baseVolume() {
        return ducked ? 0.25f : 1f;
    }

    private void applyBaseVolume() {
        if (player == null || fadeOutPlayer != null) return;
        try { player.setVolume(baseVolume(), baseVolume()); } catch (Exception ignored) { }
    }

    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> {
        switch (change) {
            case AudioManager.AUDIOFOCUS_GAIN:
                if (ducked) {
                    ducked = false;
                    applyBaseVolume();
                }
                if (resumeOnFocusGain) {
                    resumeOnFocusGain = false;
                    resumePlayback();
                }
                break;
            case AudioManager.AUDIOFOCUS_LOSS:
                // Another music app took over: stop for good until the user presses play.
                resumeOnFocusGain = false;
                pausePlayback();
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                // A call or alarm: pause now, continue by itself afterwards.
                boolean wasPlaying = false;
                try { wasPlaying = player != null && player.isPlaying(); } catch (IllegalStateException ignored) { }
                if (wasPlaying) {
                    pausePlayback();
                    resumeOnFocusGain = true;
                }
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                // A notification sound: just turn the music down for a moment.
                ducked = true;
                applyBaseVolume();
                break;
            default:
                break;
        }
    };

    /** Asks Android for audio focus. Playback is never blocked by the answer; only later focus losses matter. */
    private void requestAudioFocus() {
        try {
            if (audioManager == null) audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (audioManager == null) return;
            if (Build.VERSION.SDK_INT >= 26) {
                if (focusRequest == null) {
                    focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                            .setAudioAttributes(new AudioAttributes.Builder()
                                    .setUsage(AudioAttributes.USAGE_MEDIA)
                                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                                    .build())
                            .setOnAudioFocusChangeListener(focusListener, handler)
                            .build();
                }
                audioManager.requestAudioFocus(focusRequest);
            } else {
                audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
            }
        } catch (Exception e) {
            Log.w(TAG, "Unable to request audio focus", e);
        }
    }

    private void abandonAudioFocus() {
        try {
            if (audioManager == null) return;
            if (Build.VERSION.SDK_INT >= 26) {
                if (focusRequest != null) audioManager.abandonAudioFocusRequest(focusRequest);
            } else {
                audioManager.abandonAudioFocus(focusListener);
            }
        } catch (Exception e) {
            Log.w(TAG, "Unable to abandon audio focus", e);
        }
        resumeOnFocusGain = false;
        ducked = false;
    }

    /** Headphones unplugged or Bluetooth disconnected: pause instead of blasting the speaker. */
    private final BroadcastReceiver noisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent != null && AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) {
                resumeOnFocusGain = false;
                pausePlayback();
            }
        }
    };
    private boolean noisyRegistered = false;

    /* ---------------------------- Crossfade ---------------------------- */

    private final Runnable fadeWatcher = new Runnable() {
        @Override
        public void run() {
            try {
                checkCrossfade();
            } catch (Exception e) {
                Log.w(TAG, "Crossfade check failed", e);
            }
            if (player != null && crossfadeMs > 0 && !serviceDestroyed) {
                handler.postDelayed(this, 200);
            }
        }
    };

    private void scheduleFadeWatcher() {
        handler.removeCallbacks(fadeWatcher);
        if (crossfadeMs > 0 && player != null) handler.postDelayed(fadeWatcher, 200);
    }

    private void checkCrossfade() {
        if (crossfadeMs <= 0 || player == null || isPreparing || fadeOutPlayer != null) return;
        if (repeatMode == 1 || queue.size() < 2) return;
        if (!player.isPlaying()) return;
        int duration = player.getDuration();
        int position = player.getCurrentPosition();
        if (duration <= 0) return;
        int fade = Math.min(crossfadeMs, duration / 3);
        if (fade < 500) return;
        float tempo = appliedTempo > 0.1f ? appliedTempo : 1f;
        // The next song needs a moment to open, so start slightly before the fade itself.
        float remainingMs = (duration - position) / tempo;
        if (remainingMs <= fade + 350) startCrossfade();
    }

    private void advanceIndex() {
        if (repeatMode == 2) {
            currentIndex = (int) (Math.random() * queue.size());
        } else {
            currentIndex++;
            if (currentIndex >= queue.size()) currentIndex = 0;
        }
    }

    /** Hands the playing song over to the fade-out slot so a new song can start on top of it. */
    private void handOffToFade() {
        MediaPlayer outgoing = player;
        if (outgoing == null) return;
        try {
            outgoing.setOnPreparedListener(null);
            outgoing.setOnCompletionListener(null);
            outgoing.setOnErrorListener(null);
        } catch (Exception ignored) { }
        fadeOutPlayer = outgoing;
        player = null;
        handler.removeCallbacks(ticker);
    }

    private boolean isPlayerPlaying() {
        try {
            return player != null && player.isPlaying();
        } catch (IllegalStateException e) {
            return false;
        }
    }

    /** Song ending on its own: start the next one a little early and fade between them. */
    private void startCrossfade() {
        if (player == null || queue.isEmpty()) return;
        handOffToFade();
        advanceIndex();
        playCurrentTrack(true);
    }

    /**
     * Starts the song at currentIndex. If crossfade is on and music is playing, the old song
     * fades out while the new one fades in (Next, Previous, tapping a song). Otherwise it is a
     * plain start, e.g. when paused, when nothing is playing, or during another fade.
     */
    private void switchTrack() {
        if (crossfadeMs > 0 && !isPreparing && fadeOutPlayer == null && isPlayerPlaying()) {
            handOffToFade();
            playCurrentTrack(true);
        } else {
            playCurrentTrack(false);
        }
    }

    /** Runs once the new song is playing at volume 0: fades the old one out and the new one in. */
    private void beginFade(final MediaPlayer incoming) {
        final MediaPlayer outgoing = fadeOutPlayer;
        if (outgoing == null) return;
        int remaining = 0;
        try {
            remaining = outgoing.getDuration() - outgoing.getCurrentPosition();
        } catch (Exception ignored) { }
        final int total = Math.max(400, Math.min(crossfadeMs, remaining > 0 ? remaining : crossfadeMs));
        final long startedAt = SystemClock.uptimeMillis();
        fadeRunnable = new Runnable() {
            @Override
            public void run() {
                float t = Math.min(1f, (SystemClock.uptimeMillis() - startedAt) / (float) total);
                // Equal-power curves keep the loudness steady through the crossfade.
                float up = (float) Math.sin(t * Math.PI / 2);
                float down = (float) Math.cos(t * Math.PI / 2);
                try { incoming.setVolume(up, up); } catch (Exception ignored) { }
                try { outgoing.setVolume(down, down); } catch (Exception ignored) { }
                if (t >= 1f) {
                    finishCrossfade();
                } else {
                    handler.postDelayed(this, 40);
                }
            }
        };
        handler.post(fadeRunnable);
    }

    /** Ends any crossfade right away: the old song is released, the current one is back at full volume. */
    private void finishCrossfade() {
        if (fadeRunnable != null) {
            handler.removeCallbacks(fadeRunnable);
            fadeRunnable = null;
        }
        MediaPlayer outgoing = fadeOutPlayer;
        fadeOutPlayer = null;
        if (outgoing != null) {
            try {
                outgoing.reset();
                outgoing.release();
            } catch (Exception e) {
                Log.w(TAG, "Error releasing faded-out player", e);
            }
        }
        if (player != null) {
            try { player.setVolume(baseVolume(), baseVolume()); } catch (Exception ignored) { }
        }
    }

    /* --------------------------- Visualizer --------------------------- */

    private void setVisualizerWanted(boolean on) {
        vizWanted = on;
        if (on) attachVisualizer(); else releaseVisualizer();
    }

    private void attachVisualizer() {
        releaseVisualizer();
        if (!vizWanted || player == null || isPreparing) return;
        if (Build.VERSION.SDK_INT >= 23
                && checkSelfPermission("android.permission.RECORD_AUDIO")
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            return; // the web UI falls back to a simple animation
        }
        try {
            Visualizer v = new Visualizer(player.getAudioSessionId());
            int[] range = Visualizer.getCaptureSizeRange();
            v.setCaptureSize(Math.max(range[0], Math.min(1024, range[1])));
            v.setDataCaptureListener(new Visualizer.OnDataCaptureListener() {
                @Override
                public void onWaveFormDataCapture(Visualizer vis, byte[] waveform, int samplingRate) {
                }

                @Override
                public void onFftDataCapture(Visualizer vis, byte[] fft, int samplingRate) {
                    emitSpectrum(fft);
                }
            }, Math.min(Visualizer.getMaxCaptureRate(), 20000), false, true);
            v.setEnabled(true);
            visualizer = v;
        } catch (Throwable t) {
            visualizer = null;
            Log.w(TAG, "Visualizer is not available", t);
        }
    }

    private void releaseVisualizer() {
        Visualizer v = visualizer;
        visualizer = null;
        if (v == null) return;
        try { v.setEnabled(false); } catch (Throwable ignored) { }
        try { v.release(); } catch (Throwable ignored) { }
    }

    /** Turns raw FFT data into 32 log-spaced bands, 0-100 each. */
    private void emitSpectrum(byte[] fft) {
        VisualizerSink sink = visualizerSink;
        if (sink == null || fft == null || fft.length < 8) return;
        int bins = fft.length / 2;
        if (vizEdges == null || vizEdges.length != 33 || vizEdges[32] != bins) {
            int[] edges = new int[33];
            for (int b = 0; b <= 32; b++) {
                edges[b] = Math.max(1, Math.min(bins - 1, (int) Math.pow(bins - 1, b / 32.0)));
            }
            edges[32] = bins;
            vizEdges = edges;
        }
        float[] mags = new float[bins];
        for (int k = 1; k < bins; k++) {
            float re = fft[2 * k];
            float im = fft[2 * k + 1];
            mags[k] = (float) Math.hypot(re, im);
        }
        int[] levels = new int[32];
        for (int b = 0; b < 32; b++) {
            int from = vizEdges[b];
            int to = Math.max(from + 1, vizEdges[b + 1]);
            float peak = 0f;
            for (int k = from; k < to && k < bins; k++) peak = Math.max(peak, mags[k]);
            float level = (float) Math.sqrt(Math.min(1f, peak / 110f));
            levels[b] = Math.max(0, Math.min(100, Math.round(level * 100f)));
        }
        sink.onFrame(levels);
    }

    @Override
    public void onCreate() {
        super.onCreate();

        instance = this;
        if (latestEffectsJson != null) parseEffects(latestEffectsJson);
        try {
            registerReceiver(noisyReceiver, new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY));
            noisyRegistered = true;
        } catch (Exception e) {
            Log.w(TAG, "Unable to watch for headphones being unplugged", e);
        }
        vizWanted = visualizerRequested;

        createNotificationChannel();
        initializeMediaSession();
        initializeWakeLock();

        Log.d(TAG, "Playback service created");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            return START_STICKY;
        }

        String action = intent.getAction();

        if (action == null) {
            return START_STICKY;
        }

        Log.d(TAG, "Received action: " + action);

        switch (action) {
            case ACTION_REQUEST_STATE:
                publishState();
                break;

            case ACTION_PLAY_QUEUE:
                handlePlayQueue(intent);
                break;

            case ACTION_PLAY:
            case ACTION_NOTIFICATION_PLAY:
                resumePlayback();
                break;

            case ACTION_PAUSE:
            case ACTION_NOTIFICATION_PAUSE:
                resumeOnFocusGain = false;
                pausePlayback();
                break;

            case ACTION_NEXT:
            case ACTION_NOTIFICATION_NEXT:
                playNext();
                break;

            case ACTION_PREVIOUS:
            case ACTION_NOTIFICATION_PREVIOUS:
                playPrevious();
                break;

            case ACTION_SEEK:
                seekTo(intent);
                break;

            case ACTION_SET_REPEAT:
                setRepeatMode(intent);
                break;

            case ACTION_STOP:
                stopPlayback();
                break;

            default:
                Log.w(TAG, "Unknown action: " + action);
                break;
        }

        return START_STICKY;
    }

    private void initializeMediaSession() {
        mediaSession = new MediaSession(this, "LUXE Music");

        mediaSession.setFlags(
                MediaSession.FLAG_HANDLES_MEDIA_BUTTONS
                        | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS
        );

        mediaSession.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                resumePlayback();
            }

            @Override
            public void onPause() {
                pausePlayback();
            }

            @Override
            public void onSkipToNext() {
                playNext();
            }

            @Override
            public void onSkipToPrevious() {
                playPrevious();
            }

            @Override
            public void onSeekTo(long position) {
                if (player != null) {
                    try {
                        player.seekTo((int) position);
                        publishState();
                    } catch (IllegalStateException e) {
                        Log.e(TAG, "Unable to seek", e);
                    }
                }
            }

            @Override
            public void onStop() {
                stopPlayback();
            }
        });

        mediaSession.setActive(true);
    }

    private void initializeWakeLock() {
        try {
            PowerManager powerManager =
                    (PowerManager) getSystemService(POWER_SERVICE);

            if (powerManager != null) {
                wakeLock = powerManager.newWakeLock(
                        PowerManager.PARTIAL_WAKE_LOCK,
                        "LUXEMusic:PlaybackWakeLock"
                );

                wakeLock.setReferenceCounted(false);
            }
        } catch (Exception e) {
            Log.e(TAG, "Unable to create wake lock", e);
        }
    }

    private void acquireWakeLock() {
        try {
            if (wakeLock != null && !wakeLock.isHeld()) {
                wakeLock.acquire();
            }
        } catch (Exception e) {
            Log.e(TAG, "Unable to acquire wake lock", e);
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Exception e) {
            Log.e(TAG, "Unable to release wake lock", e);
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "LUXE Music Playback",
                    NotificationManager.IMPORTANCE_LOW
            );

            channel.setDescription(
                    "Playback controls for LUXE Music"
            );

            channel.setShowBadge(false);

            NotificationManager manager =
                    getSystemService(NotificationManager.class);

            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private void handlePlayQueue(Intent intent) {
        String queueJson = intent.getStringExtra("queue");

        if (queueJson == null) {
            queueJson = intent.getStringExtra("songs");
        }

        int requestedIndex = intent.getIntExtra(
                "currentIndex",
                intent.getIntExtra("index", 0)
        );

        final String playingId = currentTrackId();

        if (queueJson != null) {
            parseQueue(queueJson);
        }

        if (queue.isEmpty()) {
            Log.w(TAG, "Cannot start playback: queue is empty");
            publishState();
            return;
        }

        if (requestedIndex < 0 || requestedIndex >= queue.size()) {
            requestedIndex = 0;
        }

        currentIndex = requestedIndex;

        // Restarting the very same song (e.g. after shuffling) is a plain restart, not a crossfade.
        boolean sameSong = playingId != null && !playingId.isEmpty()
                && playingId.equals(queue.get(currentIndex).id);
        if (sameSong) {
            playCurrentTrack(false);
        } else {
            switchTrack();
        }
    }

    private void parseQueue(String json) {
        queue.clear();

        try {
            JSONArray array = new JSONArray(json);

            for (int i = 0; i < array.length(); i++) {
                JSONObject object = array.getJSONObject(i);

                String id = object.optString("id", "");
                String title = object.optString(
                        "title",
                        "Unknown Title"
                );
                String artist = object.optString(
                        "artist",
                        "Unknown Artist"
                );
                String album = object.optString(
                        "album",
                        "Local Music"
                );
                String url = object.optString("url", "");

                queue.add(new Track(
                        id,
                        title,
                        artist,
                        album,
                        url
                ));
            }
        } catch (Exception e) {
            Log.e(TAG, "Unable to parse playback queue", e);
        }
    }

    private void playCurrentTrack() {
        playCurrentTrack(false);
    }

    /**
     * @param fadeIn true when this song starts while the previous one is still
     *               playing out (crossfade); the previous player is in fadeOutPlayer.
     */
    private void playCurrentTrack(final boolean fadeIn) {
        if (currentIndex < 0 || currentIndex >= queue.size()) {
            Log.w(TAG, "Invalid current track index");
            if (fadeIn) finishCrossfade();
            return;
        }

        final Track track = queue.get(currentIndex);

        if (currentArtwork != null && !currentArtwork.isRecycled()) {
            currentArtwork.recycle();
        }
        currentArtwork = null;
        loadArtworkInBackground(track);
        if (!fadeIn) finishCrossfade();
        releasePlayer();
        appliedTempo = 1f;
        appliedPitch = 1f;
        paramsDirty = false;

        currentTitle = track.title;
        currentArtist = track.artist;
        currentAlbum = track.album;

        isPreparing = true;
        acquireWakeLock();
        requestAudioFocus();

        try {
            // Promote the service immediately, before opening a provider URI.
            // This also avoids foreground-service start timeouts on newer Android.
            startForeground(NOTIFICATION_ID, buildNotification());
            player = new MediaPlayer();
            player.setOnSeekCompleteListener(mp -> publishState());

            player.setAudioAttributes(
                    new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(
                                    AudioAttributes.CONTENT_TYPE_MUSIC
                            )
                            .build()
            );

            /*
             * Android native playback must use the original content URI
             * when available. The WebView URL is only a fallback.
             */
            String source = track.id;

            if (source == null || source.isEmpty()) {
                source = track.url;
            }

            if (source == null || source.isEmpty()) {
                throw new IllegalArgumentException(
                        "No audio URI is available for this track"
                );
            }

            if (source.startsWith("content://")
                    || source.startsWith("file://")
                    || source.startsWith("android.resource://")) {

                player.setDataSource(
                        getApplicationContext(),
                        Uri.parse(source)
                );

            } else {
                player.setDataSource(source);
            }

            player.setOnPreparedListener(mediaPlayer -> {
                isPreparing = false;

                try {
                    // A song that fades in starts silent; set this before anything can start it.
                    boolean fading = fadeIn && fadeOutPlayer != null;
                    mediaPlayer.setVolume(fading ? 0f : baseVolume(), fading ? 0f : baseVolume());

                    // Per-song or global speed / pitch / reverb. Setting the speed of a
                    // prepared player also starts it, which is what happens next anyway.
                    Fx fx = effectiveFx(track);
                    applyReverb(mediaPlayer, fx);
                    applyPlaybackParams(mediaPlayer, fx);

                    mediaPlayer.start();
                    if (fading) beginFade(mediaPlayer);
                    attachVisualizer();
                    scheduleFadeWatcher();
                    updateMediaSessionMetadata();
                    updateMediaSessionPlaybackState();
                    showNotification();
                    scheduleTicker();
                    publishState();
                } catch (Exception e) {
                    Log.e(TAG, "Unable to start playback", e);
                    finishCrossfade();
                    releasePlayer();
                    publishState();
                }
            });

            player.setOnCompletionListener(mediaPlayer -> {
                if (repeatMode == 1) {
                    playCurrentTrack();
                } else {
                    playNext();
                }
            });

            player.setOnErrorListener((mediaPlayer, what, extra) -> {
                Log.e(
                        TAG,
                        "MediaPlayer error: what=" + what
                                + ", extra=" + extra
                );

                isPreparing = false;
                finishCrossfade();
                Log.e(TAG, "Playback failed for " + track.title + " (" + track.id + ")");
                publishState();
                return true;
            });

            player.prepareAsync();

            updateMediaSessionMetadata();
            updateMediaSessionPlaybackState();
            showNotification();
            publishState();

        } catch (Exception e) {
            Log.e(TAG, "Unable to prepare track", e);

            isPreparing = false;
            finishCrossfade();
            releasePlayer();
            publishState();
        }
    }

    private void resumePlayback() {
        if (player != null) {
            try {
                if (!player.isPlaying() && !isPreparing) {
                    // Speed changes made while paused are applied now, just before playing.
                    if (paramsDirty) applyPlaybackParams(player, effectiveFx(currentTrack()));
                    requestAudioFocus();
                    player.start();
                    acquireWakeLock();
                    scheduleTicker();
                    scheduleFadeWatcher();
                }

                updateMediaSessionPlaybackState();
                showNotification();
                publishState();
                return;

            } catch (IllegalStateException e) {
                Log.e(TAG, "Unable to resume playback", e);
            }
        }

        if (currentIndex >= 0 && currentIndex < queue.size()) {
            playCurrentTrack();
        }
    }

    private void pausePlayback() {
        // Pausing in the middle of a crossfade: keep only the new song, at full volume.
        finishCrossfade();

        if (player != null) {
            try {
                if (player.isPlaying()) {
                    player.pause();
                }
            } catch (IllegalStateException e) {
                Log.e(TAG, "Unable to pause playback", e);
            }
        }

        handler.removeCallbacks(ticker);

        releaseWakeLock();

        updateMediaSessionPlaybackState();
        showNotification();
        publishState();
    }

    private void playNext() {
        if (queue.isEmpty()) {
            return;
        }

        advanceIndex();

        switchTrack();
    }

    private void playPrevious() {
        if (queue.isEmpty()) {
            return;
        }

        finishCrossfade();

        if (player != null) {
            try {
                if (player.getCurrentPosition() > 3000) {
                    player.seekTo(0);
                    publishState();
                    return;
                }
            } catch (IllegalStateException ignored) {
            }
        }

        currentIndex--;

        if (currentIndex < 0) {
            currentIndex = queue.size() - 1;
        }

        switchTrack();
    }

    private void seekTo(Intent intent) {
        if (player == null) {
            return;
        }

        finishCrossfade();

        long requestedPosition = intent.getLongExtra(
                "position",
                intent.getLongExtra("seekTo", 0L)
        );
        int position = (int) Math.max(0L, Math.min(requestedPosition, Integer.MAX_VALUE));

        try {
            player.seekTo(Math.max(position, 0));
            publishState();
        } catch (IllegalStateException e) {
            Log.e(TAG, "Unable to seek", e);
        }
    }

    private void setRepeatMode(Intent intent) {
        repeatMode = intent.getIntExtra(
                "repeatMode",
                intent.getIntExtra("mode", 0)
        );

        if (repeatMode < 0 || repeatMode > 2) {
            repeatMode = 0;
        }

        publishState();
    }

    private void stopPlayback() {
        handler.removeCallbacks(ticker);

        finishCrossfade();
        releasePlayer();
        abandonAudioFocus();
        releaseWakeLock();

        currentIndex = -1;
        queue.clear();
        isPreparing = false;
        currentTitle = "LUXE Music";
        currentArtist = "Unknown Artist";
        currentAlbum = "Local Music";

        artworkExecutor.shutdownNow();
        if (currentArtwork != null && !currentArtwork.isRecycled()) {
            currentArtwork.recycle();
            currentArtwork = null;
        }
        if (mediaSession != null) {
            mediaSession.setActive(false);
        }

        stopForeground(true);
        stopSelf();

        publishState();
    }

    private void releasePlayer() {
        handler.removeCallbacks(ticker);
        handler.removeCallbacks(fadeWatcher);
        releaseVisualizer();

        if (player != null) {
            try {
                player.setOnPreparedListener(null);
                player.setOnCompletionListener(null);
                player.setOnErrorListener(null);
                player.reset();
                player.release();
            } catch (Exception e) {
                Log.e(TAG, "Error releasing player", e);
            }

            player = null;
        }

        isPreparing = false;
    }

    private void scheduleTicker() {
        handler.removeCallbacks(ticker);
        handler.post(ticker);
    }

    private void updateMediaSessionMetadata() {
        if (mediaSession == null) {
            return;
        }

        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
                .putString(
                        MediaMetadata.METADATA_KEY_TITLE,
                        currentTitle
                )
                .putString(
                        MediaMetadata.METADATA_KEY_ARTIST,
                        currentArtist
                )
                .putString(
                        MediaMetadata.METADATA_KEY_ALBUM,
                        currentAlbum
                );

        if (player != null) {
            try {
                if (player.getDuration() > 0) {
                    metadata.putLong(MediaMetadata.METADATA_KEY_DURATION, player.getDuration());
                }
            } catch (IllegalStateException ignored) {}
        }
        if (currentArtwork != null && !currentArtwork.isRecycled()) {
            metadata.putBitmap(MediaMetadata.METADATA_KEY_ART, currentArtwork);
            metadata.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, currentArtwork);
        }
        mediaSession.setMetadata(metadata.build());

    }

    private void loadArtworkInBackground(Track track) {
        final String trackId = track.id;
        artworkExecutor.execute(() -> {
            Bitmap found = null;
            MediaMetadataRetriever retriever = null;
            try {
                if (trackId != null && (trackId.startsWith("content://") || trackId.startsWith("file://"))) {
                    retriever = new MediaMetadataRetriever();
                    retriever.setDataSource(getApplicationContext(), Uri.parse(trackId));
                    byte[] bytes = retriever.getEmbeddedPicture();
                    if (bytes != null && bytes.length > 0) {
                        Bitmap decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                        if (decoded != null) {
                            int max = 512;
                            float scale = Math.min(1f, max / (float) Math.max(decoded.getWidth(), decoded.getHeight()));
                            if (scale < 1f) {
                                found = Bitmap.createScaledBitmap(decoded, Math.max(1, (int)(decoded.getWidth() * scale)), Math.max(1, (int)(decoded.getHeight() * scale)), true);
                                if (found != decoded) decoded.recycle();
                            } else found = decoded;
                        }
                    }
                }
            } catch (Exception e) {
                Log.d(TAG, "No embedded cover art for current track", e);
            } finally {
                if (retriever != null) try { retriever.release(); } catch (Exception ignored) {}
            }
            final Bitmap result = found;
            handler.post(() -> {
                if (serviceDestroyed || trackId == null || !trackId.equals(currentTrackId())) {
                    if (result != null && !result.isRecycled()) result.recycle();
                    return;
                }
                if (currentArtwork != null && !currentArtwork.isRecycled()) currentArtwork.recycle();
                currentArtwork = result;
                updateMediaSessionMetadata();
                showNotification();
            });
        });
    }

    private String currentTrackId() {
        return currentIndex >= 0 && currentIndex < queue.size() ? queue.get(currentIndex).id : null;
    }

    private void updateMediaSessionPlaybackState() {
        if (mediaSession == null) {
            return;
        }

        boolean playing = false;
        int position = 0;

        if (player != null) {
            try {
                playing = player.isPlaying();

                if (player.getCurrentPosition() >= 0) {
                    position = player.getCurrentPosition();
                }
            } catch (IllegalStateException ignored) {
            }
        }

        int state = playing
                ? PlaybackState.STATE_PLAYING
                : PlaybackState.STATE_PAUSED;

        PlaybackState playbackState =
                new PlaybackState.Builder()
                        .setActions(
                                PlaybackState.ACTION_PLAY
                                        | PlaybackState.ACTION_PAUSE
                                        | PlaybackState.ACTION_PLAY_PAUSE
                                        | PlaybackState.ACTION_SKIP_TO_NEXT
                                        | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                                        | PlaybackState.ACTION_SEEK_TO
                                        | PlaybackState.ACTION_STOP
                        )
                        .setState(
                                state,
                                position,
                                playing ? 1.0f : 0.0f
                        )
                        .build();

        mediaSession.setPlaybackState(playbackState);
    }

    private Notification buildNotification() {
        boolean playing = false;

        if (player != null) {
            try {
                playing = player.isPlaying();
            } catch (IllegalStateException ignored) {
            }
        }

        Intent openAppIntent = getPackageManager()
                .getLaunchIntentForPackage(getPackageName());

        PendingIntent contentPendingIntent = null;

        if (openAppIntent != null) {
            contentPendingIntent = PendingIntent.getActivity(
                    this,
                    100,
                    openAppIntent,
                    pendingIntentFlags()
            );
        }

        PendingIntent previousPendingIntent =
                createActionPendingIntent(
                        ACTION_NOTIFICATION_PREVIOUS,
                        101
                );

        PendingIntent playPausePendingIntent =
                createActionPendingIntent(
                        playing
                                ? ACTION_NOTIFICATION_PAUSE
                                : ACTION_NOTIFICATION_PLAY,
                        102
                );

        PendingIntent nextPendingIntent =
                createActionPendingIntent(
                        ACTION_NOTIFICATION_NEXT,
                        103
                );

        NotificationCompat.Builder builder =
                new NotificationCompat.Builder(this, CHANNEL_ID)
                        .setSmallIcon(android.R.drawable.ic_media_play)
                        .setContentTitle(
                                currentTitle == null
                                        ? "LUXE Music"
                                        : currentTitle
                        )
                        .setContentText(
                                currentArtist == null
                                        ? "Unknown Artist"
                                        : currentArtist
                        )
                        .setSubText("LUXE Music")
                        .setVisibility(
                                NotificationCompat.VISIBILITY_PUBLIC
                        )
                        .setOngoing(playing)
                        .setOnlyAlertOnce(true)
                        .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
                        .setPriority(NotificationCompat.PRIORITY_LOW)
                        .addAction(
                                android.R.drawable.ic_media_previous,
                                "Previous",
                                previousPendingIntent
                        )
                        .addAction(
                                playing
                                        ? android.R.drawable.ic_media_pause
                                        : android.R.drawable.ic_media_play,
                                playing ? "Pause" : "Play",
                                playPausePendingIntent
                        )
                        .addAction(
                                android.R.drawable.ic_media_next,
                                "Next",
                                nextPendingIntent
                        );

        if (contentPendingIntent != null) {
            builder.setContentIntent(contentPendingIntent);
        }
        if (currentArtwork != null && !currentArtwork.isRecycled()) {
            builder.setLargeIcon(currentArtwork);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP
                && mediaSession != null) {
            builder.setStyle(
                    new androidx.media.app.NotificationCompat.MediaStyle()
                            .setShowActionsInCompactView(0, 1, 2)
            );
        }

        return builder.build();
    }

    private PendingIntent createActionPendingIntent(
            String action,
            int requestCode
    ) {
        Intent intent = new Intent(this, PlaybackKeepAliveService.class);
        intent.setAction(action);

        return PendingIntent.getService(
                this,
                requestCode,
                intent,
                pendingIntentFlags()
        );
    }

    private int pendingIntentFlags() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            return PendingIntent.FLAG_UPDATE_CURRENT
                    | PendingIntent.FLAG_IMMUTABLE;
        }

        return PendingIntent.FLAG_UPDATE_CURRENT;
    }

    private void showNotification() {
        try {
            Notification notification = buildNotification();

            NotificationManager manager =
                    (NotificationManager) getSystemService(
                            NOTIFICATION_SERVICE
                    );

            if (manager != null) {
                manager.notify(NOTIFICATION_ID, notification);
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                        NOTIFICATION_ID,
                        notification
                );
            }
        } catch (Exception e) {
            Log.e(TAG, "Unable to update notification", e);
        }
    }

    private void publishState() {
        updateMediaSessionPlaybackState();

        Intent stateIntent = new Intent(
                ACTION_STATE
        );

        stateIntent.setPackage(getPackageName());

        boolean playing = false;
        int position = 0;
        int duration = 0;

        if (player != null) {
            try {
                playing = player.isPlaying();
                position = player.getCurrentPosition();
                duration = player.getDuration();
            } catch (IllegalStateException ignored) {
            }
        }

        stateIntent.putExtra("playing", playing);
        stateIntent.putExtra("isPlaying", playing);
        stateIntent.putExtra("position", (long) position);
        stateIntent.putExtra("duration", (long) duration);
        stateIntent.putExtra("currentIndex", currentIndex);
        stateIntent.putExtra("title", currentTitle);
        stateIntent.putExtra("artist", currentArtist);
        stateIntent.putExtra("album", currentAlbum);
        stateIntent.putExtra("repeatMode", repeatMode);
        stateIntent.putExtra("id", currentTrackId());
        stateIntent.putExtra("queueIndex", currentIndex);
        stateIntent.putExtra("queueSize", queue.size());

        sendBroadcast(stateIntent);
    }

    /*
     * Compatibility method for callers that update playback metadata.
     */
    public void updatePlayback(
            String title,
            String artist,
            boolean playing
    ) {
        currentTitle = title == null ? "LUXE Music" : title;
        currentArtist = artist == null ? "Unknown Artist" : artist;

        updateMediaSessionMetadata();
        updateMediaSessionPlaybackState();
        showNotification();
        publishState();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // When the user dismisses LUXE from Recents, stop playback completely.
        // This also removes the notification and deactivates the lock-screen session.
        stopPlayback();
        queue.clear();
        currentTitle = "LUXE Music";
        currentArtist = "Unknown Artist";
        currentAlbum = "Local Music";
        if (mediaSession != null) {
            try {
                mediaSession.setActive(false);
            } catch (Exception ignored) {
            }
        }
        stopForeground(true);
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        serviceDestroyed = true;
        if (instance == this) instance = null;

        handler.removeCallbacks(ticker);
        finishCrossfade();
        releasePlayer();
        releaseReverb();
        abandonAudioFocus();
        if (noisyRegistered) {
            try { unregisterReceiver(noisyReceiver); } catch (Exception ignored) { }
            noisyRegistered = false;
        }
        releaseWakeLock();

        artworkExecutor.shutdownNow();
        if (currentArtwork != null && !currentArtwork.isRecycled()) {
            currentArtwork.recycle();
            currentArtwork = null;
        }
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
        }

        super.onDestroy();

        Log.d(TAG, "Playback service destroyed");
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
