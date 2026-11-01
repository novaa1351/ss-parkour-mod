// ==UserScript==
// @name         Shell Shockers Parkour Mod
// @namespace    https://github.com/novaa1351/ss-parkour-mod
// @version      2.3.0
// @description  Runs private games entirely client-side (no game server) – lag-free parkour with a tick-accurate run timer.
// @match        https://shellshock.io/*
// @match        https://shellgame.me/*
// @homepageURL  https://github.com/novaa1351/ss-parkour-mod
// @supportURL   https://github.com/novaa1351/ss-parkour-mod/issues
// @updateURL    https://raw.githubusercontent.com/novaa1351/ss-parkour-mod/main/ss-parkour-mod.user.js
// @downloadURL  https://raw.githubusercontent.com/novaa1351/ss-parkour-mod/main/ss-parkour-mod.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * How it works
 * ------------
 * The engine ships a dev "map test" mode (?testMap&x&y&z&pitch&yaw) used by the
 * map editor. In that mode it never opens a game socket: the socket is a stub,
 * the map JSON + lightmap are read from localStorage, and your egg is created
 * and simulated locally (movement, jumping, ladders, jump pads are all
 * client-side physics anyway).
 *
 * This script:
 *  1. Adds "Offline private games" to Settings → More options. While it's on,
 *     Create Private Game reloads into test-map mode for the selected map
 *     instead of hitting the matchmaker.
 *  2. Offline page: serves `mapBackup` / `lightmap` straight from the real map
 *     files (no localStorage quota issues), and applies small, regex-guarded
 *     patches to the decrypted engine before it runs:
 *       - re-enable the egg hands (test mode hides them)
 *       - route test-mode respawns through this script (correct spawn height,
 *         un-pause the menu UI, start the run timer)
 *       - pointer lock falls back when unadjustedMovement is unsupported
 *         (Linux Chrome), otherwise the mouse is never captured
 *       - a hook on the 30 Hz physics tick, which drives the run timer
 *     Each patch is skipped (with a console warning) if a game update changes
 *     the code it targets; the core offline mode still works without them.
 *
 * Run timer
 * ---------
 * Replaces the best-streak counter. It counts physics ticks (30/s) from the
 * moment you click Play, so lag or FPS drops never change a time. The finish
 * is the top of the launch tube nearest the spatula (or touching the spatula
 * block on a map without one); the crossing is interpolated within the tick, so
 * finish times are accurate to the millisecond rather than to 33 ms.
 * Pausing (Esc / losing mouse capture) abandons the run; Play restarts it.
 *
 * Splits
 * ------
 * A LiveSplit-style panel (top left, under the timer) shows each segment's split,
 * the delta vs your PB (green ahead / red behind, gold = best segment ever) and
 * Sum of Best. Checkpoints are per-map zones in ROUTES – lane walls on Easy,
 * floors on Medium, the Blue Wizard coins on Hard – interpolated within the tick
 * like the finish. PB, best segments and attempts are saved per map in
 * localStorage. Runs from a practice spawn (F7) are labelled PRACTICE, never saved.
 *
 * Spawn facing
 * ------------
 * The engine randomizes yaw on every respawn; on the parkour maps you now spawn
 * facing the start of the course (practice spawns keep the facing you set them with).
 *
 * Controls (in game):
 *   Reset Run – back to the spawn with a fresh run, no pause. Default Backspace;
 *               rebind it in Settings → Keybindings.
 *   F6  – back to the map's real start (leaves practice)
 *   F7  – set a practice spawn where you're standing, facing where you're looking
 *   F8  – splits panel: compare against PB splits / best segments
 *   F9  – show / hide the splits panel
 */

