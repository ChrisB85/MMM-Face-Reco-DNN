# Face dataset admin web UI — design

Date: 2026-09-23
Status: approved in brainstorming, pending spec review

## Goal

Manage the face recognition dataset from a phone: add, rename and delete people,
take training photos with the mirror camera or the phone camera, delete bad photos,
and retrain the model — without SSH and without restarting MagicMirror.

Must be as light as possible and fully switchable off in the config.

## Decisions

| Topic | Decision |
|---|---|
| Photo source | Both: mirror camera (phone as remote) and phone camera upload |
| Access | LAN, protected by a PIN from the module config (HTTP Basic Auth) |
| Retraining | Manual "Retrain" button; UI shows "model out of date" when the dataset is newer than the model |
| Architecture | Inside the module: routes on MagicMirror's own Express server, no new service or port |
| Dependencies | None new (`express` comes with MagicMirror, `fetch` with Node 22) |

Rejected: a standalone Flask service (new port and unit, needs a side channel to tell
the module to reload the model); Home Assistant ingress (extra setup, HA dependency);
automatic retraining after every change (model changes while the user is still clicking).

## Configuration

```js
admin: {
  enabled: false,  // default off: no routes are registered
  pin: "",         // empty PIN keeps admin off and logs a warning
  cameraFrameUrl: "http://127.0.0.1:1984/api/frame.jpeg?src=c925e_face"
}
```

`admin.enabled !== true` or an empty `pin` means `node_helper.js` registers nothing.

### Dataset location (required when admin is enabled)

MagicMirror serves `/modules` (and `/config`) statically to the whole LAN. Today
`modules/MMM-Face-Reco-DNN/dataset/*.jpg` and `model/encodings.pickle` are readable
without any authentication, which would make the PIN pointless.

The existing `dataset` and `encodings` options must point outside every directory
MagicMirror serves, e.g. `/home/dietpi/face-reco/dataset/` and
`/home/dietpi/face-reco/encodings.pickle`. The helper refuses to enable admin (logs an
error) when either resolved path lies under a directory MagicMirror serves statically
(`config`, `css`, `fonts`, `js`, `modules`, `tests`, `translations`, `vendor`).
Migration on the mirror is a one-time `mv` plus a config change.

## Backend (`node_helper.js`)

Routes are registered on `this.expressApp` under `/MMM-Face-Reco-DNN/admin`, all behind
one Basic Auth middleware. The password is compared with `crypto.timingSafeEqual`;
the user name is ignored. A wrong or missing PIN returns 401 with
`WWW-Authenticate: Basic realm="Face admin"` so the browser shows its native prompt.

| Method | Path | Action |
|---|---|---|
| GET | `/` | `admin/admin.html` |
| GET | `/admin.js` | `admin/admin.js` |
| GET | `/api/people` | people with photo lists, `stale` flag, training state |
| POST | `/api/people/:name` | create person (empty directory) |
| PATCH | `/api/people/:name` | rename person, body `{ "name": "<new>" }` |
| DELETE | `/api/people/:name` | delete person directory with its photos |
| GET | `/api/frame` | proxy one JPEG frame from `cameraFrameUrl` |
| POST | `/api/people/:name/capture` | save one frame from `cameraFrameUrl` into the person directory |
| POST | `/api/people/:name/photos` | save uploaded JPEG (`express.raw({ type: "image/jpeg", limit: "5mb" })`) |
| GET | `/api/people/:name/photos/:file` | serve a photo |
| DELETE | `/api/people/:name/photos/:file` | delete a photo |
| POST | `/api/train` | start training (409 if already running) |

The page files live in `admin/`, not `public/`. They are also reachable without the PIN
through MagicMirror's static `/modules` route; that is fine because they hold no data or
secrets. Every API route requires the PIN.

Live preview polls `/api/frame` about twice a second instead of proxying the MJPEG
stream: less code, and nothing keeps streaming when the phone screen turns off.

### Input validation (trust boundary)

