# Second Brain — immersive backdrops

The visual Second Brain map has 4 themes. Each can use a real background so it feels like you're
actually there (space, sky, ocean, forest). Drop the files here and the map picks them up automatically.
No files = it falls back to the animated gradient, so nothing breaks.

## Where the files go (exact names)

Put a **video** (best) OR an **image** for each theme in this folder:

- `space.mp4`  (or `space.jpg`)
- `sky.mp4`    (or `sky.jpg`)
- `ocean.mp4`  (or `ocean.jpg`)
- `forest.mp4` (or `forest.jpg`)

Video wins if both exist. Size: 1920x1080 (16:9). Videos should be a few seconds and **loop
seamlessly** (they autoplay muted on a loop). Keep them fairly dark with lots of empty space so the
glowing nodes and labels stay readable on top.

## Prompts (generate in Higgsfield or your tool of choice)

**space.mp4** — Image: "Deep space nebula field, cinematic, endless dark cosmos, scattered distant
stars, faint purple and blue nebula clouds, high contrast, mostly black negative space, 16:9, no text."
Video motion: "very slow parallax drift through the stars, subtle twinkle, seamless 6s loop, no camera
shake."

**sky.mp4** — Image: "Flying through soft volumetric clouds at dusk, dreamy sky, gentle gradient of
deep blue to lavender to a touch of peach, moody and cinematic, dark enough for overlay text, 16:9,
no text." Video motion: "slow gentle glide forward through the clouds, calm, seamless 6s loop."

**ocean.mp4** — Image: "Deep underwater ocean scene, god rays of light from the surface far above,
floating plankton particles, deep teal fading to near-black in the depths, calm and vast, cinematic,
16:9, no text." Video motion: "slow drifting light rays and particles rising, tranquil, seamless 6s
loop."

**forest.mp4** — Image: "Deep misty forest at night, soft moonlight through tall dark trees, glowing
fireflies, deep green fading to black, magical and calm, cinematic, lots of dark negative space, 16:9,
no text." Video motion: "slow drift between the trees, fireflies gently floating, seamless 6s loop."

Tip: if you only make stills, name them `.jpg` and the map still gives you the parallax-on-zoom feel.
