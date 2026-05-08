## Catawiki LinkedIn GIF generator (static)

This is a **no-backend microsite**. Marketing can add 3–5 images, choose a category theme, and download a **GIF** suitable for posting on LinkedIn.

### Run it

- Open `microsite/index.html` in a browser (Chrome recommended).
- No build step required.

If your browser blocks `fetch()` for local files, serve the folder with any static server.
If you have Python:

```bash
cd microsite
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

### Customize category themes

Edit `microsite/config/categories.json`.

- **background**: base background color behind the image
- **accent / accent2**: used for the frame glow + gradient blobs
- **text**: used for the built-in category label

### Frame overlay

Default is a category-specific PNG overlay frame.

To use your own frames:

- Export one transparent PNG per category (same pixel size as the output).
- Put the PNGs in `microsite/assets/`
- Naming options:
  - Recommended (auto-detected): `Frame_<ACCENT_HEX>.png` (example: `Frame_1F6FFF.png`)
  - Also supported: `<ACCENT_HEX>.png`
  - Or set an explicit `frameFile` in `microsite/config/categories.json` for full control.

If a frame file can’t be found, the app falls back to the built-in “window” frame.

### Notes & limitations (intentional)

- GIFs are encoded with a **fixed 256-color palette** (3-3-2). This makes the encoding small and dependency-free, but very fine gradients may band slightly.
- For best quality, use high-contrast imagery and avoid ultra-subtle gradients in the uploaded frame.