- Person name: `^[\p{L}\p{N}_-]{1,40}$` (Unicode letters, so Polish names work).
  The name is also the directory name, the name in `USERS_LOGIN` and the key used in
  `classes` of the mirror config.
- Photo file name: `^[\p{L}\p{N}_ ()-]{1,80}\.(jpe?g|png)$` (case-insensitive), so photos
  copied in by hand earlier stay visible and deletable. No `/`, `\` or `.` in the stem.
- Every resolved path is checked to stay inside the dataset directory.
- Anything else returns 400.

Saved photo names follow the `extendDataset` convention: `<name>_<YYYYmmdd_HHMMSS>.jpg`,
with a numeric suffix on collision.

### Training

1. Refuse with 400 when the dataset holds no photos at all.
2. Run `tools/encode.py -i <dataset> -e <encodings>.tmp -d <detectionMethod>` with
   `child_process.spawn` and the configured `pythonPath` (default `python3`).
3. On success `rename` the temporary file over `encodings` (atomic; a failed run keeps
   the old model), then kill `recognition.py` and start it again with `python_start`.
   Before the restart the helper sends a logout for everyone the old process had logged
   in: the new process never reports their logout, and logs back in whoever is still there.
4. On failure keep the old model and store the error.

Recognition keeps running while `encode.py` works (Pi 5, 4 cores). The training state
(`idle` / `running` / `done` / `error`, last message, skipped photos) lives in helper
memory; the page polls `/api/people` while a run is active.

`encode.py` gets one change: an image with a face count other than 1 is skipped and
reported on stdout as `[SKIP] <person>/<file>: <n> faces`; an unreadable image is
  reported as `[SKIP] <person>/<file>: unreadable` instead of crashing the run. `encode.py` assigns every face
in an image to the person, so a photo with two people would poison the model.
The helper collects these lines and the UI lists skipped photos with a delete button.
Validation happens at training time, so no Python process and no dlib load per photo.

Restart detail: `python_start` registers an `onExit` handler every time it runs; the
restart path must not stack handlers.

### `stale` flag

`stale = newest mtime of the dataset directory, person directories and photos > mtime
of the encodings file` (missing encodings file = stale). Deleting a photo or a person
changes the parent directory mtime, so deletions count too.

## Frontend (`admin/admin.html`, `admin/admin.js`)

Plain HTML and JavaScript, no framework, no build step, mobile first, Polish UI text.

- Top bar: "Model nieaktualny — Przeszkol" when `stale`; training progress and result.
- People list: name, photo count, first photo as thumbnail, "Dodaj osobę".
- Person view: camera preview with "Zrób zdjęcie", "Z telefonu" button, photo grid with
  delete, rename, delete person. Rename and delete show a note that `classes` in the
  mirror config refer to this name and must be changed by hand.
- Phone upload: `<input type="file" accept="image/*" capture="user">`; the browser
  decodes with `createImageBitmap` (applies EXIF orientation), scales to at most
  1280 px on the long side on a canvas and uploads JPEG. Full size phone photos would
  cost seconds per image in HOG and space on the SD card.

## Errors

| Case | Response |
|---|---|
| Wrong PIN | 401, native browser prompt |
| Invalid name or file | 400 |
| Person or photo not found | 404 |
| Person already exists | 409 |
| Camera frame unavailable | 502, message in UI |
| Training already running | 409 |
| Training failed | state `error` with the last output lines; old model stays |

## Testing

- `node:test` files for the pure functions (name validation, path containment, `stale`,
  PIN check), the trainer (with a fake Python script) and the routes (real Express on a
  random port, fake camera, fake trainer).
- Manual on the mirror: curl against every route (with and without PIN), then the full
  flow from a phone: add person, capture, upload, retrain, check `USERS_LOGIN` in
  `journalctl -u magicmirror`.
- Check that `admin.enabled: false` registers no routes (404 on `/MMM-Face-Reco-DNN/admin/`).

## Out of scope

- Assigning photos of unknown faces (`extendDataset` is off on the mirror).
- Editing `classes` in the mirror config from the UI.
- Access from outside the LAN.
- The wider exposure of `/config/config.js` over the LAN (separate issue).