(() => {
    'use strict';

    const TAG = '[SS Offline]';
    const PREF_ENABLED = 'ssoEnabled';
    const SETTING_ID = 'ssoOffline';
    const SETTING_LOC = 'sso_settings_offline';
    const SETTING_LABEL = 'Offline private games';
    const SPAWN_LIFT = 0.05;              // spawn markers are cells; the player's Y is its feet
    const TICK_MS = 1000 / 30;            // engine physics step (LR(): Zx += 33.333…)
    const EGG = { half: 0.25, height: 0.6 }; // OC.playerCollisionMesh: box size .5, height .6, from the feet
    const PREF_SPLITS = 'ssoShowSplits';
    const PREF_BEST_VIEW = 'ssoBestView';   // panel compares against best segments instead of PB
    const STORE_PREFIX = 'ssoSplits:';
    const RESET_ID = 'ssoReset';
    const RESET_LOC = 'sso_keybind_reset';
    const RESET_LABEL = 'Reset Run';
    const PREF_RESET_KEY = 'ssoResetKey';
    const DEFAULT_RESET_KEY = { code: 'Backspace', label: 'BACKSPACE' };

    // Split routes, keyed by map filename. Each split ends when the egg crosses its
    // zone: { plane: [axis, at] } – feet pass `at` going +axis (0=x, 1=y, 2=z) – or
    // { cell: [x, y, z] } – any part of the egg touches that block. The last
    // segment ends at the finish. `face` is the spawn yaw (0 = facing −z, π/2 = −x).
    // Maps without a route get one "Finish" segment and the engine's random facing.
    const ROUTES = {
        // Parkour - Easy: nine lanes along x, separated by blue walls at
        // z = 3, 8, 12, 16, 20, 24, 28, 32; a split is the far face of each wall.
        // Both spawns are at x = 16 and the course starts west, up the stairs at x = 12–13.
        parkour1: {
            face: Math.PI / 2,
            splits: [
                ['Blocks', { plane: [2, 4] }], ['Boxes', { plane: [2, 9] }],
                ['Invis', { plane: [2, 13] }], ['Bouncers', { plane: [2, 17] }],
                ['Walls', { plane: [2, 21] }], ['Ladders', { plane: [2, 25] }],
                ['Crates', { plane: [2, 29] }], ['Triple', { plane: [2, 33] }],
            ],
            last: 'End',
        },
        // Parkour - Medium: a tower with floor slabs at y = 4, 9, 12, 18, 22, 27; a
        // split is getting up onto the next slab. Spawns face the x = 6–7 corridor
        // (a wall at x = 5 blocks the other way).
        parkour2: {
            face: 0,
            splits: [
                ['Lucky Block', { plane: [1, 5] }], ['Aztec', { plane: [1, 10] }],
                ['Castle', { plane: [1, 13] }], ['Boxes', { plane: [1, 19] }],
                ['Crates', { plane: [1, 23] }], ['Ladders', { plane: [1, 28] }],
            ],
            last: 'End',
        },
        // Parkour - Hard: splits at the two Blue Wizard coins (scavenger.coin) on the
        // ground; the finish is the tetris-ringed tube above the pad at (6, 6, 7).
        // Spawns face the crate staircase (−z).
        parkour3: {
            face: 0,
            splits: [['no-clip', { cell: [3, 3, 0] }], ['Neo', { cell: [7, 3, 6] }]],
            last: 'shroom',
        },
    };

    const OFFLINE_CSS = `
        /* Timer replaces the best-streak counter. */
        #shellStreakContainer > :not(#ssoTimer) { display: none !important; }
        #ssoTimer { font-variant-numeric: tabular-nums; letter-spacing: .02em; white-space: nowrap; }
        #ssoTimer.sso-finished { color: #5dff7a !important; }
        /* Meaningless offline: team scores, and Chick'n Winner (test mode never
           moves it into #chw-game-screen, so it stays up from the home screen). */
        #teamScores, #chw-home, #chw-game-screen { display: none !important; }

        /* LiveSplit-style splits panel. */
        /* Top left, under the timer – where the player-list dropdown sits online.
           Hidden while the pause menu (which uses that corner) is open. */
        #ssoSplits {
            position: fixed; left: 15px; top: 52px; width: 270px; z-index: 50;
            background: linear-gradient(#2b2b2b, #0d0d0d); color: #fff;
            font: 600 15px/1.25 Nunito, "Segoe UI", sans-serif; font-variant-numeric: tabular-nums;
            border-radius: 6px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,.45);
            pointer-events: none; user-select: none;
        }
        #ssoSplits .sso-head { display: flex; justify-content: space-between; padding: 6px 10px; background: #1a1a1a; font-size: 14px; }
        #ssoSplits .sso-title { font-weight: 800; }
        #ssoSplits .sso-att { color: #aaa; }
        #ssoSplits .sso-mode { color: #d8af1f; font-size: 11px; letter-spacing: .04em; }
        #ssoSplits .sso-practice { padding: 3px 10px; background: #5a3d00; color: #ffd27a; font-size: 12px; }
        #ssoSplits .sso-row { display: grid; grid-template-columns: 1fr 72px 72px; padding: 3px 10px; border-top: 1px solid #1f1f1f; }
        #ssoSplits .sso-cur { background: linear-gradient(#3373f4, #153574); }
        #ssoSplits .sso-d, #ssoSplits .sso-t { text-align: right; }
        #ssoSplits .ahead-gain { color: #00cc36; }
        #ssoSplits .ahead-lose { color: #52cc73; }
        #ssoSplits .behind-gain { color: #cc5c52; }
        #ssoSplits .behind-lose { color: #cc1200; }
        #ssoSplits .gold { color: #d8af1f; }
        #ssoSplits .sso-foot { display: flex; justify-content: space-between; padding: 3px 10px; border-top: 1px solid #333; font-size: 14px; }
        #ssoSplits .sso-small { font-size: 11px; color: #888; }
        #ssoSplits .sso-reset { pointer-events: auto; cursor: pointer; text-decoration: underline; }
        body:has(.is-paused) #ssoSplits { display: none !important; }
    `;
    const params = new URLSearchParams(location.search);
    const IS_OFFLINE_PAGE = params.has('testMap') && params.has('sso');

    const pref = (k, def) => {
        try { const v = localStorage.getItem(k); return v === null ? def : v === '1'; } catch { return def; }
    };
    const setPref = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch {} };

    const whenReady = (test, cb, every = 100) => {
        const t = setInterval(() => { let ok = false; try { ok = test(); } catch {} if (ok) { clearInterval(t); cb(); } }, every);
    };

    const addStyle = (id, css) => {
        const s = document.createElement('style');
        s.id = id;
        s.textContent = css;
        (document.head || document.documentElement).appendChild(s);
    };

    let toastEl = null, toastTimer = 0;
    function toast(msg) {
        if (!document.body) return;
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;' +
                'background:rgba(0,0,0,.75);color:#fff;font:600 14px/1.3 sans-serif;padding:6px 12px;border-radius:6px;' +
                'pointer-events:none;transition:opacity .2s';
            document.body.appendChild(toastEl);
        }
        toastEl.textContent = msg;
        toastEl.style.opacity = '1';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 1800);
    }

    installSettingsToggle();
    if (IS_OFFLINE_PAGE) offlinePage(); else homePage();

    // ------------------------------------------------------- settings checkbox

    // Settings → More options renders vueData.settingsUi.togglers.misc; each entry
    // is {id, locKey, value} labelled by vueData.loc[locKey]. Save calls
    // extern.applyUiSettings(settingsUi, original); Cancel restores a deep clone.
    function installSettingsToggle() {
        whenReady(() => window.extern && typeof extern.applyUiSettings === 'function' && window.vueData && vueData.settingsUi, () => {
            const ensure = () => {
                const loc = vueData.loc;
                if (loc && loc[SETTING_LOC] !== SETTING_LABEL) loc[SETTING_LOC] = SETTING_LABEL;
                if (loc && loc[RESET_LOC] !== RESET_LABEL) loc[RESET_LOC] = RESET_LABEL;
                const ui = vueData.settingsUi;
                const misc = ui && ui.togglers && ui.togglers.misc;
                if (misc && !misc.some(e => e.id === SETTING_ID)) {
                    misc.push({ id: SETTING_ID, locKey: SETTING_LOC, value: pref(PREF_ENABLED, true) });
                }
                // Settings → Keybindings renders controls.keyboard.game; capturing a key
                // there unbinds it from anything else. The engine maps code → action and
                // ignores actions it doesn't know, so the offline page handles this one.
                const keys = ui && ui.controls && ui.controls.keyboard && ui.controls.keyboard.game;
                if (keys && !keys.some(e => e.id === RESET_ID)) {
                    keys.push({ id: RESET_ID, side: 'left', locKey: RESET_LOC, value: resetKey() });
                }
            };
            ensure();
            // settingsUi is replaced on Cancel and loc on language change – keep re-adding.
            setInterval(ensure, 1000);

            const origApply = extern.applyUiSettings;
            extern.applyUiSettings = function (settingsUi) {
                const entry = settingsUi && settingsUi.togglers && settingsUi.togglers.misc &&
                    settingsUi.togglers.misc.find(e => e.id === SETTING_ID);
                if (entry) setPref(PREF_ENABLED, !!entry.value);
                const key = settingsUi && settingsUi.controls && settingsUi.controls.keyboard &&
                    settingsUi.controls.keyboard.game.find(e => e.id === RESET_ID);
                if (key) { try { localStorage.setItem(PREF_RESET_KEY, JSON.stringify(key.value || null)); } catch {} }
                return origApply.apply(this, arguments);
            };
        });
    }

    // { code, label } or null when unbound.
    function resetKey() {
        try {
            const v = localStorage.getItem(PREF_RESET_KEY);
            return v === null ? DEFAULT_RESET_KEY : JSON.parse(v);
        } catch { return DEFAULT_RESET_KEY; }
    }

    // ---------------------------------------------------------------- home page

    function homePage() {
        whenReady(() => window.extern && typeof extern.play === 'function' && window.vueData && vueData.maps, () => {
            const origPlay = extern.play;
            extern.play = function (opts) {
                if (pref(PREF_ENABLED, true) && opts && opts.playType === vueData.playTypes.createPrivate) {
                    launchOffline(opts.mapIdx).catch(e => {
                        console.error(TAG, 'launch failed, falling back to online', e);
                        origPlay.apply(this, arguments);
                    });
                    return;
                }
                return origPlay.apply(this, arguments);
            };
            console.log(TAG, `ready – offline private games ${pref(PREF_ENABLED, true) ? 'ON' : 'OFF'} (Settings → More options)`);
        });
    }

    async function launchOffline(mapIdx) {
        const maps = vueData.maps;
        const map = maps[mapIdx] || maps[Math.floor(Math.random() * maps.length)];
        const json = await fetch(`maps/${map.filename}.json?${map.hash}`).then(r => r.json());

        const spawns = Object.keys(json.data)
            .filter(k => /^SPECIAL\.spawn/i.test(k))
            .flatMap(k => json.data[k]);
        const s = spawns.length
            ? spawns[Math.floor(Math.random() * spawns.length)]
            : { x: json.width / 2 | 0, y: json.height, z: json.depth / 2 | 0 };

        const q = new URLSearchParams({
            testMap: '1', sso: map.filename, ssoHash: map.hash,
            x: s.x, y: s.y, z: s.z, pitch: 0, yaw: 0,
        });
        location.assign(`${location.pathname}?${q}`);
    }

    // ------------------------------------------------------------- offline page

    function offlinePage() {
        const file = params.get('sso');
        const hash = params.get('ssoHash') || '';
        const mapUrl = `maps/${file}.json?${hash}`;
        const lightUrl = `maps/${file}.lightmap?${hash}`;

        // --- 1. Serve map data in place of localStorage -----------------------
        const cache = {};
        const toJsonArray = bytes => '[' + Array.prototype.join.call(bytes, ',') + ']';
        fetch(mapUrl).then(r => r.text()).then(t => { cache.mapBackup ??= t; }).catch(() => {});
        fetch(lightUrl).then(r => r.arrayBuffer()).then(b => { cache.lightmap ??= toJsonArray(new Uint8Array(b)); }).catch(() => {});

        // Sync fallback in case the engine asks before the prefetch lands.
        const syncGet = (url, binary) => {
            const x = new XMLHttpRequest();
            x.open('GET', url, false);
            if (binary) x.overrideMimeType('text/plain; charset=x-user-defined');
            x.send();
            if (x.status !== 200) throw new Error(`${TAG} ${url} -> ${x.status}`);
            if (!binary) return x.responseText;
            const s = x.responseText, out = new Uint8Array(s.length);
            for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
            return toJsonArray(out);
        };

        const origGetItem = Storage.prototype.getItem;
        Storage.prototype.getItem = function (key) {
            if (this === window.localStorage) {
                if (key === 'mapBackup') return cache.mapBackup ??= syncGet(mapUrl, false);
                if (key === 'lightmap') return cache.lightmap ??= syncGet(lightUrl, true);
            }
            return origGetItem.call(this, key);
        };

        // --- Spawn facing -----------------------------------------------------
        // Mouse look lives in the WASM. The engine copies window.get_yaw_pitch() into
        // the player every frame, and reset_yaw_pitch() (called on every respawn)
        // picks a random yaw. Wrap both: after a reset, offset the yaw so the engine
        // sees the facing we asked for; mouse movement then continues from there.
        // (The loader assigns these globals later, which lands in the setters.)
        const TAU = Math.PI * 2;
        const look = { get: null, reset: null, offset: 0, pending: null };
        function getYawPitch() {
            const r = look.get.apply(this, arguments);
            if (!look.offset) return r;
            // Kept in [0, 2π): the ladder check does Math.round(yaw / 90°) % 4.
            return { yaw: (((r.yaw + look.offset) % TAU) + TAU) % TAU, pitch: r.pitch, coords: r.coords };
        }
        function resetYawPitch() {
            look.reset.apply(this, arguments);
            look.offset = 0;
            if (look.pending !== null) {
                look.offset = look.pending - look.get().yaw;
                look.pending = null;
            }
        }
        Object.defineProperty(window, 'get_yaw_pitch', {
            configurable: true,
            get() { return look.get && getYawPitch; },
            set(fn) { look.get = fn; },
        });
        Object.defineProperty(window, 'reset_yaw_pitch', {
            configurable: true,
            get() { return look.reset && resetYawPitch; },
            set(fn) { look.reset = fn; },
        });

        // --- 2. Patch the decrypted engine before it executes -----------------
        // The WASM loader decrypts js/shellshock.js and runs it by assigning
        // script.textContent, so intercept that one assignment.
        const nodeTC = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
        Object.defineProperty(HTMLScriptElement.prototype, 'textContent', {
            configurable: true,
            enumerable: true,
            get() { return nodeTC.get.call(this); },
            set(v) {
                if (typeof v === 'string' && v.length > 1e6 && v.includes('mapBackup')) {
                    delete HTMLScriptElement.prototype.textContent;
                    try { v = patchEngine(v); } catch (e) { console.error(TAG, 'patching failed, running stock engine', e); }
                }
                nodeTC.set.call(this, v);
            },
        });

        // --- 3. Runtime helpers the patches call into ------------------------
        const sso = window.__sso = {
            posKeys: null,
            player: null,
            spawn: null,         // the engine's spawn object (lM); F7 edits it in place
            homeSpawn: null,     // the map's real start, for F6
            practice: false,     // spawned somewhere other than the real start
            practiceYaw: null,   // facing captured with the practice spawn
            finish: undefined,   // computed lazily from the map JSON
            route: undefined,    // { face, zones: [...], names: [...] }
            store: null,         // persisted PB / golds for this map
            run: null,           // { state: 'armed'|'running'|'finished', ticks, prev, time, splits, next, practice }

            spawnPos(s) { return [+s.x + 0.5, +s.y + SPAWN_LIFT, +s.z + 0.5]; },

            // Replaces `player.respawn(spawn.x+.5, spawn.y-.32, spawn.z+.5)` in test mode,
            // i.e. every Play click. Always starts a fresh run from the spawn point.
            respawn(player, spawn) {
                this.player = player;
                this.spawn = spawn;
                if (!this.homeSpawn) this.homeSpawn = { x: spawn.x, y: spawn.y, z: spawn.z };
                this.setup();
                look.pending = this.facing();
                player.respawn(...this.spawnPos(spawn));
                // The normal (server) respawn path clears the pause flag; test mode
                // doesn't, which left Quit/Profile/Inventory/Shop drawn over the game.
                try { window.vueApp && vueApp.setPause(false); } catch {}
                this.startRun();
            },

            // Replaces test mode's bare `canvas.requestPointerLock({unadjustedMovement})`.
            // Chrome on Linux rejects unadjustedMovement with NotSupportedError; the
            // normal Play path retries without it, test mode didn't, so the mouse
            // never got captured and game input stayed dead.
            lockPointer(opts) {
                const c = window.canvas || document.getElementById('canvas');
                if (!c) return;
                const plain = () => Promise.resolve().then(() => c.requestPointerLock());
                let p;
                try { p = Promise.resolve(c.requestPointerLock(opts)); } catch (e) { p = Promise.reject(e); }
                p.catch(e => {
                    if (e && e.name === 'NotSupportedError') return plain();
                    throw e;
                }).then(() => c.focus && c.focus()).catch(e => {
                    console.warn(TAG, 'pointer lock failed', e);
                    // Last resort: next click on the game captures the mouse.
                    toast('Click the game to capture the mouse');
                    c.addEventListener('click', () => { plain().catch(() => {}); }, { once: true });
                });
            },

            // Yaw to spawn with, or null for the engine's random one.
            facing() {
                if (this.practice) return this.practiceYaw;
                return this.route && this.route.face !== undefined ? this.route.face : null;
            },

            // Reset key / F6: back to the spawn with a fresh run, no pause needed.
            restart() {
                const p = this.player, s = this.spawn;
                if (!p || !s) return false;
                look.pending = this.facing();
                p.respawn(...this.spawnPos(s));
                this.startRun();
                return true;
            },

            // ---- run timer & splits ----

            setup() {
                if (this.route !== undefined) return;
                this.finish = computeFinish(cache.mapBackup);
                let mapName = file;
                try { mapName = JSON.parse(cache.mapBackup).name || file; } catch {}
                const def = ROUTES[file];
                this.route = def
                    ? { face: def.face, zones: def.splits.map(([, z]) => compileZone(z)), names: [...def.splits.map(s => s[0]), def.last] }
                    : { zones: [], names: ['Finish'] };
                this.mapName = mapName;
                this.store = loadStore(file, this.route.names);
            },

            startRun() {
                this.setup();
                // Plane splits already behind a practice spawn are skipped up front.
                const zones = this.route.zones, pos = this.spawn ? this.spawnPos(this.spawn) : null;
                let next = 0;
                while (pos && next < zones.length && zones[next].type === 'axis' && pos[zones[next].axis] >= zones[next].at) next++;
                this.run = {
                    state: 'armed', ticks: 0, prev: null, time: 0,
                    splits: new Array(next).fill(null), next, practice: this.practice,
                };
                if (!this.practice) { this.store.attempts++; saveStore(file, this.store); }
                this.renderTimer();
            },

            abandonRun() {
                if (this.run && this.run.state !== 'finished') {
                    this.run = null;
                    this.renderTimer();
                }
            },

            // Called at the start of every 30 Hz physics step, before players update,
            // so the position read here is the result of the previous step.
            tick() {
                const r = this.run, p = this.player, k = this.posKeys;
                if (!r || r.state === 'finished' || !p || !k) return;
                const cur = [+p[k[0]], +p[k[1]], +p[k[2]]];
                if (r.state === 'armed') {
                    // First step since Play: nothing has moved yet – this is t = 0.
                    r.state = 'running';
                    r.prev = cur;
                    return;
                }
                r.ticks++;
                const at = t => (r.ticks - 1 + t) * TICK_MS;

                // Checkpoints: the first remaining zone crossed this step counts, and any
                // before it are recorded as skipped (several can fall in one step).
                const zones = this.route.zones;
                for (let n = r.next; n < zones.length;) {
                    const t = crossing(zones[n], r.prev, cur);
                    if (t === null) { n++; continue; }
                    while (r.splits.length < n) r.splits.push(null);
                    this.recordSplit(at(t));
                    n = r.next;
                }

                const f = this.finish && crossing(this.finish, r.prev, cur);
                if (f !== null && f !== undefined) {
                    r.time = at(f);
                    while (r.splits.length < this.route.names.length - 1) r.splits.push(null);
                    this.recordSplit(r.time);
                    r.state = 'finished';
                    this.finishRun();
                } else {
                    r.time = r.ticks * TICK_MS;
                }
                r.prev = cur;
                this.renderTimer();
            },

            recordSplit(time) {
                const r = this.run, st = this.store, i = r.splits.length;
                const prev = i === 0 ? 0 : r.splits[i - 1];
                r.splits.push(time);
                r.next = Math.max(r.next, i + 1);
                // For the best-segments view: this run's segment time, and the best it was up against.
                const seg = prev === null ? null : time - prev;
                (r.segs = r.segs || [])[i] = seg;
                (r.prevBest = r.prevBest || [])[i] = st.best[i];
                if (r.practice || seg === null) return;   // segment not comparable
                if (st.best[i] === null || seg < st.best[i]) {
                    st.best[i] = seg;
                    r.golds = r.golds || {};
                    r.golds[i] = true;
                    saveStore(file, st);
                }
            },

            finishRun() {
                const r = this.run, st = this.store;
                const tag = r.practice ? ' (practice)' : '';
                console.log(TAG, `run finished${tag}: ${fmtTime(r.time)} (${r.ticks} ticks)`,
                    r.splits.map((t, i) => `${this.route.names[i]} ${t === null ? '-' : fmtSplit(t)}`).join(' | '));
                if (r.practice) { toast(`Practice – ${fmtTime(r.time)}`); return; }
                st.completed++;
                if (st.pb === null || r.time < st.pb[st.pb.length - 1]) {
                    const old = st.pb && st.pb[st.pb.length - 1];
                    st.pb = r.splits.slice();
                    toast(old ? `New PB! ${fmtTime(r.time)} (−${fmtSplit(old - r.time)})` : `First PB: ${fmtTime(r.time)}`);
                } else {
                    toast(`Finished – ${fmtTime(r.time)}`);
                }
                saveStore(file, st);
            },

            resetSplits() {
                this.setup();
                this.store = emptyStore(this.route.names);
                saveStore(file, this.store);
                this.renderSplits();
            },

            renderTimer() {
                const box = document.getElementById('shellStreakContainer');
                if (!box) return;
                if (!document.getElementById('ssoStyle')) addStyle('ssoStyle', OFFLINE_CSS);
                // The timer replaces the best-streak counter.
                let el = document.getElementById('ssoTimer');
                if (!el || el.parentNode !== box) {
                    el = el || document.createElement('span');
                    el.id = 'ssoTimer';
                    el.className = 'h1 text_yellow';
                    box.appendChild(el);
                }
                const r = this.run;
                el.textContent = fmtTime(r ? r.time : 0);
                el.classList.toggle('sso-finished', !!r && r.state === 'finished');
                this.renderSplits();
            },

            // LiveSplit-style panel: segment | delta vs PB | split time.
            renderSplits() {
                if (this.route === undefined) return;
                let el = document.getElementById('ssoSplits');
                if (!el) {
                    el = document.createElement('div');
                    el.id = 'ssoSplits';
                    el.addEventListener('click', e => {
                        if (e.target.classList.contains('sso-reset') && confirm(`Reset PB, best segments and attempts for ${this.mapName}?`)) this.resetSplits();
                    });
                    document.body.appendChild(el);
                }
                el.style.display = pref(PREF_SPLITS, true) ? '' : 'none';
                if (el.style.display) return;
                // Line up with the player-list dropdown, just below the timer row.
                const timer = document.getElementById('shellStreakContainer');
                const list = document.getElementById('playerList');
                const tb = timer && timer.getBoundingClientRect(), lb = list && list.getBoundingClientRect();
                if (tb && tb.height) el.style.top = Math.round(tb.bottom + 8) + 'px';
                if (lb && lb.width) el.style.left = Math.round(lb.left) + 'px';

                const r = this.run, st = this.store, names = this.route.names, pb = st.pb;
                const cur = r && r.state !== 'finished' ? r.splits.length : -1;
                const bestView = pref(PREF_BEST_VIEW, false);
                const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
                let rows = '';
                names.forEach((name, i) => {
                    let delta = '', time = '', cls = '';
                    const done = r && i < r.splits.length;
                    if (bestView) {
                        // Segment durations: this run's where done, otherwise your best.
                        if (done) {
                            const seg = r.segs ? r.segs[i] : null, was = r.prevBest ? r.prevBest[i] : null;
                            time = seg === null || seg === undefined ? '-' : fmtSplit(seg);
                            if (seg !== null && seg !== undefined && was !== null && was !== undefined) {
                                delta = fmtDelta(seg - was);
                                cls = seg < was ? 'gold' : 'behind-lose';
                            }
                            if (r.golds && r.golds[i]) cls = 'gold';
                        } else {
                            time = st.best[i] !== null ? fmtSplit(st.best[i]) : '-';
                            const start = i === 0 ? 0 : r && r.splits[i - 1];
                            if (i === cur && st.best[i] !== null && start !== null && start !== undefined && r.time - start > st.best[i]) {
                                delta = fmtDelta(r.time - start - st.best[i]);
                                cls = 'behind-lose';
                            }
                        }
                    } else if (done) {
                        const t = r.splits[i];
                        time = t === null ? '-' : fmtSplit(t);
                        if (t !== null && pb && pb[i] !== null) {
                            const d = t - pb[i];
                            const prevD = i > 0 && r.splits[i - 1] !== null && pb[i - 1] !== null ? r.splits[i - 1] - pb[i - 1] : 0;
                            const gaining = d < prevD;
                            cls = d < 0 ? (gaining ? 'ahead-gain' : 'ahead-lose') : (gaining ? 'behind-gain' : 'behind-lose');
                            delta = fmtDelta(d);
                        }
                        if (r.golds && r.golds[i]) cls = 'gold';
                    } else {
                        time = pb && pb[i] !== null ? fmtSplit(pb[i]) : '-';
                        // Live delta once the current segment is slower than the PB split.
                        if (i === cur && pb && pb[i] !== null && r.time > pb[i]) {
                            delta = fmtDelta(r.time - pb[i]);
                            cls = 'behind-lose';
                        }
                    }
                    rows += `<div class="sso-row${i === cur ? ' sso-cur' : ''}"><span class="sso-n">${esc(name)}</span>` +
                        `<span class="sso-d ${cls}">${delta}</span><span class="sso-t">${time}</span></div>`;
                });
                const sob = st.best.every(b => b !== null) ? fmtSplit(st.best.reduce((a, b) => a + b, 0)) : '-';
                el.innerHTML =
                    `<div class="sso-head"><span class="sso-title">${esc(this.mapName)}</span>` +
                    `<span class="sso-att">${bestView ? '<span class="sso-mode">BEST SEGS</span> ' : ''}${st.attempts}</span></div>` +
                    (r && r.practice ? '<div class="sso-practice">PRACTICE – F6 for real start</div>' : '') +
                    rows +
                    `<div class="sso-foot"><span>Sum of Best</span><span>${sob}</span></div>` +
                    `<div class="sso-foot"><span>Personal Best</span><span>${pb ? fmtSplit(pb[pb.length - 1]) : '-'}</span></div>` +
                    `<div class="sso-foot sso-small"><span>F8 ${bestView ? 'PB' : 'best segs'} · F9 hide · ${st.completed}/${st.attempts} finished</span><span class="sso-reset" title="Reset this map's splits">reset</span></div>`;
            },
        };

        // Losing mouse capture (Esc, alt-tab) abandons the run; Play starts a new one.
        document.addEventListener('pointerlockchange', () => {
            if (!document.pointerLockElement) sso.abandonRun();
        });

        // Draw 00:00.000 and the splits as soon as the game screen exists.
        whenReady(() => document.getElementById('shellStreakContainer') && cache.mapBackup, () => { sso.setup(); sso.renderTimer(); }, 250);

        whenReady(() => window.extern && typeof extern.leaveGame === 'function', () => {
            extern.leaveGame = () => location.assign(location.pathname);
        });

        // The reset key (Settings → Keybindings → Reset Run) works mid-run, while the
        // mouse is captured; a mouse button can be bound too ("MOUSE n").
        const tryReset = code => {
            const rk = resetKey();
            if (!rk || rk.code !== code || !document.pointerLockElement) return false;
            if (sso.restart()) toast(sso.practice ? 'Run restarted (practice spawn)' : 'Run restarted');
            return true;
        };
        window.addEventListener('mousedown', e => {
            if (tryReset('MOUSE ' + e.button)) { e.preventDefault(); e.stopPropagation(); }
        }, true);

        window.addEventListener('keydown', e => {
            if (e.repeat) return;
            const ae = document.activeElement;
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
            if (tryReset(e.code)) { e.preventDefault(); e.stopPropagation(); return; }
            if (!['F6', 'F7', 'F8', 'F9'].includes(e.key)) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'F9') {
                setPref(PREF_SPLITS, !pref(PREF_SPLITS, true));
                sso.renderSplits();
                return;
            }
            if (e.key === 'F8') {
                setPref(PREF_BEST_VIEW, !pref(PREF_BEST_VIEW, false));
                sso.renderSplits();
                toast(pref(PREF_BEST_VIEW, false) ? 'Splits: best segments' : 'Splits: PB');
                return;
            }
            const p = sso.player, k = sso.posKeys, s = sso.spawn;
            if (!p || !k || !s) { toast('Click Play first'); return; }
            if (e.key === 'F7') {
                s.x = p[k[0]] - 0.5; s.y = p[k[1]] - SPAWN_LIFT; s.z = p[k[2]] - 0.5;
                sso.practice = true;
                sso.practiceYaw = +p.mY;   // engine field for yaw (set from get_yaw_pitch each frame)
                const rk = resetKey();
                toast(`Practice spawn set here – ${rk ? rk.label : 'Reset Run'} to use it, F6 for the real start`);
                return;
            }
            // F6: back to the map's real start.
            Object.assign(s, sso.homeSpawn);
            sso.practice = false;
            sso.restart();
            toast('Back to the real start');
        }, true);

        console.log(TAG, `offline map: ${file}`);
    }

    // ---------------------------------------------------------------- splits

    function emptyStore(names) {
        return { names, attempts: 0, completed: 0, pb: null, best: names.map(() => null) };
    }

    // Persisted per map in localStorage. A route change (different segment
    // names) starts a fresh record rather than comparing against the wrong splits.
    function loadStore(file, names) {
        try {
            const st = JSON.parse(localStorage.getItem(STORE_PREFIX + file));
            if (st && JSON.stringify(st.names) === JSON.stringify(names)) return st;
        } catch {}
        return emptyStore(names);
    }

    function saveStore(file, st) {
        try { localStorage.setItem(STORE_PREFIX + file, JSON.stringify(st)); } catch {}
    }

    // ROUTES zone → the shape crossing() understands.
    function compileZone(z) {
        if (z.plane) return { type: 'axis', axis: z.plane[0], at: z.plane[1] };
        const [x, y, zz] = z.cell;   // touching the block = feet inside it grown by the egg's hitbox
        return { type: 'box', min: [x - EGG.half, y - EGG.height, zz - EGG.half], max: [x + 1 + EGG.half, y + 1, zz + 1 + EGG.half] };
    }

    function fmtSplit(ms) {
        const total = Math.round(ms);
        const m = Math.floor(total / 60000), s = Math.floor(total / 1000) % 60, milli = String(total % 1000).padStart(3, '0');
        return m ? `${m}:${String(s).padStart(2, '0')}.${milli}` : `${s}.${milli}`;
    }

    function fmtDelta(ms) {
        return (ms < 0 ? '−' : '+') + fmtSplit(Math.abs(ms));
    }

    // ---------------------------------------------------------------- finish

    // Finish line, in feet-position space:
    //  - 'plane': the rim of the launch tube above the jump pad nearest the
    //    spatula. Crossed when the top of the egg breaks through the rim inside
    //    the hole. (A pad launch peaks with the feet ~0.26 below the rim on
    //    Parkour Easy, so the whole egg never clears the tube.)
    //  - 'box': no tube near the spatula – touching the spatula's block with any
    //    part of the egg (block grown by the egg's hitbox).
    function computeFinish(mapText) {
        let json;
        try { json = JSON.parse(mapText); } catch { return null; }
        const data = json.data || {};
        const keyOf = re => Object.keys(data).find(k => re.test(k));
        const spKey = keyOf(/^SPECIAL\.spatula/i);
        const sp = spKey && data[spKey][0];
        if (!sp) { console.log(TAG, 'no spatula on this map – timer has no finish'); return null; }

        // "category.name.collider[.softness]" – collider "none" doesn't block players.
        const solid = new Set();
        for (const [k, cells] of Object.entries(data)) {
            const collider = k.split('.')[2];
            if (!collider || collider === 'none') continue;
            for (const c of cells) solid.add(`${c.x},${c.y},${c.z}`);
        }
        const isSolid = (x, y, z) => solid.has(`${x},${y},${z}`);
        const enclosed = (x, y, z) => !isSolid(x, y, z) &&
            [isSolid(x + 1, y, z), isSolid(x - 1, y, z), isSolid(x, y, z + 1), isSolid(x, y, z - 1)].filter(Boolean).length >= 3;

        const pads = Object.keys(data).filter(k => /jump-pad/i.test(k)).flatMap(k => data[k])
            // Within 6 blocks: Hard's tube (pad 6,6,7) is 5 from its spatula. Nearest
            // pad that actually forms a tube wins, so Easy/Medium are unaffected.
            .filter(p => Math.abs(p.x - sp.x) <= 6 && Math.abs(p.z - sp.z) <= 6 && p.y < sp.y && sp.y - p.y <= 16)
            .sort((a, b) => Math.hypot(a.x - sp.x, a.y - sp.y, a.z - sp.z) - Math.hypot(b.x - sp.x, b.y - sp.y, b.z - sp.z));

        for (const pad of pads) {
            let top = null;
            for (let y = pad.y + 1; y <= sp.y + 2; y++) {
                if (enclosed(pad.x, y, pad.z)) top = y;
                else if (top !== null) break;   // end of the first enclosed run
            }
            if (top !== null) {
                const f = { type: 'plane', y: top + 1 - EGG.height, x0: pad.x, x1: pad.x + 1, z0: pad.z, z1: pad.z + 1 };
                console.log(TAG, `finish: rim of launch tube at (${pad.x}, ${top + 1}, ${pad.z})`);
                return f;
            }
        }
        console.log(TAG, `finish: spatula block at (${sp.x}, ${sp.y}, ${sp.z})`);
        return {
            type: 'box',
            min: [sp.x - EGG.half, sp.y - EGG.height, sp.z - EGG.half],
            max: [sp.x + 1 + EGG.half, sp.y + 1, sp.z + 1 + EGG.half],
        };
    }

    // Fraction (0..1) along the step a→b at which the finish is crossed, or null.
    function crossing(f, a, b) {
        if (f.type === 'axis') {
            // `axis` passes `at` going positive.
            if (!(a[f.axis] < f.at && b[f.axis] >= f.at)) return null;
            return (f.at - a[f.axis]) / (b[f.axis] - a[f.axis]);
        }
        if (f.type === 'plane') {
            if (!(a[1] < f.y && b[1] >= f.y)) return null;
            const t = (f.y - a[1]) / (b[1] - a[1]);
            const x = a[0] + t * (b[0] - a[0]), z = a[2] + t * (b[2] - a[2]);
            return x >= f.x0 && x <= f.x1 && z >= f.z0 && z <= f.z1 ? t : null;
        }
        // Segment vs AABB (slab method); only entries from outside count.
        const inside = p => p.every((v, i) => v >= f.min[i] && v <= f.max[i]);
        if (inside(a)) return null;
        let t0 = 0, t1 = 1;
        for (let i = 0; i < 3; i++) {
            const d = b[i] - a[i];
            if (Math.abs(d) < 1e-12) {
                if (a[i] < f.min[i] || a[i] > f.max[i]) return null;
                continue;
            }
            let ta = (f.min[i] - a[i]) / d, tb = (f.max[i] - a[i]) / d;
            if (ta > tb) [ta, tb] = [tb, ta];
            t0 = Math.max(t0, ta);
            t1 = Math.min(t1, tb);
            if (t0 > t1) return null;
        }
        return t0;
    }

    function fmtTime(ms) {
        const total = Math.round(ms);
        const m = Math.floor(total / 60000), s = Math.floor(total / 1000) % 60, milli = total % 1000;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
    }

    // ---------------------------------------------------------------- patches

    function patchEngine(src) {
        const patch = (name, re, fn) => {
            const m = re.exec(src);
            if (!m) { console.warn(TAG, `patch "${name}" not applied – pattern not found (game updated?)`); return null; }
            src = src.slice(0, m.index) + fn(m) + src.slice(m.index + m[0].length);
            console.log(TAG, `patch "${name}" applied`);
            return m;
        };

        // Egg hands: `aM&&this.hands.setEnabled(!1)` → never hide.
        patch('hands', /[\w$]+&&this\.hands\.setEnabled\(!1\)/, () => '!1');

        // Player position field names, from Player.prototype.respawn(x,y,z){… this.UY=x,this.GY=y,this.JY=z,…}
        const pos = /prototype\.respawn=function\(([\w$]+),([\w$]+),([\w$]+)\)\{[\s\S]{0,400}?this\.([\w$]+)=\1,this\.([\w$]+)=\2,this\.([\w$]+)=\3,/.exec(src);
        if (pos) window.__sso.posKeys = [pos[4], pos[5], pos[6]];
        else console.warn(TAG, 'player position fields not found – timer/F7 disabled');

        // Test-mode respawn: `SN.VY=!0,SN.respawn(lM.x+.5,lM.y-.32,lM.z+.5)` → route through __sso.
        patch('respawn',
            /([\w$]+)\.([\w$]+)=!0,\1\.respawn\(([\w$]+)\.x\+\.5,\3\.y-\.32,\3\.z\+\.5\)/,
            m => `${m[1]}.${m[2]}=!0,window.__sso.respawn(${m[1]},${m[3]})`);

        // Test-mode pointer lock has no NotSupportedError fallback (breaks on Linux Chrome).
        patch('pointerLock',
            /void canvas\.requestPointerLock\((\{unadjustedMovement:[\w$.]+\})\)/,
            m => `void window.__sso.lockPointer(${m[1]})`);

        // Physics loop: `for(…;Zx<e;){if(Zx+=33.333333333333336,hM)…` → call __sso.tick() each step.
        patch('tick',
            /([\w$]+)\+=33\.333333333333336,/,
            m => `${m[0]}window.__sso.tick(),`);

        return src;
    }
})();
