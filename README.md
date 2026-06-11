# Interactive Portrait

A landing-page portrait that turns to follow the cursor. The video never
plays — it's scrubbed frame-by-frame based on where your cursor is.

## Files

- `index.html` — the page (stage, portrait, calibration panel)
- `style.css` — styling (minimal for now; we'll design the real page together)
- `tracker.js` — all the logic, with a `CONFIG` block up top
- `FinalLoop_web.mp4` — your encoded loop (every frame a keyframe)

## Run it

Video scrubbing needs the files served over HTTP — opening `index.html`
directly with `file://` will fail to seek. Easiest options:

**VS Code Live Server** — install the "Live Server" extension, right-click
`index.html` → "Open with Live Server".

**Or terminal** — from this folder:

```bash
python3 -m http.server 8000
```

then open <http://localhost:8000>.

## How it works (the short version)

The clip is one continuous take:

```
idle(front) → [wake] → up → left → down → right → up → [settle] → front
```

So the timeline splits into three parts:

- `0 … circleStart` — **wake**: head lifts from front to "up"
- `circleStart … circleEnd` — **the circle**: this is the tracking loop
- `circleEnd … lastFrame` — **settle**: head lowers back to front

The cursor's *angle* around the anchor point picks a frame inside the
circle, so the face points toward the cursor. When you stop moving, it
settles back to the resting pose.

## Calibrating (press `C`)

The starting frame numbers are estimates — let's pin them exactly:

1. Press `C` to open the panel.
2. Drag **Manual scrub** until the head is looking straight **up**, note the
   frame, click **Set as circle start (up)**. Do the same near the end of the
   loop for **Set as circle end (up)**.
3. Scrub to the clean front pose and **Set as idle**.
4. Tick **Show anchor + cursor angle** and nudge `anchorX` / `anchorY` until
   the pink dot sits on the bridge of the nose.
5. Play with `smoothing` (snappiness), `idleTimeoutMs` (how soon it relaxes),
   and `deadzonePx` (dead area near the face).
6. If the head turns the *wrong way* around the circle, flip `direction` to -1.
7. **Copy config to clipboard** and paste the values into `CONFIG` in
   `tracker.js` so they stick.

## Things we'll do next together

- Crop/frame the head (there's a `transform: scale()` hook in the CSS)
- Optional crossfade across the loop seam for extra smoothness
- The actual landing-page design (type, layout, your real copy)
