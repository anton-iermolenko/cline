# Cline / AI Local branding

The fork mark combines an open C-shaped workspace with joined paths and a forward arrow. It represents knowledge and evidence carried into action. The banner introduces the fork through memory, research and execution, rather than a context-capacity meter.

- `ai-local-mark.svg`: editable fork mark; `ai-local-mark.png` is its 1024 × 1024 raster export.
- `ai-local-banner.svg`: editable 1120 × 340 README banner; `ai-local-banner.png` is its 2240 × 680 raster export.
- The banner uses Arial/Helvetica with system sans-serif fallback. The standalone mark contains no font dependency.
- Regenerate PNG exports from the corresponding SVG after changing the artwork, and inspect both full-size and reduced previews.

The root README uses the banner. The local packaging helper copies that README, banner and settings screenshot into the VSIX during a build, then restores upstream source files. `local/release.json` owns the fork's display name and package description; a branding edit does not increment the version or create a release.

`cline-app-icon.*` and `logos/cline-*` retain the upstream Cline artwork. The new fork mark does not replace upstream assets or change extension identifiers, package names, or the installed application's icon.
