# Source Code Pro

The Android client bundles the official static Source Code Pro TrueType files, one per handoff weight, and registers each in Compose. The app never fetches a font at runtime.

- Family: Source Code Pro
- Source: `Design/fonts/source-code-pro/` in this repository, pinned by `Design/assets.sha256`
- Local files: `app/src/main/res/font/source_code_pro_{light,regular,medium,semibold,bold}.ttf`
- SHA-256: identical to the `Design/fonts/source-code-pro/SourceCodePro-{Light,Regular,Medium,Semibold,Bold}.ttf` entries in `Design/assets.sha256`
- License: SIL Open Font License 1.1, bundled at `app/src/main/assets/licenses/SourceCodePro-OFL.txt`
- License SHA-256: `4a4a4179a96b5ef6786186d199f0d049b151352f460b8d2f3c00083792f37dd9`

`ui/theme/LedgerFoundation.kt` maps `FontWeight.Light`, `Normal`, `Medium`, `SemiBold`, and `Bold` to the matching file. The variable file was retired on 2026-09-05: its default instance is weight 200, and a weight axis that fails to apply at runtime renders every string as a hairline, which is what the Fold showed.
