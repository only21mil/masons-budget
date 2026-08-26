# Source Code Pro

The Android client bundles the official Google Fonts variable TrueType file and registers it in Compose at weights 300, 400, 500, 600, and 700. The app never fetches a font at runtime.

- Family: Source Code Pro
- Upstream: `google/fonts`, `ofl/sourcecodepro/SourceCodePro[wght].ttf`
- Upstream commit: `6a003b5eb672dc8bf5bff5937cf5863f8b175445`
- Local file: `app/src/main/res/font/source_code_pro_variable.ttf`
- SHA-256: `b400fc584e10aff25d0e775ce181b4fc1c5ea1b5dc37b81aeb2084375b945790`
- License: SIL Open Font License 1.1, bundled at `app/src/main/assets/licenses/SourceCodePro-OFL.txt`
- License SHA-256: `4a4a4179a96b5ef6786186d199f0d049b151352f460b8d2f3c00083792f37dd9`

`ui/theme/LedgerFoundation.kt` maps the single variable resource to `FontWeight.Light`, `Normal`, `Medium`, `SemiBold`, and `Bold`. This keeps one authoritative font binary while exposing every handoff weight.
